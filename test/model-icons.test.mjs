// 图标视图的模型（view/model.mjs）：视图和 cwd 的保存与恢复、根目录的身份、请求集合、缓存共用、cwd 没了的回退。
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PARALLEL, parseState, putSession, trimState } from '../view/model.mjs';
import { flush } from './support/fake.mjs';
import { entries, manual } from './support/page.mjs';

const paths = requests => requests.map(request => request.path);
const listed = async t => paths(await t.lists());
// 起一个 ready 的会话并回答根目录；saved 是这个会话保存的状态。
async function ready(t, { saved, root = '/r', listing = ['a/', 'z/', 'f.txt'] } = {}) {
  t.session(1, 'A', saved);
  t.root(1, 'ready', root);
  const [first] = await t.lists('');
  t.reply(first, entries(listing));
  await flush();
}

// ---- 状态：视图、cwd、根目录 ----

test('parseState：视图只认 icons，别的值（含缺省）回到列表', () => {
  assert.equal(parseState({ v: 1, view: 'icons', sessions: {} }).view, 'icons');
  for (const view of [undefined, null, 'list', 'grid', 5, {}]) assert.equal(parseState({ v: 1, view, sessions: {} }).view, 'list');
  assert.equal(parseState(undefined).view, 'list');
});

test('parseState：cwd 和根目录要成对、是字符串、不超长、不是绝对路径，否则当作没有；旧状态没有这些字段', () => {
  const read = fields => parseState({ v: 1, sessions: { A: { at: 1, ...fields } } }).sessions.A;
  assert.deepEqual([read({ cwd: 'a/b', root: '/r' }).cwd, read({ cwd: 'a/b', root: '/r' }).root], ['a/b', '/r']);
  for (const fields of [{}, { cwd: 'a' }, { root: '/r' }, { cwd: 5, root: '/r' }, { cwd: 'a', root: 5 }, { cwd: 'x'.repeat(1025), root: '/r' }, { cwd: '/etc', root: '/r' }, { cwd: 'a', root: 'x'.repeat(1025) }]) {
    const record = read(fields);
    assert.equal(record.cwd, undefined, JSON.stringify(fields).slice(0, 40));
    assert.equal(record.root, undefined);
  }
  assert.deepEqual(read({ scroll: { tree: 5 } }).scroll, { tree: 5, top: 0, left: 0, sort: 'name', grid: 0, gridSort: 'name' }, '0.5.0 的状态：网格的位置和排序是默认');
  assert.deepEqual(read({ scroll: { grid: 40, gridSort: 'date', tree: 1, sort: 'size' } }).scroll, { tree: 1, top: 0, left: 0, sort: 'size', grid: 40, gridSort: 'date' }, '两种视图各存各的');
});

test('快照带 cwd 和根目录，经 putSession、trimState 存取后原样回来', async () => {
  const t = manual();
  await ready(t);
  t.model.enter('a');
  await flush();
  const snapshot = t.model.snapshot();
  assert.deepEqual([snapshot.cwd, snapshot.root], ['a', '/r']);
  const state = parseState(undefined);
  putSession(state, 'A', { ...snapshot, scroll: {} });
  const back = parseState(JSON.parse(JSON.stringify(trimState(state, 'A'))));
  assert.deepEqual([back.sessions.A.cwd, back.sessions.A.root], ['a', '/r']);
});

test('同一个根目录重建：保留 cwd 和分页条数，不重取成根目录；请求的是根目录和 cwd', async () => {
  const t = manual();
  t.model.view = 'icons';
  await ready(t, { saved: { expanded: [], cwd: 'a/b', root: '/r', loaded: { 'a/b': 4 } } });
  assert.equal(t.model.cwd, 'a/b');
  assert.deepEqual(await listed(t), ['', 'a/b']);
  assert.equal(t.model.wanted.get('a/b'), 4, '条数留给 cwd 的第一次加载用');
  assert.equal(t.model.scope, 0, '身份没变');
});

