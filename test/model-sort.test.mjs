// 页面状态层的排序：setSort、停止旧的加载和旧的一轮刷新、cursor_expired、sortFallback、parseState。
import assert from 'node:assert/strict';
import test from 'node:test';
import { RESTORE_LIMIT, MAX_PARALLEL, parseState, putSession, trimState } from '../view/model.mjs';
import { visibleRows } from '../view/tree.mjs';
import { flush } from './support/fake.mjs';
import { entries, manual } from './support/page.mjs';

const names = (model, path = '') => model.dirs.get(path)?.entries.map(e => e.name);
const many = (count, prefix = 'f') => Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}`, kind: 'file' }));

async function ready(t, listing = ['src/', 'a.txt']) {
  t.session(1, 'A'); t.root(1);
  t.reply((await t.lists(''))[0], entries(listing));
  await flush();
}

test('请求带当前排序，默认名称升序；setSort 换排序后重取根和已展开的目录，每个目录一次替换', async () => {
  const t = manual();
  await ready(t);
  assert.deepEqual(t.sent.at(-1).sort, { key: 'name', desc: false });
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['x', 'y']));
  await flush();
  const start = t.sent.length;
  t.model.setSort({ key: 'date', desc: true });
  assert.deepEqual(t.model.sort, { key: 'date', desc: true });
  const requests = (await t.lists()).slice(start);
  assert.deepEqual(requests.map(r => r.path).sort(), ['', 'src']);
  for (const request of requests) assert.deepEqual(request.sort, { key: 'date', desc: true });
  assert.deepEqual(names(t.model, 'src'), ['x', 'y'], '没取完之前旧顺序不动');
  for (const request of requests) t.reply(request, entries(request.path === '' ? ['a.txt', 'src/'] : ['y', 'x']));
  await flush();
  assert.deepEqual(names(t.model, 'src'), ['y', 'x']);
  assert.deepEqual(names(t.model), ['a.txt', 'src']);
});

test('setSort：同一排序不重取；形状不对的忽略', async () => {
  const t = manual();
  await ready(t);
  const start = t.sent.length;
  await t.model.setSort({ key: 'name', desc: false });
  await t.model.setSort({ key: 'size' });
  await t.model.setSort('date');
  assert.equal((await t.lists()).length, start);
  assert.deepEqual(t.model.sort, { key: 'name', desc: false });
});

test('setSort：这次取的条数不超过 RESTORE_LIMIT，普通刷新取够用户翻出来的条数', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['x']));
  await flush();
  t.model.dirs.get('src').entries = many(30_000); // 用户翻出来的 3 万条
  const run = async action => {
    const start = t.sent.length;
    action();
    let answered = 0;
    for (;;) {
      await flush();
      const open = t.sent.slice(start).filter(m => m.path === 'src' && !m.done);
      if (!open.length) return answered;
      for (const request of open) { request.done = true; answered++; t.reply(request, { entries: many(12_000), nextCursor: `c${answered}` }); }
    }
  };
  assert.equal(await run(() => t.model.setSort({ key: 'size', desc: false })), 2, '24,000 条已经超过 20,000，不再取');
  assert.equal(t.model.dirs.get('src').entries.length, 24_000);
  assert.ok(t.model.dirs.get('src').next);
  t.model.dirs.get('src').entries = many(30_000);
  assert.equal(await run(() => t.model.refresh()), 3, '普通刷新照旧取够 30,000 条');
  assert.ok(RESTORE_LIMIT === 20_000);
});

test('旧的 #reload 不再发下一页：同目录有新的加载后，旧加载的回答不引出新请求', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['a', 'b'], 'c1'));
  await flush();
  t.model.loadMore('src');
  t.reply((await t.lists('src'))[1], entries(['c', 'd']));
  await flush(); // 已加载 4 条，刷新要取够 4 条
  t.model.refresh();
  const [old] = (await t.lists('src')).slice(-1);
  t.model.retry('src'); // 更新的加载：作废旧的
  const before = (await t.lists('src')).length;
  t.reply(old, entries(['a'], 'next-1')); // 旧的拿到不够的一页，本来要接着取
  await flush();
  assert.equal((await t.lists('src')).length, before, '旧加载不再发下一页');
});

test('停止旧的一轮刷新：12 个展开目录连续刷新，旧一轮不再派发排队的目录，不作废新加载', async () => {
  const t = manual();
  const dirs = Array.from({ length: 12 }, (_, i) => `d${i}`);
  await ready(t, dirs.map(d => `${d}/`));
  t.model.expanded = new Set(dirs);
  const start = t.sent.length;
  t.model.refresh(); // 第 1 轮：8 个在途，5 个排队
  await flush();
  t.model.refresh(); // 第 2 轮
  await flush();
  const requests = () => t.sent.slice(start);
  assert.equal(requests().length, 2 * MAX_PARALLEL);
  const answered = new Set();
  for (;;) {
    await flush();
    const open = requests().filter(m => !answered.has(m.requestId));
    if (!open.length) break;
    for (const request of open) {
      answered.add(request.requestId);
      t.reply(request, entries(request.path === '' ? dirs.map(d => `${d}/`) : [`${request.requestId}.txt`]));
    }
  }
  // 第 1 轮发出去的 8 个，加第 2 轮的 13 个（根和 12 个目录）；旧的一轮没有再启动排队的 5 个。
  assert.equal(requests().length, 8 + 13);
  for (const path of dirs) {
    const dir = t.model.dirs.get(path);
    assert.deepEqual([dir.loaded, dir.loading, dir.error], [true, false, null], path);
    const last = requests().filter(m => m.path === path).at(-1);
    assert.deepEqual(dir.entries.map(e => e.name), [`${last.requestId}.txt`], `${path} 是最新一轮的内容`);
  }
});

test('旧的 loadMore 不追加：换排序后迟到的下一页被丢弃', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['a', 'b'], 'c1'));
  await flush();
  t.model.loadMore('src');
  const [, more] = await t.lists('src');
  t.model.setSort({ key: 'size', desc: true });
  t.reply(more, entries(['late']));
  await flush();
  assert.deepEqual(names(t.model, 'src'), ['a', 'b']);
  const reload = (await t.lists('src')).at(-1);
  t.reply(reload, entries(['z', 'y']));
  await flush();
  assert.deepEqual(names(t.model, 'src'), ['z', 'y']);
});

test('cursor_expired：loadMore 转成从第一页重取，条数比现在多一条所以接着往下取；再过期走失败行', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['a', 'b'], 'snap'));
  await flush();
  t.model.loadMore('src');
  t.fail((await t.lists('src'))[1], 'cursor_expired');
  const afterExpired = (await t.lists('src'))[2];
  assert.equal(afterExpired.cursor, null, '从第一页重取');
  t.reply(afterExpired, entries(['a', 'b'], 'snap2')); // 只有 2 条，不比原来多，要接着取
  const next = (await t.lists('src'))[3];
  assert.equal(next.cursor, 'snap2');
  t.reply(next, entries(['c'], null));
  await flush();
  assert.deepEqual(names(t.model, 'src'), ['a', 'b', 'c']);
  assert.equal(t.model.dirs.get('src').loading, false);

  // 重取的途中又过期：只重取一次，再失败走失败行。
  const dir = t.model.dirs.get('src');
  Object.assign(dir, { next: 'snap3' });
  const before = (await t.lists('src')).length;
  t.model.loadMore('src');
  t.fail((await t.lists('src'))[before], 'cursor_expired');
  t.reply((await t.lists('src'))[before + 1], entries(['a'], 'snap4'));
  t.fail((await t.lists('src'))[before + 2], 'cursor_expired');
  await flush();
  assert.equal((await t.lists('src')).length, before + 3, '没有循环');
  assert.equal(dir.error.code, 'cursor_expired');
  assert.equal(dir.loading, false);
  assert.deepEqual(names(t.model, 'src'), ['a', 'b', 'c'], '失败时保留旧条目');
  const rows = visibleRows(t.model);
  assert.ok(rows.some(row => row.retry && row.text.startsWith('更新失败')));
});

test('cursor_expired：刷新取到一半游标过期，丢掉已取的从第一页重取一次', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['a', 'b'], 'c1'));
  await flush();
  t.model.loadMore('src');
  t.reply((await t.lists('src'))[1], entries(['c', 'd']));
  await flush(); // 4 条
  t.model.refresh();
  const lists = () => t.lists('src');
  t.reply((await lists()).at(-1), entries(['a', 'b'], 'x1'));
  await flush();
  t.fail((await lists()).at(-1), 'cursor_expired'); // 第二页的游标过期
  const restart = (await lists()).at(-1);
  assert.equal(restart.cursor, null);
  t.reply(restart, entries(['a', 'b'], 'x2'));
  await flush();
  t.reply((await lists()).at(-1), entries(['c', 'd']));
  await flush();
  assert.deepEqual(names(t.model, 'src'), ['a', 'b', 'c', 'd']);
  assert.equal(t.model.dirs.get('src').error, null);
});

test('sortFallback：来自第一页，提示行不可点、不算内容；下一次第一页不带就清除', async () => {
  const t = manual();
  t.model.sort = { key: 'size', desc: true }; // 选了大小排序，目录太大退回了名称
  await ready(t, ['src/']);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], { ...entries([]), sortFallback: true });
  await flush();
  assert.equal(t.model.dirs.get('src').sortFallback, true);
  let rows = visibleRows(t.model);
  const at = rows.findIndex(row => row.path === 'src' && row.type === 'status');
  assert.deepEqual([rows[at].text, rows[at].retry, rows[at + 1].text], ['条目太多，只能按名称排列', undefined, '空目录'], '提示行之后仍然判断空目录');
  t.model.setSort({ key: 'name', desc: false });
  for (const request of (await t.lists()).slice(-2)) t.reply(request, request.path === '' ? entries(['src/']) : entries(['a']));
  await flush();
  assert.equal(t.model.dirs.get('src').sortFallback, false);
  rows = visibleRows(t.model);
  assert.ok(!rows.some(row => row.text === '条目太多，只能按名称排列'));
});

test('parseState：校验顶层 sort，形状不对回默认值；保存和裁剪不丢它', () => {
  const base = { v: 1, seq: 0, hidden: false, sessions: {} };
  assert.deepEqual(parseState(undefined).sort, { key: 'name', desc: false });
  assert.deepEqual(parseState({ ...base, sort: { key: 'size', desc: true } }).sort, { key: 'size', desc: true });
  for (const sort of [{ key: 'size' }, { key: 'x', desc: true }, 'size', null, 5, { key: 'size', desc: 1 }]) {
    assert.deepEqual(parseState({ ...base, sort }).sort, { key: 'name', desc: false }, JSON.stringify(sort));
  }
  assert.deepEqual(parseState({ ...base, sort: { key: 'date', desc: false, extra: 1 } }).sort, { key: 'date', desc: false });
  const state = parseState({ ...base, sort: { key: 'date', desc: true } });
  putSession(state, 'A', { expanded: [], selected: null, scroll: { tree: 0, top: 0, left: 0 } });
  assert.deepEqual(trimState(state, 'A', 10).sort ?? { key: 'date', desc: true }, { key: 'date', desc: true });
  assert.deepEqual(trimState(state, 'A').sort, { key: 'date', desc: true });
});

test('parseState：每个会话的滚动位置带当时的排序，形状不对或缺失（旧版本）是默认排序', () => {
  const scroll = sort => ({ tree: 5, top: 0, left: 0, ...(sort === undefined ? {} : { sort }) });
  const { sessions } = parseState({ v: 1, sessions: {
    A: { expanded: [], scroll: scroll({ key: 'date', desc: true }) }, B: { expanded: [], scroll: scroll() },
    C: { expanded: [], scroll: scroll({ key: 'color', desc: true }) }, D: { expanded: [], scroll: scroll('size') },
  } });
  assert.deepEqual(sessions.A.scroll.sort, { key: 'date', desc: true });
  for (const id of ['B', 'C', 'D']) assert.deepEqual(sessions[id].scroll.sort, { key: 'name', desc: false }, id);
});
