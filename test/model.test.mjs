// 页面状态层（view/model.mjs、view/tree.mjs 的纯部分）：请求与代次、目录替换、根目录状态、状态保留。
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PARALLEL, byteSize, parseState, putSession, trimState } from '../view/model.mjs';
import { visibleRows } from '../view/tree.mjs';
import { flush } from './support/fake.mjs';
import { entries, manual } from './support/page.mjs';

const names = model => model.dirs.get('')?.entries.map(e => e.name);

// 起一个 ready 的会话，并回答根目录。
async function ready(t, generation = 1, listing = ['src/', 'a.txt']) {
  t.session(generation, 'A');
  t.root(generation);
  t.reply((await t.lists(''))[0], entries(listing));
  await flush();
}

test('代次：A→B→A，第一次 A 迟到的回答不进状态，等待的超时也不再报错', async () => {
  const t = manual();
  t.session(1, 'A'); t.root(1);
  const [old] = await t.lists('');
  t.session(2, 'B'); t.session(3, 'A'); t.root(3);
  assert.equal(t.timers.count(), 1, '旧请求的计时器已停，只剩新的');
  t.reply(old, entries(['stale.txt'])); // 迟到的第一次 A
  await flush();
  assert.equal(t.model.dirs.get('').loaded, false);
  t.reply((await t.lists(''))[1], entries(['fresh.txt']));
  await flush();
  assert.deepEqual(names(t.model), ['fresh.txt']);
  t.timers.fire(); // 没有等待中的请求了，不能再产生错误
  assert.equal(t.model.dirs.get('').error, null);
});

test('代次：请求号还在等待，但回答的代次不同，也不接收', async () => {
  const t = manual();
  t.session(4, 'A');
  const call = t.link.call('read', { path: 'x', offset: 0 });
  const [request] = (await t.lists(undefined), t.sent);
  assert.equal(t.link.receive({ type: 'chunk', generation: 3, requestId: request.requestId, data: '' }), false);
  assert.equal(t.link.pending.size, 1);
  assert.equal(t.link.receive({ type: 'chunk', generation: 4, requestId: request.requestId, data: 'ok' }), true);
  assert.equal((await call).data, 'ok');
});

test('代次：旧代次的 root、changed 不处理', async () => {
  const t = manual();
  t.session(2, 'B');
  assert.equal(t.root(1), null);
  assert.equal(t.model.root, null);
  t.root(2, 'none', null);
  assert.equal(t.model.onChanged({ generation: 1 }), null);
});

test('请求超过 30 秒：显示原因，重试重新发出', async t => {
  const m = manual();
  await ready(m);
  m.model.toggle('src');
  const [first] = await m.lists('src');
  m.timers.fire();
  await flush();
  assert.equal(m.model.dirs.get('src').error.code, 'timeout');
  m.reply(first, entries(['late.txt'])); // 超时后迟到的回答作废
  await flush();
  assert.equal(m.model.dirs.get('src').loaded, false);
  m.model.retry('src');
  m.reply((await m.lists('src'))[1], entries(['b.txt']));
  await flush();
  assert.deepEqual(m.model.dirs.get('src').entries.map(e => e.name), ['b.txt']);
  assert.equal(m.model.dirs.get('src').error, null);
});

test('目录刷新：取够已加载条数后整体替换，期间旧内容不变；条目减少、分页缩短', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['a', 'b'], 'c1'));
  await flush();
  t.model.loadMore('src');
  await flush();
  t.reply((await t.lists('src'))[1], entries(['c', 'd']));
  await flush();
  const dir = t.model.dirs.get('src');
  assert.deepEqual(dir.entries.map(e => e.name), ['a', 'b', 'c', 'd']);

  t.model.refresh();
  const lists = await t.lists('src');
  t.reply(lists[2], entries(['a', 'x'], 'c2')); // 只有 2 条，不够 4 条，要继续取
  await flush();
  assert.deepEqual(dir.entries.map(e => e.name), ['a', 'b', 'c', 'd'], '没取完之前不动旧内容');
  assert.equal((await t.lists('src')).at(-1).cursor, 'c2');
  t.reply((await t.lists('src')).at(-1), entries(['y']));
  await flush();
  assert.deepEqual(dir.entries.map(e => e.name), ['a', 'x', 'y']);

  t.model.refresh(); // 分页缩短：原来 3 条，现在 1 页就结束
  t.reply((await t.lists('src')).at(-1), entries(['z']));
  await flush();
  assert.deepEqual(dir.entries.map(e => e.name), ['z']);
  assert.equal(dir.next, null);
});