test('不同根目录重建：cwd 和分页条数回到根目录，身份加一，只取根目录', async () => {
  const t = manual();
  t.model.view = 'icons';
  await ready(t, { root: '/other', saved: { expanded: [], cwd: 'a/b', root: '/r', loaded: { 'a/b': 4 } } });
  assert.equal(t.model.cwd, '');
  assert.equal(t.model.wanted.size, 0);
  assert.equal(t.model.scope, 1);
  assert.deepEqual(await listed(t), ['']);
});

test('0.5.0 的旧状态（没有 cwd 和根目录）：cwd 是根目录，分页条数照旧，身份不变', async () => {
  const t = manual();
  t.model.view = 'icons';
  await ready(t, { saved: { expanded: [], loaded: { 'x': 5 } } });
  assert.equal(t.model.cwd, '');
  assert.equal(t.model.scope, 0);
  assert.equal(t.model.wanted.get('x'), 5);
});

test('model.root 是 null 的重建：靠保存的根目录比，不是「路径变了」；就绪之后的 root 变化才算换了根目录', async () => {
  const t = manual();
  t.model.view = 'icons';
  await ready(t, { saved: { expanded: [], cwd: 'a', root: '/r' } });
  assert.equal(t.model.cwd, 'a', '第一条就绪的 root 和保存的相同');
  t.root(1, 'gone', '/r');
  t.root(1, 'ready', '/r');
  assert.equal(t.model.cwd, 'a', '离开又回来、路径没变，不算换');
  t.root(1, 'ready', '/moved');
  assert.equal(t.model.cwd, '');
  assert.equal(t.model.scope, 1);
});

test('重建途中（根目录还没到）保存：cwd 和根目录还是保存的那一份，不被冲成根目录', () => {
  const t = manual();
  t.session(1, 'A', { expanded: [], cwd: 'a/b', root: '/r' });
  assert.deepEqual([t.model.snapshot().cwd, t.model.snapshot().root], ['a/b', '/r']);
  t.root(1, 'preparing', null);
  assert.equal(t.model.snapshot().cwd, 'a/b', '根目录还没就绪');
});

test('换会话：每个会话一份 cwd，没有保存的是根目录', async () => {
  const t = manual();
  t.model.view = 'icons';
  await ready(t, { saved: { expanded: [], cwd: 'a', root: '/r' } });
  assert.equal(t.model.cwd, 'a');
  t.session(2, 'B');
  assert.equal(t.model.cwd, '');
  t.session(3, 'C', { expanded: [], cwd: 'z', root: '/q' });
  assert.equal(t.model.cwd, 'z');
});

// ---- 请求集合、共用的缓存 ----

test('请求集合：列表是根和展开的目录，图标是根和 cwd；cwd 同时是展开的目录时一轮只取一次', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('a');
  await flush();
  const before = (await t.lists()).length;
  t.model.refresh();
  assert.deepEqual(paths((await t.lists()).slice(before)), ['', 'a'], '列表');
  t.model.setView('icons');
  assert.deepEqual(t.model.requested(), ['']);
  t.model.enter('a');
  const mark = (await t.lists()).length;
  t.model.refresh();
  assert.deepEqual(paths((await t.lists()).slice(mark)), ['', 'a'], '图标：根和 cwd');
  t.model.expanded.add('a');
  const again = (await t.lists()).length;
  t.model.refresh();
  assert.deepEqual(paths((await t.lists()).slice(again)), ['', 'a'], 'cwd 也是展开的目录：不重复');
});

