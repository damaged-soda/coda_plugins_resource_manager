// 排序控件、行内信息、菜单信息行、排序和滚动位置的保存与恢复：真实的 app.mjs 和 tree.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { checkedIn, pick, shown } from './support/more.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const OLD = new Date(2020, 2, 4, 10, 0).getTime(); // 往年：2020年3月
const noon = new Date().setHours(12, 0, 0, 0); // 今天中午：不会因为跑到午夜前后而变成昨天
const FULL = '2020-03-04 10:00:00';
const listing = {
  '': [
    { name: 'src', kind: 'dir', mtimeMs: OLD },
    { name: 'nodate', kind: 'dir' },
    { name: 'sized', kind: 'dir', size: 4096, mtimeMs: OLD },
    { name: 'a.txt', kind: 'file', size: 1536, mtimeMs: OLD },
    { name: 'new.txt', kind: 'file', size: 12, mtimeMs: noon },
    { name: 'bare.txt', kind: 'file' },
    { name: 'gone', kind: 'link' },
  ],
};
const persisted = (sort, sessions = {}) => ({ v: 1, seq: 1, hidden: false, sort, sessions });
const record = (tree, sort) => ({ at: 1, expanded: [], selected: null, scroll: { tree, top: 0, left: 0, sort } });
const NAME = 'name', DATE = 'date';

// 排序在「更多」菜单里：Mac 是原生按钮（测试里按 { id: 'more' } 触发），iPhone 是页内工具条的 ⋯。
async function start(t, { platform = 'mac', state, coda = {}, session = ['s1', '/work/demo'], settle = true } = {}) {
  const events = {};
  const ctx = await openTree(t, { platform, listing, state, coda: { toolbar: () => {}, on: (name, fn) => { events[name] = fn; }, ...coda } });
  ctx.host.session(...session);
  if (settle) await flush();
  const moreButton = () => ctx.page.bar.find(node => node.getAttribute('aria-label') === '更多')[0];
  return { ...ctx, events, more: () => (platform === 'ios' ? moreButton().dispatch('click') : events.toolbar({ id: 'more' })) };
}
const part = (node, cls) => node.find(child => child.classList.contains(cls))[0];
const items = page => page.menu.find(node => node.tagName === 'BUTTON');
const item = (page, text) => items(page).find(node => node.textContent === text);
const lastSort = host => host.lists().at(-1).sort;
// 打开 ⋯ 菜单选一项，等重取回来。
async function choose(ctx, label) {
  ctx.more();
  pick(ctx.page, label);
  await flush();
}
const SORTS = ['名称', '种类', '日期', '大小'];
// 排序在「显示」里：先进去，再看哪些项打了对勾（视图那一组的对勾不算，排序的四项才算）。
const checked = page => checkedIn(page).filter(label => SORTS.includes(label));

