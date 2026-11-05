// 菜单开着时数据变了：树页的 changed、根目录变化，文件页的内容变化、根目录变化，都关掉开着的菜单；
// Mac 原生「更多」按钮打开的菜单（假锚点，不经页内工具条重画）也一样。真实的页面入口，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { fakeSelection } from './support/selection.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const listing = { '': ['src/', 'a.txt'] };

async function startTree(t, options) {
  const ctx = await openTree(t, { platform: 'mac', listing, ...options });
  ctx.host.session('s1', '/work');
  await flush();
  return ctx;
}
const openRowMenu = ({ page }) => {
  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.ok(visible(page.menu), '行菜单开着');
};

test('树页：开着行菜单时收到有效的 changed，菜单关闭，复制绝对路径用不上旧路径', async t => {
  const ctx = await startTree(t);
  openRowMenu(ctx);
  ctx.host.changed();
  await flush();
  assert.equal(visible(ctx.page.menu), false);
  assert.deepEqual(ctx.host.calls.copy, []);
});

test('树页：别的代次的 changed 是过期消息，不关菜单', async t => {
  const ctx = await startTree(t);
  openRowMenu(ctx);
  ctx.page.post({ type: 'changed', generation: ctx.host.generation + 7 });
  await flush();
  assert.ok(visible(ctx.page.menu));
});

test('树页：开着行菜单时根目录变了，菜单关闭；根目录没变的重复通知不关', async t => {
  const ctx = await startTree(t);
  const root = path => ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path });
  openRowMenu(ctx);
  root('/work');
  await flush();
  assert.ok(visible(ctx.page.menu), '同一个根目录再通知一次：不关');
  root('/other');
  await flush();
  assert.equal(visible(ctx.page.menu), false);
});

test('树页：Mac 原生「更多」打开的菜单，changed 和根目录变化也关闭', async t => {
  const given = [];
  const ctx = await startTree(t, { coda: { toolbar: items => given.push(items) } });
  const press = async () => { ctx.host.events.toolbar({ id: 'more' }); await flush(); assert.ok(visible(ctx.page.menu), '更多菜单开着'); };
  await press();
  ctx.host.changed();
  await flush();
  assert.equal(visible(ctx.page.menu), false, 'changed 关');
  await press();
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path: '/other' });
  await flush();
  assert.equal(visible(ctx.page.menu), false, '根目录变化关');
});

// ---- 文件页 ----

const TEXT = 'one\ntwo\nthree\n';
async function openFile(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const page = await loadFileApp(t, {
    platform: 'mac', args: { session: 's1', path: 'src/app.ts' },
    postMessage: message => { sent.push(message); }, on: () => {}, copy: () => {}, getState: () => undefined, setState: () => {},
  });
  page.post({ type: 'session', generation: 1, session: 's1' });
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/work' });
  await flush();
  const read = sent.find(message => message.type === 'read');
  page.post({ type: 'chunk', generation: 1, requestId: read.requestId, data: Buffer.from(TEXT).toString('base64'), offset: 0, size: TEXT.length, mtimeMs: 1, kind: 'text', eof: true });
  await flush();
  const el = page.preview.find(node => node.classList.contains('text'))[0];
  const sel = fakeSelection(t, page.preview.find(node => node.classList.contains('code'))[0]);
  const rightClick = () => {
    sel.select(el, 4, 7);
    el.dispatch('contextmenu', { clientX: 8, clientY: 9, preventDefault() {} });
    assert.ok(visible(page.menu), '选区菜单开着');
  };
  return { page, rightClick };
}

test('文件页：开着选区菜单时内容变化（changed），菜单关闭', async t => {
  const { page, rightClick } = await openFile(t);
  rightClick();
  page.post({ type: 'changed', generation: 1 });
  await flush();
  assert.equal(visible(page.menu), false);
});

test('文件页：根目录变化关闭选区菜单；同一个根目录的重复通知不关', async t => {
  const { page, rightClick } = await openFile(t);
  rightClick();
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/work' });
  await flush();
  assert.ok(visible(page.menu));
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/other' });
  await flush();
  assert.equal(visible(page.menu), false);
});