test('切换视图：马上按新的集合刷新，展开状态不动，没有内容的显示读取中，有的先显示已有的', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('a');
  const [open] = await t.lists('a');
  t.reply(open, entries(['x.txt']));
  await flush();
  const before = (await t.lists()).length;
  t.model.setView('icons');
  assert.equal(t.model.view, 'icons');
  assert.deepEqual([...t.model.expanded], ['a'], '展开状态不丢');
  assert.deepEqual(paths((await t.lists()).slice(before)), [''], '图标的集合只有根（cwd 是根）');
  assert.equal(t.model.dirs.get('').entries.length, 3, '回来之前先显示已有的');
  t.model.setView('list');
  assert.deepEqual(paths((await t.lists()).slice(before + 1)), ['', 'a'], '换回去：展开的目录又取');
  assert.deepEqual([...t.model.expanded], ['a']);
  t.model.view = 'icons';
  assert.equal(t.model.setView('weird') instanceof Promise, true, '不认识的值落回列表');
  assert.equal(t.model.view, 'list');
});

test('切换视图作废旧的排队轮次：旧一轮还没派发的目录不再发', async () => {
  const t = manual();
  await ready(t);
  const many = Array.from({ length: MAX_PARALLEL + 4 }, (_, i) => `d${i}`);
  for (const name of many) t.model.expanded.add(name);
  const done = t.model.refresh();
  await flush();
  const sentBefore = (await t.lists()).length;
  assert.equal(sentBefore, 1 + MAX_PARALLEL, '池子满了，剩下的排着');
  t.model.setView('icons');
  for (const request of (await t.lists()).slice(1)) t.reply(request, entries([]));
  await done;
  await flush();
  const asked = paths(await t.lists());
  assert.ok(!asked.includes(`d${MAX_PARALLEL}`), '排队的没有再派发');
});

test('收起 cwd 或它的上层：cwd 的条目留着，别的子目录清掉', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('a');
  const [req] = await t.lists('a');
  t.reply(req, entries(['b/']));
  await flush();
  t.model.toggle('a/b');
  const [reqB] = await t.lists('a/b');
  t.reply(reqB, entries(['c.txt']));
  await flush();
  t.model.view = 'icons';
  t.model.cwd = 'a/b';
  t.model.toggle('a'); // 收起 cwd 的上层
  assert.ok(t.model.dirs.has('a/b'), 'cwd 的条目留着');
  assert.equal(t.model.dirs.has('a'), false);
  assert.deepEqual([...t.model.expanded], []);
});

test('同目录共享、多页：cwd 取过的页数列表也看得到，快照存的是这一份的条数', async () => {
  const t = manual();
  await ready(t);
  t.model.setView('icons');
  t.model.enter('a');
  const [first] = await t.lists('a');
  t.reply(first, { ...entries(['1', '2']), nextCursor: 'c1' });
  await flush();
  t.model.loadMore('a');
  const more = (await t.lists('a')).at(-1);
  assert.equal(more.cursor, 'c1');
  t.reply(more, entries(['3', '4']));
  await flush();
  assert.equal(t.model.dirs.get('a').entries.length, 4);
  assert.deepEqual(t.model.snapshot().loaded, { a: 4 });
  t.model.setView('list');
  t.model.toggle('a');
  assert.equal(t.model.dirs.get('a').entries.length, 4, '展开时先显示共用的条目');
});

test('换排序之后：没重建过的目录不再用旧游标「再显示」，先从第一页重取', async () => {
  const t = manual();
  await ready(t);
  t.model.view = 'icons';
  t.model.enter('a');
  const [first] = await t.lists('a');
  t.reply(first, { ...entries(['1', '2']), nextCursor: 'c1' });
  await flush();
  t.model.view = 'list'; // 列表的集合里没有 a，换排序时它没重建
  t.model.setSort('date');
  await flush();
  assert.equal((await t.lists('a')).length, 1, 'a 没有在这一轮');
  t.model.loadMore('a');
  const requests = await t.lists('a');
  assert.equal(requests.length, 2);
  assert.deepEqual([requests[1].cursor, requests[1].sort], [null, 'date'], '从第一页取，不带旧游标');
  t.reply(requests[1], { ...entries(['1', '2', '3']), nextCursor: 'c2' });
  await flush();
  assert.equal(t.model.dirs.get('a').entries.length, 3);
  assert.equal(t.model.dirs.get('a').sort, 'date');
  t.model.loadMore('a');
  assert.equal((await t.lists('a')).at(-1).cursor, 'c2', '重建过之后正常翻页');
});

