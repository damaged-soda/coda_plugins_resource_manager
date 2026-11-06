// 打开文件的入口与 iPhone 布局的页面部分：真实的 app.mjs、file-app.mjs，配假 DOM 和一个会分页的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';

const PAGE = 3;
const NAMES = Array.from({ length: 8 }, (_, i) => `f${i}.txt`); // 8 个文件，每页 3 条

// 假模块：list 按 PAGE 分页（游标是起点），read 给固定正文。
async function open(t, { platform = 'ios', coda = {}, state } = {}) {
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); } catch { /* 同一个测试里第二次打开 */ }
  const sent = [], saved = [], visibility = [], events = {}, calls = { open: [], close: 0, back: [] };
  let page, generation = 0;
  const answer = request => {
    if (request.generation !== generation) return;
    const base = { generation, requestId: request.requestId };
    if (request.type === 'list') {
      const from = Number(request.cursor ?? 0), slice = NAMES.slice(from, from + PAGE);
      return page.post({ type: 'listed', ...base, entries: slice.map(name => ({ name, kind: 'file' })), nextCursor: from + PAGE < NAMES.length ? String(from + PAGE) : null });
    }
    const data = Buffer.from('正文');
    page.post({ type: 'chunk', ...base, data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 1, kind: 'text', eof: true });
  };
  page = await loadApp(t, {
    platform,
    postMessage: message => { sent.push(message); if (message.type === 'list' || message.type === 'read') queueMicrotask(() => answer(message)); },
    on: (name, fn) => { events[name] = fn; if (name === 'visibility') visibility.push(fn); },
    back: titles => calls.back.push(titles),
    copy: () => {},
    getState: () => state,
    setState: value => saved.push(JSON.parse(JSON.stringify(value))),
    open: args => { calls.open.push(args); return calls.result?.(); },
    close: () => { calls.close++; },
    ...coda,
  });
  const host = {
    sent, saved, calls, visibility, events,
    session(id = 's1') { generation++; page.post({ type: 'session', generation, session: id }); page.post({ type: 'root', generation, state: 'ready', path: '/A' }); },
  };
  return { page, host, tick: ms => t.mock.timers.tick(ms) };
}

const rows = page => page.tree.find(node => node.classList.contains('row'));
const row = (page, name) => rows(page).find(node => node.textContent.includes(name));
// 按可访问名称找：图标按钮靠 aria-label，文字按钮就是它的文字。
const button = (root, label) => root.find(node => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? node.textContent) === label)[0];

test('iPhone：点文件在页内切到预览，只读一次、不调 coda.open，选中留着；返回关预览', async t => {
  const { page, host } = await open(t);
  host.session();
  await flush();
  row(page, 'f1.txt').dispatch('click');
  await flush();
  assert.deepEqual(host.calls.open, []);
  assert.ok(visible(page.preview));
  assert.equal(visible(page.tree), false);
  assert.equal(host.sent.filter(m => m.type === 'read').length, 1, '读一次');
  assert.deepEqual(host.calls.back.at(-1), ['资源管理器'], '预览比目录多一级：回到「资源管理器」');
  assert.equal(host.saved.at(-1)?.sessions.s1?.opened ?? 'f1.txt', 'f1.txt');
  host.events.back({ steps: 1 });
  await flush();
  assert.ok(visible(page.tree));
  assert.equal(visible(page.preview), false);
  assert.ok(row(page, 'f1.txt').classList.contains('sel'), '回来时刚看的文件是选中的');
  assert.deepEqual(host.calls.back.at(-1), [], '路径回到打开前');
});

test('恢复带 selected 的状态：只当选中，不进预览（iPhone、Mac 一样）；带 opened 才进预览', async t => {
  const state = { v: 1, seq: 1, hidden: false, sessions: { s1: { at: 1, expanded: [], selected: 'f2.txt', scroll: { tree: 0, top: 0, left: 0 } } } };
  const ios = await open(t, { state });
  ios.host.session();
  await flush();
  assert.ok(visible(ios.page.tree));
  assert.equal(visible(ios.page.preview), false);
  assert.ok(row(ios.page, 'f2.txt').classList.contains('sel'));
  assert.equal(ios.host.sent.filter(m => m.type === 'read').length, 0);
  assert.equal(ios.host.calls.open.length, 0, '恢复不会自己打开文件');

  // Mac：只有 opened 才进预览；0.6.0 存的状态只有 selected，当作选中，不打开预览。
  const old = await open(t, { platform: 'mac', state });
  old.host.session();
  await flush();
  assert.ok(visible(old.page.tree));
  assert.equal(visible(old.page.preview), false);
  assert.ok(row(old.page, 'f2.txt').classList.contains('sel'));
  assert.equal(old.host.sent.filter(m => m.type === 'read').length, 0);

  state.sessions.s1.opened = 'f2.txt';
  const mac = await open(t, { platform: 'mac', state });
  mac.host.session();
  await flush();
  assert.ok(visible(mac.page.preview));
  assert.equal(visible(mac.page.tree), false);
});

