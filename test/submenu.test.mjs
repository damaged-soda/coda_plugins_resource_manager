// 「更多」菜单的二级菜单「显示」：Mac 在左边弹出侧面板，放不下和 iPhone 一样在菜单里切到下一层。
// 整次菜单和当前层分开：两个面板都算菜单里面；进下一层不关菜单；退回之后旧层的按钮不再响应；悬停计时器关闭时清掉。
// 真实的 app.mjs 和 menu.mjs，配假 DOM 和脚本化的假模块；假 DOM 没有布局，位置靠覆盖元素的 getBoundingClientRect 给。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { shown } from './support/more.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const listing = { '': ['dir/', 'a.txt', 'b.txt'], dir: ['x.txt'] };
const buttonsOf = node => node.find(child => child.tagName === 'BUTTON');
const labelsOf = node => buttonsOf(node).map(child => child.textContent);
const named = (node, label) => buttonsOf(node).find(child => child.textContent === label);
const hover = (node, extra = {}) => node.dispatch('pointerenter', { pointerType: 'mouse', ...extra });
const pointerClick = node => { node.dispatch('pointerdown', { pointerId: 1, isPrimary: true }); node.dispatch('pointerup'); node.dispatch('click'); };
const rect = (left, top = 4) => () => ({ left, top, right: left + 100, bottom: top + 120, width: 100, height: 120 });
const emitWindow = type => globalThis.window.emit({ type });

// Mac：原生「更多」按钮（toolbar 事件）；iPhone：页内的 ⋯。room：Mac 根面板左边有 200 点，放得下 100 点宽的侧面板。
async function start(t, { platform = 'mac', room = false } = {}) {
  const ctx = await openTree(t, { platform, listing, coda: platform === 'mac' ? { toolbar: () => {} } : {} });
  ctx.host.session('s1', '/work');
  await flush();
  const { page, host } = ctx;
  if (room) page.menu.getBoundingClientRect = rect(200);
  const more = () => (platform === 'mac' ? host.events.toolbar({ id: 'more' }) : page.bar.find(node => node.getAttribute('aria-label') === '更多')[0].dispatch('click'));
  const sorts = () => host.lists().map(request => request.sort);
  return { ...ctx, more, sorts, root: label => named(page.menu, label) };
}

// ---- Mac：侧面板 ----