test('目录刷新：同目录的新刷新作废旧结果', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['v0']));
  await flush();
  t.model.refresh();
  t.model.refresh();
  const [, older, newer] = await t.lists('src');
  t.reply(newer, entries(['v2']));
  await flush();
  t.reply(older, entries(['v1'])); // 旧的后到
  await flush();
  assert.deepEqual(t.model.dirs.get('src').entries.map(e => e.name), ['v2']);
  assert.equal(t.model.dirs.get('src').loading, false);
});

test('目录刷新：回答 not_found 的目录连同下级从树和展开状态移除', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['lib/']));
  await flush();
  t.model.toggle('src/lib');
  t.reply((await t.lists('src/lib'))[0], entries(['x']));
  await flush();
  t.model.refresh();
  for (const request of (await t.lists()).slice(-3)) {
    if (request.path === 'src') t.fail(request, 'not_found'); else t.reply(request, entries(request.path === '' ? ['src/'] : ['x']));
  }
  await flush();
  assert.deepEqual([...t.model.expanded], []);
  assert.deepEqual([...t.model.dirs.keys()], ['']);
});

test('刷新并行不超过 8 个，全部取回', async () => {
  const t = manual();
  await ready(t, 1, Array.from({ length: 20 }, (_, i) => `d${i}/`));
  const dirs = Array.from({ length: 20 }, (_, i) => `d${i}`);
  t.model.expanded = new Set(dirs);
  const start = t.sent.length, replied = new Set();
  const done = t.model.refresh();
  let peak = 0;
  for (;;) {
    await flush();
    const open = t.sent.slice(start).filter(m => !replied.has(m.requestId));
    if (!open.length) break;
    peak = Math.max(peak, open.length);
    replied.add(open[0].requestId);
    t.reply(open[0], entries(open[0].path === '' ? dirs.map(d => `${d}/`) : ['f']));
  }
  await done;
  assert.equal(replied.size, 21);
  assert.ok(peak === MAX_PARALLEL, `峰值 ${peak}`);
  assert.equal(t.model.dirs.get('d19').loaded, true);
});

// 切换会话时 A 的刷新队列还没跑完：旧任务不能对新会话发请求或改状态。
const dirNames = count => Array.from({ length: count }, (_, i) => `d${i}`);

// A 展开 count 个目录并开始刷新，此时 8 个请求在途、其余在队列里。
async function refreshingA(t, count) {
  const names = dirNames(count);
  await ready(t, 1, names.map(d => `${d}/`));
  t.model.expanded = new Set(names);
  t.model.refresh();
  await flush();
  assert.equal(t.link.pending.size, MAX_PARALLEL);
}

// 回答当前代次的全部请求直到没有新的，返回收到的请求。
async function drain(t, listing) {
  const answered = new Set();
  for (;;) {
    await flush();
    const open = t.sent.filter(m => m.generation === t.link.generation && !answered.has(m.requestId));
    if (!open.length) return t.sent.filter(m => answered.has(m.requestId));
    for (const request of open) { answered.add(request.requestId); t.reply(request, entries(request.path === '' ? listing : ['f'])); }
  }
}

const countBy = (requests, generation) => {
  const counts = {};
  for (const m of requests) if (m.generation === generation) counts[m.path] = (counts[m.path] ?? 0) + 1;
  return counts;
};

function assertSettled(t, paths) {
  assert.equal(t.link.pending.size, 0);
  assert.deepEqual([...t.model.dirs.keys()].sort(), ['', ...paths].sort());
  for (const [path, dir] of t.model.dirs) assert.deepEqual([dir.loaded, dir.loading], [true, false], path);
}

for (const [title, between] of [['session 和 root 同一拍到达', false], ['session 和 root 之间微任务跑完', true]]) {
  test(`切换会话：A 的刷新队列不影响 B（${title}）`, async () => {
    const t = manual();
    await refreshingA(t, 9);
    const before = t.sent.length;
    t.session(2, 'B', { expanded: ['d8'] });
    if (between) await flush();
    t.root(2);
    await drain(t, dirNames(9).map(d => `${d}/`));
    assert.deepEqual(countBy(t.sent.slice(before), 2), { '': 1, d8: 1 });
    assertSettled(t, ['d8']);
  });
}