test('Mac：双击文件进预览，头部「窗口」按钮用同样的 args 打开文件视图；失败有提示', async t => {
  const { page, host } = await open(t, { platform: 'mac' });
  host.session();
  await flush();
  row(page, 'f1.txt').dispatch('click');
  await flush();
  assert.equal(visible(page.preview), false, '单击只选中');
  row(page, 'f1.txt').dispatch('dblclick');
  await flush();
  assert.ok(visible(page.preview));
  assert.equal(host.calls.open.length, 0, '打开文件本身不开窗口');
  for (const label of ['窗口', '复制路径']) {
    const icon = button(page.preview, label);
    assert.equal(icon.getAttribute('aria-label'), label);
    assert.equal(icon.title, label, 'Mac 悬停有提示');
    assert.equal(icon.textContent, '', '只有图标，没有文字');
  }
  button(page.preview, '窗口').dispatch('click');
  await flush();
  assert.deepEqual(host.calls.open, [{ view: 'file', args: { session: 's1', path: 'f1.txt' } }]);
  assert.ok(visible(page.preview), '预览还在');
  host.calls.result = () => Promise.reject(new Error('没有这个视图'));
  button(page.preview, '窗口').dispatch('click');
  await flush();
  assert.match(page.hint.textContent, /没有这个视图/);
});

test('iPhone 的预览头部没有「窗口」；行不设 draggable，Mac 设', async t => {
  const ios = await open(t);
  ios.host.session();
  await flush();
  assert.equal(button(ios.page.preview, '窗口'), undefined);
  assert.equal(button(ios.page.preview, '复制路径'), undefined, 'iPhone 的复制路径在 ⋯ 菜单里');
  assert.ok(rows(ios.page).filter(node => node.classList.contains('entry')).every(node => !node.draggable));
  const mac = await open(t, { platform: 'mac' });
  mac.host.session();
  await flush();
  assert.ok(rows(mac.page).filter(node => node.classList.contains('entry')).every(node => node.draggable === true));
  assert.ok(button(mac.page.preview, '窗口'), 'Mac 的预览头部有「窗口」');
});

// 页面重新打开：用上一次存下的状态再来一遍。
const reopen = async (t, host, options) => open(t, { ...options, state: host.saved.at(-1) });

test('打开文件再回来：重建页面回到预览，返回后展开状态、已加载的条数和滚动位置都恢复（iPhone，visibility 保存）', async t => {
  const first = await open(t);
  first.host.session();
  await flush();
  row(first.page, '再显示').dispatch('click'); // 第二页
  await flush();
  assert.equal(rows(first.page).filter(node => node.classList.contains('entry')).length, 6);
  first.page.tree.scrollTop = 77;
  row(first.page, 'f4.txt').dispatch('click');
  await flush();
  first.host.visibility.forEach(fn => fn(false)); // 长按返回退出整层：不逐级关闭，opened 留着

  const second = await reopen(t, first.host);
  second.host.session();
  await flush();
  assert.ok(visible(second.page.preview), '恢复到上次开着的文件');
  second.host.events.back({ steps: 1 });
  await flush();
  assert.equal(rows(second.page).filter(node => node.classList.contains('entry')).length, 6, '取够了保存的条数，而不是只有第一页');
  assert.equal(second.page.tree.scrollTop, 77);
  assert.ok(row(second.page, 'f4.txt').classList.contains('sel'));
});

test('Mac 切标签（visibility: false 保存）回来同样恢复条数和滚动位置', async t => {
  const first = await open(t, { platform: 'mac' });
  first.host.session();
  await flush();
  row(first.page, '再显示').dispatch('click');
  await flush();
  first.page.tree.scrollTop = 40;
  first.host.visibility.forEach(fn => fn(false));
  const second = await reopen(t, first.host, { platform: 'mac' });
  second.host.session();
  await flush();
  assert.equal(rows(second.page).filter(node => node.classList.contains('entry')).length, 6);
  assert.equal(second.page.tree.scrollTop, 40);
});

test('横屏返回：iPhone 的资源页有「返回」：预览时先关预览，到根层才调 coda.close；Mac 没有；文件视图在 iPhone 上没有工具条', async t => {
  const ios = await open(t);
  ios.host.session();
  await flush();
  const exit = button(ios.page.bar, '返回');
  assert.ok(exit.classList.contains('exit'), '显示与否交给 CSS 的横屏媒体查询');
  row(ios.page, 'f1.txt').dispatch('click');
  await flush();
  assert.ok(visible(ios.page.preview));
  button(ios.page.bar, '返回').dispatch('click');
  await flush();
  assert.equal(ios.host.calls.close, 0, '先关预览');
  assert.ok(visible(ios.page.tree));
  button(ios.page.bar, '返回').dispatch('click');
  assert.equal(ios.host.calls.close, 1, '根层才关视图');

  const mac = await open(t, { platform: 'mac' });
  mac.host.session();
  await flush();
  assert.equal(button(mac.page.bar, '返回'), undefined);

  const file = await loadFileApp(t, { platform: 'ios', args: { session: 's1', path: 'f1.txt' }, postMessage: () => {}, on: () => {}, copy: () => {}, getState: () => undefined, setState: () => {}, close: () => {} });
  assert.equal(file.bar.hidden, true, '文件视图在 iPhone 上没有底部工具条');
});