test('Mac 鼠标移到「显示」：放得下时在根面板左边弹出侧面板，根面板还在；位置贴「显示」这一项', async t => {
  const { page, more, root } = await start(t, { room: true });
  more();
  const item = root('显示');
  item.getBoundingClientRect = () => ({ left: 200, top: 60, right: 300, bottom: 84 });
  hover(item);
  assert.ok(visible(page.menu) && visible(page.submenu));
  assert.deepEqual(labelsOf(page.submenu), ['列表', '图标', '名称', '种类', '日期', '大小'], '侧面板里是视图和排序，没有返回行');
  assert.deepEqual(labelsOf(page.menu), ['刷新', '显示隐藏文件', '显示'], '根面板不变');
  assert.equal(item.getAttribute('aria-expanded'), 'true');
  assert.equal(page.submenu.style.left, '98px', '根面板左边 200，减去侧面板宽 100，再留 2 点空隙');
  assert.match(page.submenu.style.top, /min\(55px,/, '第一项和「显示」对齐：项的上边 60 减去面板的边框和内边距');
  assert.equal(page.submenu.style.visibility, '', '量完尺寸就显示');
  assert.deepEqual(page.submenu.children.map(node => node.tagName), ['P', 'BUTTON', 'BUTTON', 'HR', 'P', 'BUTTON', 'BUTTON', 'BUTTON', 'BUTTON'], '小标题「视图」、两项、分隔线、小标题「排序」、四项');
  assert.deepEqual(page.submenu.find(node => node.tagName === 'P').map(node => node.textContent), ['视图', '排序']);
});

test('Mac 点「显示」也弹出侧面板，对勾是当前的视图和排序；点侧面板里的项：整个菜单关闭并执行', async t => {
  const { page, more, root, sorts, host } = await start(t, { room: true });
  more();
  root('显示').dispatch('click');
  assert.ok(visible(page.submenu));
  assert.deepEqual(buttonsOf(page.submenu).filter(node => node.getAttribute('aria-checked') === 'true').map(node => node.textContent), ['列表', '名称']);
  const before = host.lists().length;
  named(page.submenu, '日期').dispatch('click');
  assert.equal(visible(page.menu), false);
  assert.equal(visible(page.submenu), false, '两个面板都关');
  await flush();
  assert.equal(sorts().at(-1), 'date');
  assert.ok(host.lists().length > before);
});

test('Mac 侧面板放不下（根面板左边没有够宽的地方）：悬停什么都不做，点击切到下一层', async t => {
  const { page, more, root } = await start(t); // 假 DOM 里根面板的左边是 0，放不下 100 点宽的面板
  more();
  const item = root('显示');
  hover(item);
  assert.equal(visible(page.submenu), false, '悬停放不下就不动，免得内容在鼠标底下突然换掉');
  assert.deepEqual(labelsOf(page.menu), ['刷新', '显示隐藏文件', '显示']);
  assert.equal(item.getAttribute('aria-expanded'), 'false');
  item.dispatch('click');
  assert.equal(visible(page.submenu), false);
  assert.deepEqual(labelsOf(page.menu), ['返回', '列表', '图标', '名称', '种类', '日期', '大小'], '和 iPhone 一样：根面板换成下一层');
});

test('Mac 放得下和放不下按安全区算：左边的空间要扣掉安全区的左边', async t => {
  const { page, more, root } = await start(t, { room: true });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  globalThis.getComputedStyle = () => ({ paddingLeft: '120px' }); // 根面板左边 200，侧面板 100 + 2：留给侧面板的 98 点，比安全区的 120 少
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'getComputedStyle', saved); else delete globalThis.getComputedStyle; });
  more();
  hover(root('显示'));
  assert.equal(visible(page.submenu), false);
  globalThis.getComputedStyle = () => ({ paddingLeft: '90px' });
  hover(root('显示'));
  assert.ok(visible(page.submenu), '空间够了就弹出');
});

test('触摸产生的 pointerenter 不弹侧面板', async t => {
  const { page, more, root } = await start(t, { room: true });
  more();
  hover(root('显示'), { pointerType: 'touch' });
  assert.equal(visible(page.submenu), false);
});

// ---- 悬停计时器 ----

test('鼠标移到别的项：约 150 毫秒后收起侧面板，之前不收；回到「显示」或侧面板取消', async t => {
  const { page, more, root, tick } = await start(t, { room: true });
  more();
  hover(root('显示'));
  hover(root('刷新'));
  tick(149);
  assert.ok(visible(page.submenu), '斜着移过去的这一小段不误关');
  tick(1);
  assert.equal(visible(page.submenu), false);
  assert.equal(root('显示').getAttribute('aria-expanded'), 'false');

  hover(root('显示'));
  hover(root('刷新'));
  tick(100);
  hover(root('显示'));
  tick(300);
  assert.ok(visible(page.submenu), '回到「显示」取消');

  hover(root('显示隐藏文件'));
  tick(100);
  hover(page.submenu);
  tick(300);
  assert.ok(visible(page.submenu), '进了侧面板取消');
  assert.ok(visible(page.menu));
});

test('关闭菜单时清掉计时器：之后重开的侧面板不被旧计时器收起', async t => {
  const { page, more, root, tick } = await start(t, { room: true });
  more();
  hover(root('显示'));
  hover(root('刷新'));
  globalThis.document.emit({ type: 'keydown', key: 'Escape' });
  assert.equal(visible(page.menu), false);
  more();
  hover(root('显示'));
  tick(150);
  assert.ok(visible(page.submenu), '旧计时器已经清掉');
});