for (const platform of ['mac', 'ios']) {
  const side = platform === 'mac' ? 'Mac' : 'iPhone';

  test(`${side} ⋯ 菜单：刷新、显示隐藏文件、「显示」›；「显示」里小标题「视图」列表 / 图标，分隔线，小标题「排序」名称 / 种类 / 日期 / 大小，当前项有对勾`, async t => {
    const ctx = await start(t, { platform });
    const { page } = ctx;
    ctx.more();
    assert.ok(visible(page.menu));
    assert.deepEqual(page.menu.children.map(node => node.tagName), ['BUTTON', 'BUTTON', 'BUTTON'], '根层只有三项，排序不平铺');
    assert.deepEqual(items(page).map(node => node.textContent), ['刷新', '显示隐藏文件', '显示']);
    assert.deepEqual(items(page).map(node => node.getAttribute('role')), ['menuitem', 'menuitemcheckbox', 'menuitem']);
    assert.deepEqual(items(page).map(node => node.getAttribute('aria-haspopup')), [null, null, 'menu']);
    assert.equal(item(page, '显示').getAttribute('aria-expanded'), 'false');
    assert.equal(item(page, '显示').find(node => node.classList.contains('sub-arrow')).length, 1, '右边有箭头');

    item(page, '显示').dispatch('click');
    const layer = shown(page);
    assert.ok(visible(page.menu), '点「显示」不关菜单');
    assert.deepEqual(layer.map(node => node.textContent), ['返回', '列表', '图标', '名称', '种类', '日期', '大小']);
    assert.deepEqual(page.menu.children.map(node => node.tagName), ['BUTTON', 'HR', 'P', 'BUTTON', 'BUTTON', 'HR', 'P', 'BUTTON', 'BUTTON', 'BUTTON', 'BUTTON'], '返回、分隔线，小标题「视图」和两项，分隔线，小标题「排序」和四项');
    assert.deepEqual(page.menu.children.filter(node => node.tagName === 'P').map(node => node.textContent), ['视图', '排序']);
    const leaves = layer.slice(1);
    assert.deepEqual(leaves.map(node => node.getAttribute('role')), Array(6).fill('menuitemradio'));
    assert.deepEqual(leaves.map(node => node.getAttribute('aria-checked')), ['true', 'false', 'true', 'false', 'false', 'false']);
    assert.deepEqual(leaves.map(node => node.find(n => n.tagName === 'SVG').length), [1, 0, 1, 0, 0, 0], '当前的视图（列表）和排序（名称）有对勾');
    assert.deepEqual(leaves.map(node => node.children.length), Array(6).fill(2), '每一项都留对勾的位置，文字才对齐');
    assert.equal(part(page.menu, 'menu-path'), undefined, '这个菜单没有路径标题');
  });

  test(`${side}：没有独立的排序按钮`, async t => {
    const { page } = await start(t, { platform });
    const isSort = node => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? node.textContent).includes('排序');
    assert.equal(page.tree.find(node => node.tagName === 'BUTTON').length, 0, '标题行和目录树里没有按钮');
    assert.deepEqual([...page.bar.find(isSort), ...page.tree.find(isSort)], []);
    if (platform === 'ios') assert.deepEqual(page.bar.children.map(node => node.getAttribute('aria-label') ?? node.className.split(' ')[0]), ['exit', 'bar-title', '更多']);
    assert.equal(part(page.tree, 'section').textContent, 'demo', 'Mac 的标题行只留根目录名');
  });

  test(`${side}：选当前项什么都不做，不重取、不滚动、不关掉别的状态；选别的项重取一次并回到顶部`, async t => {
    const saved = [];
    const ctx = await start(t, { platform, coda: { setState: value => saved.push(JSON.parse(JSON.stringify(value))) } });
    const { page, host } = ctx;
    page.tree.scrollTop = 77;
    const before = host.lists().length;
    await choose(ctx, '名称');
    assert.equal(visible(page.menu), false, '选完关闭');
    assert.equal(host.lists().length, before, '没有新请求');
    assert.equal(page.tree.scrollTop, 77, '没有滚动');
    ctx.events.visibility(false);
    assert.ok(saved.length > 0 && saved.every(state => state.sort === NAME), '保存的排序没变');

    await choose(ctx, '日期');
    const requests = host.lists().slice(before);
    assert.deepEqual(requests.map(r => [r.path, r.sort]), [['', DATE]], '恰好一次重取，带新排序');
    assert.equal(page.tree.scrollTop, 0, '回到顶部');
    ctx.more();
    assert.deepEqual(checked(page), ['日期'], '对勾跟着走');
    ctx.more();

    page.tree.scrollTop = 40;
    await choose(ctx, '日期');
    assert.equal(host.lists().length, before + 1, '再选日期还是什么都不做');
    assert.equal(page.tree.scrollTop, 40);
  });

  test(`${side}：四个排序项依次选，请求带的就是它的键，没有方向`, async t => {
    const ctx = await start(t, { platform });
    for (const [label, key] of [['种类', 'kind'], ['日期', 'date'], ['大小', 'size'], ['名称', 'name']]) {
      await choose(ctx, label);
      assert.equal(lastSort(ctx.host), key, label);
    }
    assert.ok(ctx.host.lists().every(request => typeof request.sort === 'string'));
  });

  test(`${side}：启动时 persisted.sort 读进模型，第一次请求就用它，菜单的对勾也是它；换排序写回 persisted 和会话的滚动记录`, async t => {
    const saved = [];
    const ctx = await start(t, { platform, state: persisted(DATE), coda: { setState: value => saved.push(JSON.parse(JSON.stringify(value))) } });
    const { page, host } = ctx;
    assert.equal(host.lists()[0].sort, DATE, '第一页请求就带着它');
    ctx.more();
    assert.deepEqual(checked(page), ['日期']);
    pick(page, '大小');
    await flush();
    ctx.events.visibility(false);
    assert.equal(saved.at(-1).sort, 'size');
    assert.equal(saved.at(-1).sessions.s1.scroll.sort, 'size', '会话的滚动位置带上当时的排序');
  });

  test(`${side}：0.4.0 测试版存过的 { key, desc } 形状：不崩，落回名称，菜单和请求都是名称`, async t => {
    const old = { key: 'size', desc: true };
    const { page, host, more } = await start(t, { platform, state: persisted(old, { s1: record(55, old) }) });
    assert.equal(host.lists()[0].sort, NAME);
    more();
    assert.deepEqual(checked(page), ['名称']);
    assert.equal(page.tree.scrollTop, 55, '滚动记录的排序同样落回名称，和现在一致，照常恢复');
  });
}