test('切换会话：A 的队列有 17 项以上，第二批旧任务晚于 B 的刷新也不影响 B', async () => {
  const t = manual();
  await refreshingA(t, 20);
  const before = t.sent.length;
  t.session(2, 'B', { expanded: ['d19'] });
  t.root(2);
  await drain(t, dirNames(20).map(d => `${d}/`));
  assert.deepEqual(countBy(t.sent.slice(before), 2), { '': 1, d19: 1 });
  assertSettled(t, ['d19']);
});

test('切换会话：A→B→A，第二次 A 的刷新不受第一次 A 的旧任务影响', async () => {
  const t = manual();
  await refreshingA(t, 20);
  const before = t.sent.length, listing = dirNames(20).map(d => `${d}/`);
  t.session(2, 'B', { expanded: [] });
  t.root(2);
  t.session(3, 'A', { expanded: dirNames(20) });
  t.root(3);
  await drain(t, listing);
  const requests = t.sent.slice(before);
  assert.deepEqual(countBy(requests, 2), { '': 1 }, 'B 只发过自己的根请求，已被后来的 A 作废');
  assert.deepEqual(countBy(requests, 3), Object.fromEntries(['', ...dirNames(20)].map(p => [p, 1])));
  assertSettled(t, dirNames(20));
});

test('切换会话：回答已到、继续前会话换了，不再取下一页', async () => {
  const t = manual();
  await ready(t, 1, ['src/']);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['a', 'b']));
  await flush();
  t.model.dirs.get('src').entries = [{ name: 'a', kind: 'file' }, { name: 'b', kind: 'file' }];
  const start = t.sent.length;
  t.model.refresh();
  const first = (await t.lists('src')).at(-1);
  t.reply(first, entries(['a'], 'c2')); // 不够 2 条，本该继续翻页
  t.session(2, 'B', { expanded: [] }); // 同一拍切换
  await flush();
  assert.deepEqual(t.sent.slice(start).filter(m => m.path === 'src' && m.cursor === 'c2'), []);
  assert.equal(t.link.pending.size, 0);
});

test('隐藏过滤：默认隐藏 .git、.DS_Store，开关不重新请求', async () => {
  const t = manual();
  await ready(t, 1, ['.git/', 'src/', '.DS_Store', '.gitignore', 'a.txt']);
  const shown = () => visibleRows(t.model).map(r => r.name);
  assert.deepEqual(shown(), ['src', '.gitignore', 'a.txt']);
  const before = t.sent.length;
  t.model.setShowHidden(true);
  assert.deepEqual(shown(), ['.git', 'src', '.DS_Store', '.gitignore', 'a.txt']);
  await flush();
  assert.equal(t.sent.length, before);
});

test('visibleRows：缩进、加载中、失败、空目录、再显示', async () => {
  const t = manual();
  await ready(t, 1, ['a/', 'b/', 'c/']);
  for (const dir of ['a', 'b', 'c']) t.model.toggle(dir);
  const [a, b, c] = await t.lists().then(l => l.slice(-3));
  t.reply(a, entries(['x'], 'next'));
  t.reply(b, entries([]));
  t.fail(c, 'denied', '没有权限');
  await flush();
  const rows = visibleRows(t.model);
  assert.deepEqual(rows.map(r => [r.type, r.name ?? r.text, r.depth]), [
    ['entry', 'a', 0], ['entry', 'x', 1], ['more', '再显示', 1], ['entry', 'b', 0], ['status', '空目录', 1], ['entry', 'c', 0], ['status', '读取失败：没有权限', 1],
  ]);
  assert.equal(rows.at(-1).retry, true);
  t.model.refresh(); // 已加载的目录刷新失败：保留旧内容，行上标出
  const again = await t.lists('a');
  t.fail(again.at(-1), 'io_error', '读取失败');
  await flush();
  assert.equal(visibleRows(t.model).find(r => r.path === 'a').failed, '读取失败');
  assert.equal(visibleRows(t.model).some(r => r.name === 'x'), true);
});

test('root 状态转换：ready → gone → ready 不清空展开状态，回到 ready 重新取', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['x']));
  await flush();
  t.root(1, 'gone', '/old');
  assert.equal(t.model.ready, false);
  assert.deepEqual([...t.model.expanded], ['src']);
  t.root(1, 'preparing', null);
  assert.deepEqual([...t.model.expanded], ['src']);
  const before = (await t.lists()).length;
  t.root(1, 'ready', '/new');
  const after = await t.lists();
  assert.deepEqual(after.slice(before).map(m => m.path).sort(), ['', 'src']);
  for (const request of after.slice(before)) t.reply(request, entries(request.path ? ['y'] : ['src/']));
  await flush();
  assert.deepEqual(t.model.dirs.get('src').entries.map(e => e.name), ['y']);
});