test('cursor_expired 在 cwd 上走现有规则：「再显示」从第一页重取，条数比现在多一条', async () => {
  const t = manual();
  await ready(t);
  t.model.setView('icons');
  t.model.enter('a');
  const [first] = await t.lists('a');
  t.reply(first, { ...entries(['1', '2']), nextCursor: 'c1' });
  await flush();
  t.model.loadMore('a');
  t.fail((await t.lists('a')).at(-1), 'cursor_expired');
  await flush();
  const retry = (await t.lists('a')).at(-1);
  assert.equal(retry.cursor, null, '重取从第一页');
  t.reply(retry, { ...entries(['1', '2']), nextCursor: 'c9' });
  await flush();
  const next = (await t.lists('a')).at(-1);
  assert.equal(next.cursor, 'c9', '条数还不够，接着取');
  t.reply(next, entries(['3']));
  await flush();
  assert.equal(t.model.dirs.get('a').entries.length, 3);
  assert.equal(t.model.cwd, 'a');
});

test('切换途中刷新失败和迟到的回答：失败只记在目录上，旧一轮迟到的回答不覆盖新的', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('a');
  const [slow] = await t.lists('a');
  t.model.setView('icons'); // 旧一轮在途中
  t.model.enter('a');
  const [fresh] = (await t.lists('a')).slice(1);
  t.reply(slow, entries(['old']));
  await flush();
  assert.equal(t.model.dirs.get('a').loaded, false, '旧的回答不进状态');
  t.fail(fresh, 'io_error', '读不了');
  await flush();
  assert.deepEqual(t.model.dirs.get('a').error, { code: 'io_error', message: '读不了' });
  assert.equal(t.model.cwd, 'a', '不是 not_found，停在这一级');
});

// ---- cwd 没了 ----

// 进入 path 并让它每一级都不存在：依次返回每一级发出的请求。
const enterGone = async (t, path) => { t.model.enter(path); await flush(); };
const countOf = async (t, path) => (await t.lists(path)).length;

test('cwd 没了（#reload）：清掉失效的子树，逐级退到最近的上一层，每级只试一次，一轮只提示一次', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.view = 'icons';
  t.model.expanded.add('a');
  await enterGone(t, 'a/b/c');
  t.fail((await t.lists('a/b/c'))[0], 'not_found');
  await flush();
  assert.equal(t.model.cwd, 'a/b');
  assert.equal(t.model.dirs.has('a/b/c'), false, '失效的目录清掉了');
  t.fail((await t.lists('a/b'))[0], 'not_found'); // 中间的一级也没了
  await flush();
  assert.equal(t.model.cwd, 'a');
  t.fail((await t.lists('a'))[0], 'not_found');
  await flush();
  assert.equal(t.model.cwd, '');
  assert.deepEqual([await countOf(t, 'a/b/c'), await countOf(t, 'a/b'), await countOf(t, 'a')], [1, 1, 1], '每级只试一次');
  assert.deepEqual(lost, ['a/b/c'], '一轮只提示一次');
  assert.deepEqual([...t.model.expanded], [], 'a 失效了，展开的也清掉');
  const [root] = (await t.lists('')).slice(-1);
  t.reply(root, entries(['f.txt']));
  await flush();
  assert.equal(t.model.dirs.get('').loaded, true, '清掉原目录后仍成功退到根目录');
});

test('cwd 没了（loadMore）：和重取走同一个处理', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.setView('icons');
  t.model.enter('a');
  const [first] = await t.lists('a');
  t.reply(first, { ...entries(['1']), nextCursor: 'c1' });
  await flush();
  t.model.loadMore('a');
  t.fail((await t.lists('a')).at(-1), 'not_found');
  await flush();
  assert.equal(t.model.cwd, '');
  assert.deepEqual(lost, ['a']);
  assert.equal(t.model.dirs.has('a'), false);
});