// ---- 身份：整次菜单和当前层 ----

test('点侧面板里面不算点外面：菜单不关，紧接着的点击也不被吞；点外面两个面板都关，那次点击不交给页面', async t => {
  const { page, host, more, root, sorts } = await start(t, { room: true });
  more();
  hover(root('显示'));
  const date = named(page.submenu, '日期');
  date.dispatch('pointerdown', { pointerId: 1, isPrimary: true });
  assert.ok(visible(page.menu) && visible(page.submenu), '按下侧面板：菜单还在');
  date.dispatch('pointerup');
  date.dispatch('click');
  await flush();
  assert.equal(sorts().at(-1), 'date', '点击照常交给按钮');
  assert.equal(visible(page.menu), false);

  more();
  hover(root('显示'));
  const row = rowNamed(page, 'a.txt');
  pointerClick(row);
  assert.equal(visible(page.menu), false);
  assert.equal(visible(page.submenu), false);
  assert.ok(visible(page.tree), '那次点击没有交给目录树：没有切到预览');
  assert.deepEqual(host.calls.open, []);
});

test('点根面板里面也不算点外面（侧面板开着时）', async t => {
  const { page, more, root } = await start(t, { room: true });
  more();
  hover(root('显示'));
  root('显示隐藏文件').dispatch('pointerdown', { pointerId: 1, isPrimary: true });
  assert.ok(visible(page.menu) && visible(page.submenu));
});

test('侧面板收起之后，手里留着的侧面板按钮不再响应', async t => {
  const { page, more, root, sorts, tick } = await start(t, { room: true });
  more();
  hover(root('显示'));
  const date = named(page.submenu, '日期');
  hover(root('刷新'));
  tick(150);
  const before = sorts().length;
  date.dispatch('click');
  await flush();
  assert.equal(sorts().length, before, '没有换排序');
  assert.ok(visible(page.menu), '也没有关菜单');
});

test('菜单关闭之后，侧面板的旧按钮不再响应', async t => {
  const { page, more, root, sorts } = await start(t, { room: true });
  more();
  hover(root('显示'));
  const date = named(page.submenu, '日期');
  globalThis.document.emit({ type: 'keydown', key: 'Escape' });
  const before = sorts().length;
  date.dispatch('click');
  await flush();
  assert.equal(sorts().length, before);
});

// ---- 下一层（iPhone，Mac 放不下时一样）----

