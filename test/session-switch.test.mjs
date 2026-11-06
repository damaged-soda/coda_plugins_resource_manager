// 切会话时上一个会话的交互不再生效（长按、打开文件的回调、防连点），以及菜单外点击只关菜单。真实的 app.mjs 和 tree.mjs。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

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
const deferred = host => { const out = {}; host.openResult = () => new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject; }); return out; };

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
  assert.equal(host.calls.open.length, 1);
});

test('切会话时清掉旧会话留下的提示', async t => {
  const { page, host } = await start(t);
  host.openResult = () => Promise.reject(new Error('视图不可用'));
  click(page, 'a.txt');
  await flush();
  assert.equal(page.hint.hidden, false);
  host.session('s2');
  await flush();
  assert.equal(page.hint.hidden, true);
});

test('旧会话的 open 切会话后才拒绝：新会话没有提示，点击不被锁', async t => {
  const { page, host } = await start(t);
  const open = deferred(host);
  click(page, 'a.txt');
  await flush();
  host.session('s2');
  await flush();
  open.reject(new Error('视图不可用'));
  await flush();
  assert.equal(page.hint.hidden, true);
  assert.equal(page.hint.textContent, '');
  click(page, 'b.txt');
  await flush();
  assert.equal(host.calls.open.length, 2, '新会话的点击没被旧状态锁住');
});

test('旧会话的 open 切会话后才成功：不隐藏新会话的提示，旧的解锁计时也不影响新会话', async t => {
  const { page, host, tick } = await start(t);
  const open = deferred(host);
  click(page, 'a.txt');
  await flush();
  host.session('s2');
  await flush();
  host.openResult = () => undefined;
  page.hint.hidden = false; // 新会话里已有的提示
  open.resolve();
  await flush();
  assert.equal(page.hint.hidden, false, '旧结果不碰新会话的提示');
  tick(1000); // 旧的解锁计时不该留下，也不该提前解开新会话的锁

  const second = deferred(host);
  click(page, 'a.txt');
  await flush();
  assert.equal(host.calls.open.length, 2);
  tick(1000);
  click(page, 'b.txt');
  await flush();
  assert.equal(host.calls.open.length, 2, '新会话的 open 仍在进行，继续锁着');
  second.resolve();
});

test('旧的解锁计时在切会话时取消', async t => {
  const { page, host, tick } = await start(t);
  const first = deferred(host);
  click(page, 'a.txt');
  await flush();
  first.resolve();
  await flush(); // 成功，解锁计时已排上
  tick(500);
  host.session('s2');
  await flush();
  const second = deferred(host);
  click(page, 'a.txt');
  await flush();
  tick(500); // 旧计时若还在，此刻会把新会话解开
  click(page, 'b.txt');
  await flush();
  assert.equal(host.calls.open.length, 2);
  second.resolve();
});

for (const platform of ['ios', 'mac']) {
  test(`菜单开着时点菜单外的行（${platform}）：只关菜单，文件不打开、目录不展开，下一次点击正常`, async t => {
    const { page, host } = await start(t, { platform });
    rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 10, clientY: 10 });
    assert.ok(visible(page.menu));
    click(page, 'b.txt');
    await flush();
    assert.equal(visible(page.menu), false);
    assert.equal(host.calls.open.length, 0);
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