const DIRS = ['src', 'nodate', 'sized'];
test('Mac 行：文件夹右侧只有按日期排序时的日期，没有大小也没有 —；读不到修改时间的文件夹什么都没有；文件不变', async t => {
  const ctx = await start(t);
  const { page } = ctx;
  const meta = name => part(rowNamed(page, name), 'meta')?.textContent;
  const noMeta = name => assert.equal(part(rowNamed(page, name), 'meta'), undefined, `${name} 没有 meta 元素，不留间距`);
  const checkDirsEmpty = () => {
    for (const name of DIRS) {
      noMeta(name);
      assert.deepEqual(part(rowNamed(page, name), 'main').children.map(n => n.className.split(' ')[0]), ['name', 'sub'].slice(0, name === 'nodate' ? 1 : 2));
    }
  };
  for (const key of ['名称', '种类', '大小']) {
    if (key !== '名称') await choose(ctx, key);
    checkDirsEmpty();
    assert.deepEqual(['a.txt', 'new.txt', 'bare.txt'].map(meta), ['1.5 KiB', '12 B', '—'], `${key}排序：文件显示大小`);
  }
  assert.equal(part(rowNamed(page, 'gone'), 'meta'), undefined);
  assert.equal(part(rowNamed(page, 'gone'), 'sub'), undefined);
  await choose(ctx, '日期');
  assert.deepEqual(['src', 'sized', 'a.txt', 'bare.txt'].map(meta), ['2020年3月', '2020年3月', '2020年3月', '—']);
  noMeta('nodate');
  assert.match(meta('new.txt'), /^\d\d:\d\d$/, '今天是时分');
  for (const name of DIRS) assert.doesNotMatch(rowNamed(page, name).textContent, /[—·]/, name);
});

test('iPhone 行：文件 日期 · 大小；文件夹只有日期，读不到修改时间的文件夹没有第二行；不能打开的只有名字', async t => {
  const { page } = await start(t, { platform: 'ios' });
  const sub = name => part(rowNamed(page, name), 'sub')?.textContent;
  assert.equal(sub('src'), '2020年3月');
  assert.equal(sub('sized'), '2020年3月', '就算数据里有大小也不显示');
  assert.equal(sub('nodate'), undefined);
  assert.deepEqual(part(rowNamed(page, 'nodate'), 'main').children.map(node => node.className), ['name truncate'], '和不能打开的条目一样，只有名字');
  for (const name of DIRS) assert.doesNotMatch(rowNamed(page, name).textContent, /[—·]/, name);
  assert.equal(sub('a.txt'), '2020年3月 · 1.5 KiB');
  assert.match(sub('new.txt'), /^\d\d:\d\d · 12 B$/);
  assert.equal(sub('bare.txt'), '— · —');
  const gone = rowNamed(page, 'gone');
  assert.equal(part(gone, 'sub'), undefined);
  assert.deepEqual(part(gone, 'main').children.map(node => node.className), ['name truncate'], '只有名字');
});

