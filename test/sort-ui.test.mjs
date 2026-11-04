// 排序控件、行内信息、菜单信息行、排序和滚动位置的保存与恢复：真实的 app.mjs 和 tree.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const OLD = new Date(2020, 2, 4, 10, 0).getTime(); // 往年：2020年3月
const noon = new Date().setHours(12, 0, 0, 0); // 今天中午：不会因为跑到午夜前后而变成昨天
const FULL = '2020-03-04 10:00:00';
const listing = {
  '': [
    { name: 'src', kind: 'dir', mtimeMs: OLD },
    { name: 'a.txt', kind: 'file', size: 1536, mtimeMs: OLD },
    { name: 'new.txt', kind: 'file', size: 12, mtimeMs: noon },
    { name: 'bare.txt', kind: 'file' },
    { name: 'gone', kind: 'link' },
  ],
};
const persisted = (sort, sessions = {}) => ({ v: 1, seq: 1, hidden: false, sort, sessions });
const record = (tree, sort) => ({ at: 1, expanded: [], selected: null, scroll: { tree, top: 0, left: 0, sort } });
const NAME = { key: 'name', desc: false }, DATE = { key: 'date', desc: true };

async function start(t, { platform = 'mac', state, coda = {}, session = ['s1', '/work/demo'] } = {}) {
  const ctx = await openTree(t, { platform, listing, state, coda });
  ctx.host.session(...session);
  await flush();
  return ctx;
}
const part = (node, cls) => node.find(child => child.classList.contains(cls))[0];
const macSort = page => part(page.tree, 'sort');
const phoneSort = page => page.bar.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label')?.startsWith('排序'))[0];
const items = page => page.menu.find(node => node.tagName === 'BUTTON');
const item = (page, text) => items(page).find(node => node.textContent === text);
const lastSort = host => host.lists().at(-1).sort;

test('Mac 排序控件：在标题行根目录名右边，图标加当前排序名，可访问名称写全', async t => {
  const { page } = await start(t);
  const title = page.tree.children[0], button = macSort(page);
  assert.ok(title.classList.contains('section'));
  assert.equal(title.children[0], part(title, 'section-name'));
  assert.equal(title.children[1], button, '排序在根目录名之后');
  assert.equal(button.textContent, '名称');
  assert.ok(button.find(node => node.tagName === 'SVG').length > 0, '有图标');
  assert.equal(button.getAttribute('aria-label'), '排序：名称，升序');
  assert.equal(button.title, '排序：名称，升序');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
});

test('排序菜单：四项，当前项有对勾和方向箭头；选当前项反向，选别的项用它的默认方向；控件和请求跟着变', async t => {
  const { page, host } = await start(t);
  const button = macSort(page);
  button.dispatch('click');
  assert.ok(visible(page.menu));
  assert.deepEqual(items(page).map(node => node.textContent), ['名称 ↑', '种类', '日期', '大小']);
  assert.deepEqual(items(page).map(node => node.getAttribute('aria-checked')), ['true', 'false', 'false', 'false']);
  assert.deepEqual(items(page).map(node => node.find(n => n.tagName === 'SVG').length), [1, 0, 0, 0], '只有当前项有对勾');
  assert.equal(button.getAttribute('aria-expanded'), 'true');

  const choose = async (text, expectSort, aria) => {
    button.dispatch('click');
    item(page, text).dispatch('click');
    await flush();
    assert.equal(visible(page.menu), false, '选完关闭');
    assert.deepEqual(lastSort(host), expectSort, text);
    assert.equal(button.getAttribute('aria-label'), aria);
  };
  button.dispatch('click'); // 关掉上面开着的
  await choose('名称 ↑', { key: 'name', desc: true }, '排序：名称，降序');
  await choose('名称 ↓', { key: 'name', desc: false }, '排序：名称，升序');
  await choose('日期', { key: 'date', desc: true }, '排序：日期，降序');
  assert.equal(button.textContent, '日期');
  await choose('日期 ↓', { key: 'date', desc: false }, '排序：日期，升序');
  await choose('大小', { key: 'size', desc: true }, '排序：大小，降序');
  await choose('种类', { key: 'kind', desc: false }, '排序：种类，升序');
  button.dispatch('click');
  assert.deepEqual(items(page).map(node => node.textContent), ['名称', '种类 ↑', '日期', '大小']);
});

