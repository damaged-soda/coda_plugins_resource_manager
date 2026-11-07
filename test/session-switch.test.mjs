// 切会话时上一个会话的交互不再生效（长按、打开文件的回调、防连点），以及菜单外点击只关菜单。真实的 app.mjs 和 tree.mjs。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, previewName, rowNamed } from './support/treehost.mjs';

const listing = { '': ['dir/', 'a.txt', 'b.txt'], dir: ['inner.txt'] };
const touch = (extra = {}) => ({ pointerId: 1, isPrimary: true, clientX: 50, clientY: 60, ...extra });

async function start(t, options) {
  const ctx = await openTree(t, { listing, ...options });
  ctx.host.session();
  await flush();
  return ctx;
}
const down = (page, name) => rowNamed(page, name).dispatch('pointerdown', touch());
const click = (page, name) => { rowNamed(page, name).dispatch('pointerdown', touch()); rowNamed(page, name).dispatch('pointerup', touch()); rowNamed(page, name).dispatch('click'); };

test('长按途中切会话（新会话的 root 已到）：到点不弹菜单', async t => {
  const { page, host, tick } = await start(t);
  down(page, 'a.txt');
  tick(300);
  host.session('s2');
  await flush();
  tick(500);
  assert.equal(visible(page.menu), false);
});

test('长按途中切会话（新会话的 root 未到）：到点不弹菜单', async t => {
  const { page, host, tick } = await start(t);
  down(page, 'a.txt');
  tick(300);
  host.generation++;
  page.post({ type: 'session', generation: host.generation, session: 's2' });
  await flush();
  tick(500);
  assert.equal(visible(page.menu), false);
});

test('切会话前的吞点击标记不影响新会话的第一次点击', async t => {
  const { page, host, tick } = await start(t);
  down(page, 'a.txt');
  tick(500); // 触发长按，标记吞下一次点击，但点击没有跟来
  assert.ok(visible(page.menu));
  host.session('s2');
  await flush();
  assert.equal(visible(page.menu), false);
  rowNamed(page, 'a.txt').dispatch('click'); // 不带按下：只靠标记是否被清掉
  await flush();
  assert.equal(previewName(page), 'a.txt', '在页内打开了预览');
  assert.equal(host.calls.open.length, 0);
});

test('iPhone：预览开着时切会话，预览关掉、新会话回到目录；回到旧会话不自己再打开', async t => {
  const { page, host } = await start(t, { back: true });
  click(page, 'a.txt');
  await flush();
  assert.ok(visible(page.preview));
  host.session('s2');
  await flush();
  assert.equal(visible(page.preview), false);
  assert.ok(visible(page.tree));
  assert.equal(host.reads().length, 1, '新会话没有读旧文件');
  click(page, 'b.txt');
  await flush();
  assert.equal(previewName(page), 'b.txt', '新会话的点击不受旧状态影响');
  assert.equal(host.calls.open.length, 0);
});

test('Mac：旧会话的「窗口」切会话后才拒绝，新会话没有提示；切会话时清掉旧会话留下的提示', async t => {
  const { page, host } = await start(t, { platform: 'mac' });
  rowNamed(page, 'a.txt').dispatch('dblclick');
  await flush();
  const window = page.preview.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === '窗口')[0];
  host.openResult = () => Promise.reject(new Error('视图不可用'));
  window.dispatch('click');
  await flush();
  assert.equal(page.hint.hidden, false);
  host.session('s2');
  await flush();
  assert.equal(page.hint.hidden, true, '换会话清掉提示');

  host.session('s3');
  await flush();
  rowNamed(page, 'a.txt').dispatch('dblclick');
  await flush();
  const late = {};
  host.openResult = () => new Promise((resolve, reject) => { late.reject = reject; });
  page.preview.find(node => node.getAttribute('aria-label') === '窗口')[0].dispatch('click');
  await flush();
  host.session('s4');
  await flush();
  late.reject(new Error('视图不可用'));
  await flush();
  assert.equal(page.hint.hidden, true, '旧会话的结果不碰新会话');
});

for (const platform of ['ios', 'mac']) {
  test(`菜单开着时点菜单外的行（${platform}）：只关菜单，文件不打开、目录不展开，下一次点击正常`, async t => {
    const { page, host } = await start(t, { platform });
    rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 10, clientY: 10 });
    assert.ok(visible(page.menu));
    click(page, 'b.txt');
    await flush();
    assert.equal(visible(page.menu), false);
    assert.equal(host.reads().length, 0, '文件不打开');
    assert.equal(rowNamed(page, 'b.txt')?.classList.contains('sel') ?? false, false);

    rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 10, clientY: 10 });
    click(page, 'dir');
    await flush();
    assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false');

    click(page, 'dir');
    if (platform === 'mac') rowNamed(page, 'dir').dispatch('dblclick'); // Mac 双击才展开
    await flush();
    assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true', '下一次点击正常');
  });
}