for (const platform of ['ios', 'mac']) {
  const side = platform === 'ios' ? 'iPhone' : 'Mac 放不下时';

  test(`${side}：点「显示」切到下一层，不关菜单，顶上一行返回，点返回回到第一层`, async t => {
    const { page, more, root } = await start(t, { platform });
    more();
    const bar = platform === 'ios' ? page.bar.find(node => node.getAttribute('aria-label') === '更多')[0] : null;
    root('显示').dispatch('click');
    assert.ok(visible(page.menu), '进下一层不是叶子项：不关菜单');
    if (bar) assert.equal(bar.getAttribute('aria-expanded'), 'true', '还是同一次菜单');
    assert.deepEqual(labelsOf(page.menu), ['返回', '列表', '图标', '名称', '种类', '日期', '大小']);
    assert.equal(page.menu.children[0].textContent, '返回', '返回在最顶上一行');
    named(page.menu, '返回').dispatch('click');
    assert.ok(visible(page.menu));
    assert.deepEqual(labelsOf(page.menu), ['刷新', '显示隐藏文件', '显示']);
    if (bar) assert.equal(bar.getAttribute('aria-expanded'), 'true');
  });

  test(`${side}：退回之后，下一层留在手里的按钮不再响应；进入之后，第一层的旧按钮也不响应`, async t => {
    const { page, more, root, sorts, host } = await start(t, { platform });
    more();
    const refresh = root('刷新'), show = root('显示');
    show.dispatch('click');
    const date = named(page.menu, '日期');
    const before = [sorts().length, host.sent.filter(m => m.type === 'refresh').length];
    refresh.dispatch('click');
    await flush();
    assert.equal(host.sent.filter(m => m.type === 'refresh').length, before[1], '换层之后第一层的旧按钮不响应');
    assert.ok(visible(page.menu));

    named(page.menu, '返回').dispatch('click');
    date.dispatch('click');
    await flush();
    assert.equal(sorts().length, before[0], '退回之后下一层的旧按钮不响应，排序没换');
    assert.ok(visible(page.menu), '菜单也没关');
    show.dispatch('click'); // 退回后重画的「显示」是新按钮；旧的已经不在页面上，点它没有反应
    assert.deepEqual(labelsOf(page.menu), ['刷新', '显示隐藏文件', '显示']);
    root('显示').dispatch('click');
    assert.deepEqual(labelsOf(page.menu).slice(0, 2), ['返回', '列表'], '新按钮能再进一次');
  });

  test(`${side}：下一层里选一项：整个菜单关闭并执行；再打开又是第一层`, async t => {
    const { page, more, root, sorts } = await start(t, { platform });
    more();
    root('显示').dispatch('click');
    named(page.menu, '大小').dispatch('click');
    await flush();
    assert.equal(visible(page.menu), false);
    assert.equal(sorts().at(-1), 'size');
    more();
    assert.deepEqual(labelsOf(page.menu), ['刷新', '显示隐藏文件', '显示'], '重开是第一层，不停在上次的下一层');
  });

  test(`${side}：在下一层按 Escape、点外面、换会话都关整个菜单`, async t => {
    const { page, host, more, root } = await start(t, { platform });
    more();
    root('显示').dispatch('click');
    globalThis.document.emit({ type: 'keydown', key: 'Escape' });
    assert.equal(visible(page.menu), false);
    more();
    root('显示').dispatch('click');
    pointerClick(page.tree); // 点外面的那次点击被吞掉，下一次激活 ⋯ 才是打开
    assert.equal(visible(page.menu), false);
    more();
    root('显示').dispatch('click');
    host.session('s2', '/other');
    await flush();
    assert.equal(visible(page.menu), false);
  });
}

test('iPhone 下一层里再按 ⋯：关闭整个菜单', async t => {
  const { page, more, root } = await start(t, { platform: 'ios' });
  more();
  root('显示').dispatch('click');
  more();
  assert.equal(visible(page.menu), false);
});

// ---- 关闭的各种路径 ----

for (const [name, close] of [
  ['Escape', () => globalThis.document.emit({ type: 'keydown', key: 'Escape' })],
  ['窗口失焦', () => emitWindow('blur')],
  ['旋转（窗口尺寸变化）', () => emitWindow('resize')],
  ['页面滚动（目录树）', ({ page }) => page.tree.dispatch('scroll')],
  ['点菜单外', ({ page }) => page.tree.dispatch('pointerdown', { pointerId: 1, isPrimary: true })],
  ['换会话', async ({ host }) => { host.session('s2', '/other'); await flush(); }],
]) {
  test(`侧面板开着时${name}：两个面板都关，「显示」的展开状态复位`, async t => {
    const ctx = await start(t, { room: true });
    ctx.more();
    const item = ctx.root('显示');
    hover(item);
    assert.ok(visible(ctx.page.submenu));
    await close(ctx);
    assert.equal(visible(ctx.page.menu), false);
    assert.equal(visible(ctx.page.submenu), false);
    assert.equal(item.getAttribute('aria-expanded'), 'false');
  });
}

for (const [name, close] of [['旋转', () => emitWindow('resize')], ['窗口失焦', () => emitWindow('blur')]]) {
  test(`下一层里${name}也关`, async t => {
    const { page, more, root } = await start(t, { platform: 'ios' });
    more();
    root('显示').dispatch('click');
    close();
    assert.equal(visible(page.menu), false);
  });
}