test('排序菜单：同一个按钮再次激活是关闭（键盘没有 pointerdown），点菜单外只关菜单；按钮跨重画是同一个节点', async t => {
  const { page } = await start(t);
  const button = macSort(page);
  button.dispatch('click');
  assert.ok(visible(page.menu));
  button.dispatch('click');
  assert.equal(visible(page.menu), false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.dispatch('click');
  item(page, '日期').dispatch('click');
  await flush();
  assert.equal(macSort(page), button, '换排序后还是同一个节点');
  button.dispatch('pointerdown', { pointerId: 1, isPrimary: true });
  button.dispatch('click');
  assert.ok(visible(page.menu), '没开着时按下是打开');
  rowNamed(page, 'a.txt').dispatch('pointerdown', { pointerId: 1, isPrimary: true });
  assert.equal(visible(page.menu), false, '点菜单外关闭');
});

test('启动：persisted.sort 读进模型，第一次请求就用它，控件也是它；换排序写回 persisted', async t => {
  const saved = [], visibility = [];
  const { page, host } = await start(t, { state: persisted(DATE), coda: { setState: value => saved.push(JSON.parse(JSON.stringify(value))), on: (name, fn) => { if (name === 'visibility') visibility.push(fn); } } });
  assert.deepEqual(host.lists()[0].sort, DATE, '第一页请求就带着它');
  assert.equal(macSort(page).getAttribute('aria-label'), '排序：日期，降序');
  macSort(page).dispatch('click');
  item(page, '大小').dispatch('click');
  await flush();
  visibility.forEach(fn => fn(false));
  assert.deepEqual(saved.at(-1).sort, { key: 'size', desc: true });
  assert.deepEqual(saved.at(-1).sessions.s1.scroll.sort, { key: 'size', desc: true }, '会话的滚动位置带上当时的排序');
});

test('Mac 行：meta 按日期排序显示日期，否则显示大小；文件夹的大小是 —；读不到是 —；不能打开的没有 meta', async t => {
  const { page } = await start(t);
  const meta = name => part(rowNamed(page, name), 'meta')?.textContent;
  assert.deepEqual(['src', 'a.txt', 'new.txt', 'bare.txt'].map(meta), ['—', '1.5 KiB', '12 B', '—']);
  assert.equal(part(rowNamed(page, 'gone'), 'meta'), undefined);
  assert.equal(part(rowNamed(page, 'gone'), 'sub'), undefined);
  macSort(page).dispatch('click');
  item(page, '日期').dispatch('click');
  await flush();
  assert.deepEqual(['src', 'a.txt', 'bare.txt'].map(meta), ['2020年3月', '2020年3月', '—']);
  assert.match(meta('new.txt'), /^\d\d:\d\d$/, '今天是时分');
  macSort(page).dispatch('click');
  item(page, '种类').dispatch('click');
  await flush();
  assert.equal(meta('a.txt'), '1.5 KiB', '种类也显示大小');
});

test('iPhone 行：名字下面一行 日期 · 大小，文件夹是 日期 · —；不能打开的只有名字', async t => {
  const { page } = await start(t, { platform: 'ios' });
  const sub = name => part(rowNamed(page, name), 'sub')?.textContent;
  assert.equal(sub('src'), '2020年3月 · —');
  assert.equal(sub('a.txt'), '2020年3月 · 1.5 KiB');
  assert.match(sub('new.txt'), /^\d\d:\d\d · 12 B$/);
  assert.equal(sub('bare.txt'), '— · —');
  const gone = rowNamed(page, 'gone');
  assert.equal(part(gone, 'sub'), undefined);
  assert.deepEqual(part(gone, 'main').children.map(node => node.className), ['name truncate'], '只有名字');
});

test('Mac 的 title：路径、大小、完整修改时间', async t => {
  const { page } = await start(t);
  assert.equal(rowNamed(page, 'a.txt').title, `a.txt\n1.5 KiB · ${FULL}`);
  assert.equal(rowNamed(page, 'src').title, `src\n— · ${FULL}`);
  assert.equal(rowNamed(page, 'bare.txt').title, 'bare.txt\n— · —');
  assert.equal(rowNamed(page, 'gone').title, 'gone\n指向工作目录外的链接，不能打开');
});

const detail = page => part(page.menu, 'menu-info')?.textContent;
const touch = (extra = {}) => ({ pointerId: 1, isPrimary: true, clientX: 50, clientY: 60, ...extra });

test('右键菜单（Mac）：路径下面一行 大小 · 完整修改时间；读不到的是 —；不能打开的没有这一行', async t => {
  const { page } = await start(t);
  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(part(page.menu, 'menu-path').textContent, 'a.txt');
  assert.equal(detail(page), `1.5 KiB · ${FULL}`);
  rowNamed(page, 'src').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(detail(page), `— · ${FULL}`);
  rowNamed(page, 'bare.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(detail(page), '— · —');
  rowNamed(page, 'gone').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(detail(page), undefined);
  assert.deepEqual(items(page).map(node => node.textContent), ['复制相对路径', '复制绝对路径']);
});

test('长按菜单（iPhone）：同样的信息行', async t => {
  const { page, tick } = await start(t, { platform: 'ios' });
  rowNamed(page, 'a.txt').dispatch('pointerdown', touch());
  tick(500);
  assert.equal(part(page.menu, 'menu-path').textContent, 'a.txt');
  assert.equal(detail(page), `1.5 KiB · ${FULL}`);
  assert.notEqual(part(page.menu, 'menu-info'), part(page.menu, 'menu-path'));
});

test('iPhone 工具条：排序在根目录名和 ⋯ 之间，看到排序名，可访问名称写全；换排序工具条跟着重画', async t => {
  const { page, host } = await start(t, { platform: 'ios' });
  assert.deepEqual(page.bar.children.map(node => node.getAttribute('aria-label') ?? node.className.split(' ')[0]), ['exit', 'bar-title', '排序：名称，升序', '更多']);
  const button = phoneSort(page);
  assert.equal(button.textContent, '名称');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  button.dispatch('click');
  assert.deepEqual(items(page).map(node => node.textContent), ['名称 ↑', '种类', '日期', '大小']);
  item(page, '大小').dispatch('click');
  await flush();
  assert.deepEqual(lastSort(host), { key: 'size', desc: true });
  assert.equal(phoneSort(page).getAttribute('aria-label'), '排序：大小，降序');
  assert.equal(phoneSort(page).textContent, '大小');
  assert.equal(visible(page.menu), false);
  phoneSort(page).dispatch('click');
  phoneSort(page).dispatch('click'); // 同一来源再次激活
  assert.equal(visible(page.menu), false);
});

test('iPhone：排序菜单和 ⋯ 菜单互相替换，⋯ 仍是刷新和显示隐藏文件', async t => {
  const { page } = await start(t, { platform: 'ios' });
  phoneSort(page).dispatch('click');
  const more = page.bar.find(node => node.getAttribute('aria-label') === '更多')[0];
  more.dispatch('click');
  assert.deepEqual(items(page).map(node => node.textContent), ['刷新', '显示隐藏文件']);
  assert.equal(phoneSort(page).getAttribute('aria-expanded'), 'false');
});

test('Mac 的工具栏不改：换排序不重新声明，仍只有「更多」', async t => {
  const declared = [];
  const { page } = await start(t, { coda: { toolbar: items => declared.push(items) } });
  assert.deepEqual(declared, [[{ id: 'more', label: '更多', icon: 'ellipsis', kind: 'button' }]]);
  macSort(page).dispatch('click');
  item(page, '日期').dispatch('click');
  await flush();
  assert.equal(declared.length, 1);
});

// ---- 滚动位置 ----

test('换排序：滚动回到顶部', async t => {
  const { page } = await start(t);
  page.tree.scrollTop = 77;
  macSort(page).dispatch('click');
  item(page, '日期').dispatch('click');
  await flush();
  assert.equal(page.tree.scrollTop, 0);
});

test('恢复途中换排序：待恢复的位置作废，不会跳回旧位置', async t => {
  const state = persisted(NAME, { s1: record(120, NAME) });
  const { page, host } = await openTree(t, { platform: 'mac', listing, state });
  host.session('s1', '/work/demo'); // 目录还没取回，恢复在等
  macSort(page).dispatch('click');
  item(page, '日期').dispatch('click');
  await flush();
  assert.equal(page.tree.scrollTop, 0);
});

test('恢复：排序和保存时一致才恢复滚动位置，对不上回到顶部', async t => {
  const state = persisted(DATE, { s1: record(120, DATE), s2: record(90, NAME) });
  const { page, host } = await start(t, { platform: 'mac', state, session: ['s1', '/work/a'] });
  assert.equal(page.tree.scrollTop, 120);
  page.tree.scrollTop = 7;
  host.session('s2', '/work/b');
  await flush();
  assert.equal(page.tree.scrollTop, 0, '保存时是名称排序，现在是日期，对不上就回到顶部');
});

test('在 A 会话换了排序，再回到 B：B 保存的旧位置作废', async t => {
  const state = persisted(NAME, { s2: record(90, NAME) });
  const { page, host } = await start(t, { platform: 'mac', state, session: ['s1', '/work/a'] });
  macSort(page).dispatch('click');
  item(page, '日期').dispatch('click');
  await flush();
  host.session('s2', '/work/b');
  await flush();
  assert.equal(page.tree.scrollTop, 0);
  host.session('s1', '/work/a');
  await flush();
  page.tree.scrollTop = 33;
  host.session('s2', '/work/b');
  await flush();
  host.session('s1', '/work/a');
  await flush();
  assert.equal(page.tree.scrollTop, 33, '排序没再变，s1 保存的位置对得上');
});

test('旧版本保存的状态（没有排序字段）：全局排序是默认时照常恢复滚动位置', async t => {
  const state = { v: 1, seq: 1, hidden: false, sessions: { s1: { at: 1, expanded: [], selected: null, scroll: { tree: 55, top: 0, left: 0 } } } };
  const { page } = await start(t, { state });
  assert.equal(page.tree.scrollTop, 55);
});