test('cwd 没了（cursor_expired 之后的重取）：同样走回退', async () => {
  const t = manual({ onLost: () => {} });
  await ready(t);
  t.model.setView('icons');
  t.model.enter('a');
  const [first] = await t.lists('a');
  t.reply(first, { ...entries(['1']), nextCursor: 'c1' });
  await flush();
  t.model.loadMore('a');
  t.fail((await t.lists('a')).at(-1), 'cursor_expired');
  await flush();
  t.fail((await t.lists('a')).at(-1), 'not_found');
  await flush();
  assert.equal(t.model.cwd, '');
});

test('cwd 的上层没了（列表里展开的目录是它的上层）：cwd 退到那一层的上一层，看的是列表就不提示', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.cwd = 'a/b';
  t.model.expanded.add('a');
  t.model.refresh();
  await flush();
  const [a] = await t.lists('a');
  t.fail(a, 'not_found');
  await flush();
  assert.equal(t.model.cwd, '', 'a 没了，a/b 也没了，退到 a 的上一层');
  assert.deepEqual(lost, []);
  assert.deepEqual([...t.model.expanded], []);
});

test('回退途中刷新不中断：新一轮对候选目录的请求接着往上退，旧请求的回答不算', async () => {
  const t = manual({ onLost: () => {} });
  await ready(t);
  t.model.view = 'icons';
  await enterGone(t, 'a/b');
  t.fail((await t.lists('a/b'))[0], 'not_found');
  await flush();
  assert.equal(t.model.cwd, 'a');
  const [stale] = await t.lists('a');
  t.model.refresh(); // 回退途中刷新：a 又取一次
  await flush();
  const fresh = (await t.lists('a')).at(-1);
  assert.notEqual(fresh, stale);
  t.fail(stale, 'not_found'); // 旧的回答：已被新一轮取代
  await flush();
  assert.equal(t.model.cwd, 'a');
  t.fail(fresh, 'not_found');
  await flush();
  assert.equal(t.model.cwd, '');
});

test('回退期间用户进了别的目录：迟到的 not_found 只清掉失效的子树，不把 cwd 拉回', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.view = 'icons';
  await enterGone(t, 'a/b');
  const [pending] = await t.lists('a/b');
  t.model.enter('z'); // 用户进了别的目录
  t.fail(pending, 'not_found');
  await flush();
  assert.equal(t.model.cwd, 'z');
  assert.equal(t.model.dirs.has('a/b'), false, '失效的子树还是清掉');
  assert.deepEqual(lost, []);
  assert.equal(await countOf(t, 'a'), 0, '没有为这次失败往上取');
});

test('刷新 cwd 的请求在途中，用户进了它的子目录：迟到的 not_found 不把 cwd 拉回上一层（导航上下文变了）', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.view = 'icons';
  t.model.enter('a');
  t.reply((await t.lists('a'))[0], entries(['q/']));
  await flush();
  t.model.refresh(); // a 又取一次，在途中
  await flush();
  const pending = (await t.lists('a')).at(-1);
  t.model.enter('a/q'); // 用户进了 a 里面的 q（a 的内容还显示着）
  t.fail(pending, 'not_found');
  await flush();
  assert.equal(t.model.cwd, 'a/q', '不被拉回');
  assert.deepEqual(lost, []);
  assert.equal(t.model.dirs.has('a'), false, '失效的子树清掉');
  assert.equal((await t.lists('')).length, 2, '没有为这次失败退到上一层再取（只有最初的根和刷新那一次）');
});

test('回退期间换会话：这一轮作废，新会话的 cwd 不受影响', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.view = 'icons';
  await enterGone(t, 'a/b');
  const [pending] = await t.lists('a/b');
  t.session(2, 'B', { expanded: [], cwd: 'q', root: '/r' });
  t.root(2, 'ready', '/r');
  t.fail(pending, 'not_found'); // 迟到
  await flush();
  assert.equal(t.model.cwd, 'q');
  assert.deepEqual(lost, []);
});