test('菜单内部的滚动不关菜单（两个面板都是）', async t => {
  const { page, more, root } = await start(t, { room: true });
  more();
  hover(root('显示'));
  page.menu.dispatch('scroll');
  page.submenu.dispatch('scroll');
  assert.ok(visible(page.menu) && visible(page.submenu));
});

// ---- 原生按钮、选中视图 ----

test('Mac 原生按钮的路径：侧面板贴真实的「显示」项，不是页面右上角的假锚点；再按一次「更多」关闭两个面板', async t => {
  const { page, host, more, root } = await start(t, { room: true });
  more();
  assert.match(page.menu.style.left, /^max\(var\(--safe-left\), min\(220px,/, '根面板贴页面右上角（假锚点只代表根）');
  const item = root('显示');
  item.getBoundingClientRect = () => ({ left: 200, top: 70, right: 300, bottom: 94 });
  hover(item);
  assert.match(page.submenu.style.top, /min\(65px,/, '子菜单的位置来自「显示」这一项');
  more(); // 同一个原生按钮再按：关闭
  assert.equal(visible(page.menu), false);
  assert.equal(visible(page.submenu), false);
  host.events.toolbar({ id: 'more' });
  assert.ok(visible(page.menu));
  assert.equal(visible(page.submenu), false, '重新打开时侧面板是收起的');
});

test('切换视图：选「图标」整个菜单关闭，显示图标视图；对勾跟着变，再选「列表」换回', async t => {
  const { page, more, root } = await start(t, { room: true });
  more();
  root('显示').dispatch('click');
  named(page.submenu, '图标').dispatch('click');
  await flush();
  assert.equal(visible(page.menu) || visible(page.submenu), false);
  assert.ok(visible(page.grid) && !visible(page.tree), '图标视图');
  more();
  root('显示').dispatch('click');
  assert.deepEqual(buttonsOf(page.submenu).filter(node => node.getAttribute('aria-checked') === 'true').map(node => node.textContent), ['图标', '名称']);
  named(page.submenu, '列表').dispatch('click');
  await flush();
  assert.ok(visible(page.tree) && !visible(page.grid), '换回列表');
});

test('iPhone 切换视图：下一层里选「图标」关闭菜单，工具条标题仍是根目录名', async t => {
  const { page, more, root } = await start(t, { platform: 'ios' });
  more();
  root('显示').dispatch('click');
  named(page.menu, '图标').dispatch('click');
  await flush();
  assert.equal(visible(page.menu), false);
  assert.ok(visible(page.grid));
  assert.equal(page.bar.find(node => node.classList.contains('bar-title'))[0].textContent, 'work');
});

test('shown 辅助：只数看得到的面板', async t => {
  const { page, more, root } = await start(t, { room: true });
  more();
  assert.deepEqual(shown(page).map(node => node.textContent), ['刷新', '显示隐藏文件', '显示']);
  hover(root('显示'));
  assert.equal(shown(page).length, 9);
});

test('小标题和选项同层：这一层有对勾列时，小标题前有同宽的空位（.check），文字在选项的文字之前同样的位置', async t => {
  for (const [platform, room] of [['mac', true], ['mac', false], ['ios', false]]) {
    const { page, more, root } = await start(t, { platform, room });
    more();
    root('显示').dispatch('click');
    const layer = visible(page.submenu) ? page.submenu : page.menu;
    const heads = layer.find(node => node.tagName === 'P');
    assert.deepEqual(heads.map(node => node.textContent), ['视图', '排序'], platform);
    for (const head of heads) {
      assert.deepEqual(head.children.map(node => node.className), ['check', ''], `${platform}${room ? ' 侧面板' : ''}：空位在文字之前`);
      assert.equal(head.children[0].children.length, 0, '空位里没有对勾');
    }
    const option = buttonsOf(layer).find(node => node.textContent === '列表');
    assert.equal(option.children[0].className, 'check', '选项的对勾列用的是同一个类');
  }
});