test('Mac 的 title：文件是路径、大小、完整修改时间；文件夹只有完整修改时间，读不到就只有路径', async t => {
  const { page } = await start(t);
  assert.equal(rowNamed(page, 'a.txt').title, `a.txt\n1.5 KiB · ${FULL}`);
  assert.equal(rowNamed(page, 'src').title, `src\n${FULL}`);
  assert.equal(rowNamed(page, 'sized').title, `sized\n${FULL}`);
  assert.equal(rowNamed(page, 'nodate').title, 'nodate');
  assert.equal(rowNamed(page, 'bare.txt').title, 'bare.txt\n— · —');
  assert.equal(rowNamed(page, 'gone').title, 'gone\n指向工作目录外的链接，不能打开');
});

const detail = page => part(page.menu, 'menu-info')?.textContent;
const touch = (extra = {}) => ({ pointerId: 1, isPrimary: true, clientX: 50, clientY: 60, ...extra });

test('右键菜单（Mac）：路径下面一行 大小 · 完整修改时间；文件夹只有修改时间；文件读不到的是 —；不能打开的没有这一行', async t => {
  const { page } = await start(t);
  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(part(page.menu, 'menu-path').textContent, 'a.txt');
  assert.equal(detail(page), `1.5 KiB · ${FULL}`);
  rowNamed(page, 'src').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(detail(page), FULL, '文件夹只有完整修改时间');
  rowNamed(page, 'nodate').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(part(page.menu, 'menu-path').textContent, 'nodate');
  assert.equal(detail(page), undefined, '文件夹读不到修改时间：没有信息行');
  rowNamed(page, 'bare.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(detail(page), '— · —');
  rowNamed(page, 'gone').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(detail(page), undefined);
  assert.deepEqual(items(page).map(node => node.textContent), ['复制相对路径', '复制绝对路径', '属性']);
});

test('长按菜单（iPhone）：同样的信息行', async t => {
  const { page, tick } = await start(t, { platform: 'ios' });
  rowNamed(page, 'a.txt').dispatch('pointerdown', touch());
  tick(500);
  assert.equal(part(page.menu, 'menu-path').textContent, 'a.txt');
  assert.equal(detail(page), `1.5 KiB · ${FULL}`);
  assert.notEqual(part(page.menu, 'menu-info'), part(page.menu, 'menu-path'));
});

test('Mac 的工具栏不改：换排序不重新声明，仍只有「更多」', async t => {
  const declared = [];
  const ctx = await start(t, { coda: { toolbar: items => declared.push(items) } });
  assert.deepEqual(declared, [[{ id: 'more', label: '更多', icon: 'ellipsis', kind: 'button' }]]);
  await choose(ctx, '日期');
  assert.equal(declared.length, 1);
});

test('iPhone 的 ⋯：再次激活只关闭；开着时 aria-expanded 为真', async t => {
  const ctx = await start(t, { platform: 'ios' });
  const more = ctx.page.bar.find(node => node.getAttribute('aria-label') === '更多')[0];
  ctx.more();
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  ctx.more();
  assert.equal(visible(ctx.page.menu), false);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

// ---- 滚动位置 ----

test('换排序：滚动回到顶部', async t => {
  const ctx = await start(t);
  ctx.page.tree.scrollTop = 77;
  await choose(ctx, '日期');
  assert.equal(ctx.page.tree.scrollTop, 0);
});

test('恢复途中换排序：待恢复的位置作废，不会跳回旧位置', async t => {
  const state = persisted(NAME, { s1: record(120, NAME) });
  const ctx = await start(t, { state, settle: false }); // 目录还没取回，恢复在等
  await choose(ctx, '日期');
  assert.equal(ctx.page.tree.scrollTop, 0);
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
  const ctx = await start(t, { platform: 'mac', state, session: ['s1', '/work/a'] });
  const { page, host } = ctx;
  await choose(ctx, '日期');
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