test('别的错误停在那一级：显示失败行（目录上有 error），不再往上退；重试可以再取', async () => {
  const t = manual({ onLost: () => {} });
  await ready(t);
  t.model.view = 'icons';
  await enterGone(t, 'a/b');
  t.fail((await t.lists('a/b'))[0], 'not_found');
  await flush();
  t.fail((await t.lists('a'))[0], 'io_error', '读不了');
  await flush();
  assert.equal(t.model.cwd, 'a');
  assert.deepEqual(t.model.dirs.get('a').error, { code: 'io_error', message: '读不了' });
  assert.equal(await countOf(t, ''), 1, '没有再往上取（只有最初那次根）');
  t.model.retry('a');
  assert.equal(await countOf(t, 'a'), 2);
});

test('恢复时 cwd 没了：悄悄退到最近的上一层，不提示；之后别的目录没了才提示', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  t.model.view = 'icons';
  t.session(1, 'A', { expanded: [], cwd: 'a/b', root: '/r' });
  t.root(1, 'ready', '/r');
  await flush();
  t.fail((await t.lists('a/b'))[0], 'not_found');
  await flush();
  t.fail((await t.lists('a'))[0], 'not_found');
  await flush();
  assert.equal(t.model.cwd, '');
  assert.deepEqual(lost, [], '恢复时不提示，整条回退链都不提示');
  t.reply((await t.lists('')).at(-1), entries(['z/']));
  await flush();
  t.model.enter('z');
  t.fail((await t.lists('z'))[0], 'not_found');
  await flush();
  assert.deepEqual(lost, ['z'], '用户进去之后没了：提示');
});

test('图标视图看不到的 cwd 没了（列表视图）：悄悄退，不提示', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.cwd = 'a';
  t.model.expanded.add('a');
  t.model.refresh();
  await flush();
  t.fail((await t.lists('a'))[0], 'not_found');
  await flush();
  assert.equal(t.model.cwd, '');
  assert.deepEqual(lost, []);
});

test('一轮只提示一次：同一轮里先后两处 cwd 失效，第二次不再提示；新的一轮可以再提示', async () => {
  const lost = [];
  const t = manual({ onLost: path => lost.push(path) });
  await ready(t);
  t.model.view = 'icons';
  t.model.enter('a');
  t.fail((await t.lists('a'))[0], 'not_found');
  await flush();
  t.model.enter('z');
  t.fail((await t.lists('z'))[0], 'not_found');
  await flush();
  assert.deepEqual(lost, ['a'], '同一轮');
  t.model.refresh();
  t.model.enter('a');
  t.fail((await t.lists('a')).at(-1), 'not_found');
  await flush();
  assert.deepEqual(lost, ['a', 'a'], '新的一轮');
});

test('leave：回上一层（可以一次退几层，到根为止）并加载；在根目录什么都不做', async () => {
  const t = manual();
  await ready(t);
  t.model.setView('icons');
  t.model.enter('a/b/c');
  await flush();
  const mark = (await t.lists()).length;
  t.model.leave(2);
  assert.equal(t.model.cwd, 'a');
  assert.deepEqual(paths((await t.lists()).slice(mark)), ['a'], '一次退两层，只取落到的那一层');
  t.model.leave(5);
  assert.equal(t.model.cwd, '');
  const done = (await t.lists()).length;
  t.model.leave();
  assert.equal((await t.lists()).length, done, '根目录没有上一层');
});

test('没就绪时进入或换视图不发请求，就绪后按当时的集合取', async () => {
  const t = manual();
  t.session(1, 'A');
  t.model.setView('icons');
  t.model.enter('a');
  await flush();
  assert.equal((await t.lists()).length, 0);
  t.root(1, 'ready', '/r');
  assert.deepEqual(await listed(t), ['', 'a']);
});