test('session 清空树、选中和等待中的请求，展开状态换成这个会话保存的', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  const [pendingSrc] = await t.lists('src');
  t.model.select('a.txt');
  t.session(2, 'B', { expanded: ['x', 'x/y', 'orphan/z'], selected: 'q' });
  assert.deepEqual([t.model.dirs.size, t.model.root, t.link.pending.size], [0, null, 0]);
  assert.deepEqual([...t.model.expanded], ['x', 'x/y'], '上层没展开的丢弃');
  assert.equal(t.model.selected, 'q');
  t.reply(pendingSrc, entries(['leak']));
  await flush();
  assert.equal(t.model.dirs.size, 0);
  t.session(3, null);
  assert.deepEqual([t.model.expanded.size, t.model.selected], [0, null]);
});

test('toggle：收起时同时收起下级，展开立即请求', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  t.reply((await t.lists('src'))[0], entries(['lib/']));
  await flush();
  t.model.toggle('src/lib');
  assert.equal((await t.lists('src/lib')).length, 1);
  t.model.toggle('src');
  assert.deepEqual([...t.model.expanded, ...t.model.dirs.keys()], ['']);
});

test('目录收起后才到的 listed 不进状态', async () => {
  const t = manual();
  await ready(t);
  t.model.toggle('src');
  const [request] = await t.lists('src');
  t.model.toggle('src');
  t.reply(request, entries(['late.txt']));
  await flush();
  assert.equal(t.model.dirs.has('src'), false);
});

test('状态裁剪：不超过上限，先淘汰最旧的会话，当前会话优先，超限不抛', () => {
  const state = parseState(null);
  const record = n => ({ expanded: Array.from({ length: n }, (_, i) => `d${i}`), selected: null, scroll: { tree: 0, top: 0, left: 0 } });
  putSession(state, 'old', record(300));
  putSession(state, 'mid', record(300));
  putSession(state, 'cur', record(300));
  const size = byteSize(state);
  let out = trimState(state, 'old', size - 1); // 当前是最旧的那个：保住它，淘汰别的
  assert.deepEqual(Object.keys(out.sessions).sort(), ['cur', 'old'], '淘汰的是 at 最小的非当前会话 mid');
  out = trimState(state, 'cur', 1500);
  assert.ok(byteSize(out) <= 1500);
  assert.deepEqual(Object.keys(out.sessions), ['cur']);
  assert.ok(out.sessions.cur.expanded.length > 0 && out.sessions.cur.expanded.length < 300);
  assert.equal(trimState(state, 'cur', 10).sessions.cur, undefined, '实在放不下就清空，不抛');
  assert.equal(trimState(state, 'cur').sessions.mid.expanded.length, 300, '没超限不动');
});

test('状态裁剪：先裁最深的展开目录，保留的仍满足「上层也展开」', () => {
  const state = parseState(null);
  const expanded = ['a', 'a/b', 'a/b/c', 'a/b/c/d', 'e', 'e/f'];
  putSession(state, 's', { expanded, selected: 'a/b/c/d/file', scroll: { tree: 5, top: 0, left: 0 } });
  const full = byteSize(state);
  const out = trimState(state, 's', full - 20).sessions.s;
  assert.ok(!out.expanded.includes('a/b/c/d'));
  for (const path of out.expanded) assert.ok(!path.includes('/') || out.expanded.includes(path.slice(0, path.lastIndexOf('/'))));
  assert.equal(out.selected, 'a/b/c/d/file');
});

test('parseState：坏的、别的版本的值回到空状态，只认自己的形状', () => {
  for (const raw of [undefined, null, 5, 'x', { v: 2 }, { v: 1, sessions: 3 }]) assert.deepEqual(parseState(raw).sessions, {});
  const parsed = parseState({ v: 1, hidden: true, seq: 3, sessions: { A: { at: 2, expanded: ['a', 7, 'b'], selected: 9, scroll: { tree: -1, top: 4 } }, B: null } });
  assert.equal(parsed.hidden, true);
  assert.deepEqual(parsed.sessions, { A: { at: 2, expanded: ['a', 'b'], selected: null, scroll: { tree: 0, top: 4, left: 0 } } });
});
