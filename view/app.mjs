// 资源管理器的页面入口：消息收发、状态保留、工具栏和「更多」菜单、图标视图的进入和返回。状态在 model.mjs，渲染在 tree.mjs、grid.mjs、preview.mjs 和 info.mjs，菜单和提示在 menu.mjs 和 hint.mjs，滚动位置的恢复在 restore.mjs。
import { EXIT, paintBar } from './bar.mjs';
import { createChat } from './chat.mjs';
import { connect } from './connection.mjs';
import { infoText, sortName } from './format.mjs';
import { mountGrid } from './grid.mjs';
import { mountHint } from './hint.mjs';
import { mountInfo } from './info.mjs';
import { mountMenu } from './menu.mjs';
import { Model, STATE_LIMIT, View, noticeText, parseState, putSession, trimState } from './model.mjs';
import { showNotice } from './notice.mjs';
import { mountPreview } from './preview.mjs';
import { EntryKind, RootState, SortKey, Type } from './protocol.mjs';
import { createRestore, createTrail } from './restore.mjs';
import { mountTree, rootName } from './tree.mjs';

const coda = window.coda;
const $ = id => document.getElementById(id);
const quiet = fn => { try { return fn(); } catch { return undefined; } };
const hasToolbar = typeof coda.toolbar === 'function' && coda.platform === 'mac';
// iPhone 上打开文件推入新视图，树页不进预览模式；selected 只用来高亮，从保存的状态恢复出来也一样。
const isIOS = coda.platform === 'ios';

let persisted = parseState(quiet(() => coda.getState()));
// 恢复出来的预览滚动位置，等内容到了再用一次。目录树和图标视图的在 restore 里。
let pending = { preview: null };

const conn = connect(coda, { handlers: { session: onSession, root: onRoot, changed: onChanged }, onStatus: () => schedule() });
const model = new Model({ link: conn.link, onChange: () => schedule(), onLost: () => hint.show('文件夹已不存在', { warn: false }) });
model.showHidden = persisted.hidden;
model.sort = persisted.sort;
model.view = persisted.view;
const hint = mountHint($('hint'));
const menu = mountMenu($('menu'), $('submenu'), { flyout: !isIOS }); // Mac 的二级菜单在左边弹出，iPhone 在菜单里切到下一层
const chat = createChat({ link: conn.link, copy: text => coda.copy(text), hint });
// 属性页和图标视图的上一层：iPhone 用原生返回（coda.back）；Mac 的客户端会替声明了返回的页面画一个带小箭头的导航，
// 和侧栏标题重复，所以 Mac 和没有 coda.back 的环境一样，头部最左边自己放返回。
const nativeBack = isIOS && typeof coda.back === 'function';
const tree = mountTree($('tree'), model, {
  open: openFile,
  toggle: path => model.toggle(path),
  more: path => model.loadMore(path),
  retry: path => model.retry(path),
  menu: (event, row) => pathMenu(event, row),
}, { draggable: !isIOS, longPress: isIOS });
const grid = mountGrid($('grid'), model, {
  open: openFile,
  enter: path => enterDir(path),
  more: path => model.loadMore(path),
  retry: path => model.retry(path),
  menu: (event, cell) => pathMenu(event, cell),
  back: nativeBack ? null : () => leaveDir(),
}, { draggable: !isIOS, longPress: isIOS });
const restore = createRestore(model, { tree, grid });
const trail = createTrail();
const preview = mountPreview($('preview'), {
  read: (path, offset) => conn.link.call('read', { path, offset }), copy: text => coda.copy(text),
  actions: isIOS ? [] : [{ label: '窗口', icon: 'window', run: openInView }], copyInHead: !isIOS,
  back: isIOS ? null : () => { backPressed = true; model.select(null); },
  // 选中文字的右键菜单只有 Mac：iPhone 用系统的选区菜单。
  selectionMenu: isIOS ? null : (event, selection) => menu.open(event, { items: chat.selectionItems(selection) }),
});
// 属性页：页内一层。
let infoOpen = false;
let dataRound = 0; // 数据轮次：每收到一次 changed 加一，属性页用它判断文件夹的统计结果是不是上一轮的
const info = mountInfo($('info'), {
  stat: path => conn.link.call(Type.STAT, { path }),
  size: (path, signal) => conn.link.call(Type.DIR_SIZE, { path }, { signal, cancel: Type.DIR_SIZE_CANCEL }),
  rootPath: () => model.root?.path ?? '',
  round: () => dataRound,
  back: nativeBack ? null : () => { backPressed = true; closeInfo(); },
});

// ---- 在独立视图里打开：iPhone 点文件，Mac 预览头部的「窗口」 ----
// 会话 ID 放进 args：被打开的视图 context.session 是 null。失败（含同步抛出）在原地提示。
// iPhone 防连点：open 进行中、成功后推入动画的这一小段都忽略重复点击；失败立刻放开。
// epoch 每换一次会话加一：旧会话的 open 结果回来时已经作废，不碰新会话的提示和防连点。
let opening = false, unlockTimer = null, epoch = 0;
const REOPEN_MS = 1000;
function openInView(path) {
  if (isIOS) opening = true;
  const mine = epoch;
  return Promise.resolve().then(() => coda.open({ view: 'file', args: { session: model.session, path } }))
    .then(() => {
      if (mine !== epoch) return;
      hint.hide();
      if (isIOS) { clearTimeout(unlockTimer); unlockTimer = setTimeout(() => { opening = false; }, REOPEN_MS); }
    }, error => {
      if (mine !== epoch) return;
      opening = false;
      hint.show(`打不开文件：${error?.message ?? '未知原因'}`);
    });
}
function openFile(path) {
  if (isIOS && opening) return; // 先于 select 和保存：被忽略的点击什么都不改
  model.select(path);
  if (!isIOS) return;
  saveNow(); // 视图随即卸载，这一刻的展开状态、条数和滚动位置先存下
  openInView(path);
}

// ---- 渲染：同一批变化合并成一次 ----
let queued = false;
function schedule() {
  queueSave();
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
}

// 用户点了预览头部的返回：render 据此决定焦点要不要交给目录树，别的模式变化不动焦点。
let backPressed = false;
const mode = () => (infoOpen ? 'info' : !model.ready ? 'notice' : model.selected !== null && !isIOS ? 'preview' : model.view === View.ICONS ? 'grid' : 'tree');

// 说明区只在内容变了才重画，免得重试按钮在点击中途被换掉。
let noticeKey = null;
function paintNotice() {
  const failed = conn.failure !== null && !model.root;
  const key = failed ? `hello:${conn.failure}` : noticeText(model.root, model.session);
  if (key === noticeKey) return;
  noticeKey = key;
  showNotice($('notice'), failed ? { failure: conn.failure, retry: conn.hello } : { text: key });
}

function render() {
  const current = mode();
  const refocus = backPressed && document.hasFocus();
  backPressed = false;
  for (const id of ['tree', 'grid', 'preview', 'notice', 'info']) {
    $(id).classList.toggle('off', current !== id);
    $(id).inert = current !== id;
  }
  if (current === 'notice') paintNotice();
  const browsing = current === 'tree' || current === 'grid';
  (model.view === View.ICONS ? grid : tree).render(); // 只画正在用的视图，另一个留着它的内容和滚动位置
  landed();
  restore.settle();
  if (current === 'preview' && preview.path !== model.selected) {
    preview.open(model.selected, pending.preview);
    pending.preview = null;
  } else if ((browsing || current === 'notice') && preview.path !== null) preview.close(); // 属性页和预览一样只切可见性，不动别的面板的内容
  // 返回按钮随预览一起 inert，焦点会掉到页面外：用户刚点了返回、页面又持有焦点时交给目录树或网格。
  // 后台刷新、切会话、root 变化造成的切换不动焦点，免得抢走客户端输入框的焦点。
  if (refocus && browsing) { $(current).tabIndex = -1; $(current).focus(); }
  syncToolbar();
  declareBack();
}

// ---- 工具栏：Mac 用 coda.toolbar，没有的（iOS、harness）退成页内一条 ----
// Mac 只有一个原生按钮「更多」：原生菜单带向下的箭头，关不掉，所以按下后由页面弹菜单。返回键在预览头部，不在这里。
// 属性页上排序、刷新、显示隐藏文件都没有意义：工具栏不放任何项，退出属性页后恢复。
const toolbarItems = () => infoOpen ? [] : hasToolbar
  ? [{ id: 'more', label: '更多', icon: 'ellipsis', kind: 'button' }]
  : [
    { id: 'refresh', label: '刷新', icon: 'arrow.clockwise', kind: 'button' },
    { id: 'hidden', label: '显示隐藏文件', icon: 'eye', kind: 'toggle', on: model.showHidden },
  ];
// iPhone 树页顶部：返回（仅横屏）、根目录名、⋯。刷新、显示隐藏文件和排序都在 ⋯ 的菜单里。
// 属性页上只留返回：竖屏有原生导航栏，整条工具条不显示；横屏导航栏隐藏，页面自己给返回（显示与否都由 style.css 的横屏媒体查询决定）。
const MORE = { id: 'more', label: '更多', kind: 'button', glyph: 'ellipsis', iconOnly: true, menu: true };
const phoneItems = () => infoOpen ? [EXIT] : [EXIT, { kind: 'title', label: model.ready ? dirTitle() : '' }, MORE];
// 比较键就是要画的项：根目录名变了（换会话）工具条跟着重画。
let lastItems = '';
function syncToolbar() {
  const items = isIOS ? phoneItems() : toolbarItems(), key = JSON.stringify(items);
  if (key === lastItems) return;
  lastItems = key;
  if (hasToolbar) return quiet(() => coda.toolbar(items));
  menu.hide(); // 重画会换掉 ⋯ 按钮，开着的菜单认不得新按钮
  paintBar($('bar'), items, act);
  $('bar').hidden = items.length === 0; // 没有项（Mac 属性页上的页内工具条）就整条不显示
  $('bar').classList.toggle('exit-only', items.length === 1 && items[0].id === EXIT.id); // 只有返回的工具条跟着返回走：竖屏整条不显示
}

// 原生按钮没有 DOM 元素可以当锚点：用一个固定在页面右上角的假锚点，同时也是「谁打开的菜单」的标记。
const TOOLBAR = { getBoundingClientRect: () => ({ right: window.innerWidth, bottom: 0 }) };
// 「更多」菜单的内容只写这一处，iPhone 的 ⋯ 和 Mac 的原生按钮共用：刷新、显示隐藏文件、「显示」›；「显示」里是视图和排序，当前项有对勾。
const moreMenu = () => ({ items: [
  { label: '刷新', run: () => act('refresh') },
  { label: '显示隐藏文件', checked: model.showHidden, run: () => act('hidden') },
  { label: '显示', submenu: { items: [
    { heading: '视图' },
    { label: '列表', checked: model.view === View.LIST, radio: true, run: () => changeView(View.LIST) },
    { label: '图标', checked: model.view === View.ICONS, radio: true, run: () => changeView(View.ICONS) },
    { separator: true },
    { heading: '排序' },
    ...Object.values(SortKey).map(key => ({ label: sortName(key), checked: key === model.sort, radio: true, run: () => changeSort(key) })),
  ] } },
] });

// 显示的条目或顺序变了、或者换了根目录：旧的滚动位置对不上，待恢复的和上层的记录作废，两种视图都回到顶部。换排序、显示隐藏文件、换根目录都走这里。
function invalidateScroll() {
  restore.clear();
  trail.clear();
  tree.scrollTo(0);
  grid.scrollTo(0);
}

// 换排序：全局的，存进 persisted。选当前项什么都不做。
function changeSort(sort) {
  const before = model.sort;
  model.setSort(sort);
  if (model.sort === before) return; // 同值：什么都没换
  persisted.sort = model.sort;
  invalidateScroll();
}

// 换视图：全局一份，存进 persisted；两种视图各留着自己的内容和滚动位置，换回来还在。
// 「显示」菜单调用它。
function changeView(view) {
  const before = model.view;
  model.setView(view);
  if (model.view === before) return;
  persisted.view = model.view;
  menu.hide();
  declareBack();
  schedule();
}

function act(id, button) {
  // 横屏时导航栏隐藏，原生返回看不到：这里的「返回」和原生返回走同一个退层逻辑，在根层才关视图。
  if (id === EXIT.id) { if (goBack(1)) backPressed = true; else quiet(() => coda.close()); }
  else if (id === 'more') {
    // 键盘激活没有 pointerdown，菜单外点击那条规则不管用：同一个按钮再次激活就关闭。
    if (!menu.hidden && menu.opener === button) menu.hide();
    else menu.open(button, moreMenu());
  }
  else if (id === 'hidden') {
    model.setShowHidden(!model.showHidden);
    persisted.hidden = model.showHidden;
    invalidateScroll(); // 不管在哪种视图切换：显示的条目变了，两种视图的旧位置都对不上
  }
  else if (id === 'refresh') {
    conn.refresh();
    model.refresh();
    preview.refresh();
  }
}
// 原生按钮的事件是 { id }：只认 more，别的什么都不做。
quiet(() => coda.on('toolbar', event => { if (event?.id === 'more' && !infoOpen) act('more', TOOLBAR); })); // 属性页上原生按钮已撤掉，迟到的事件不弹菜单

// ---- 状态保留 ----
let saveTimer = null;
function queueSave() {
  if (model.session && saveTimer === null) saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const { session } = model;
  if (!session) return;
  const top = preview.scroll();
  putSession(persisted, session, {
    ...model.snapshot(),
    // 还没恢复的位置先存它，别存成还没滚过去的 0。
    scroll: { tree: restore.top('tree') ?? tree.scroll(), top: pending.preview?.top ?? top.top, left: pending.preview?.left ?? top.left, sort: model.sort,
      grid: restore.top('grid') ?? grid.scroll(), gridSort: model.sort },
  });
  persisted = trimState(persisted, session);
  // setState 超限会同步抛错：再收紧一次，仍失败就放弃这次，不影响界面。
  if (quiet(() => (coda.setState(persisted), true)) === undefined) quiet(() => coda.setState(trimState(persisted, session, STATE_LIMIT / 4)));
}
quiet(() => coda.on('visibility', visible => { if (!visible) saveNow(); }));
$('tree').addEventListener('scroll', queueSave, { passive: true });
$('tree').addEventListener('scroll', () => restore.scrolled('tree'), { passive: true });
grid.onScroll(queueSave);
grid.onScroll(() => restore.scrolled('grid'));
preview.onScroll(queueSave);
preview.onScroll(menu.hide);

// ---- 行菜单：Mac 右键、iPhone 长按；iPhone 的 ⋯ 和 Mac 的原生「更多」出刷新、显示隐藏文件和「显示」（视图、排序）（菜单本身在 menu.mjs）----
// 行菜单顶上是路径，下面一行 大小 · 完整修改时间（文件夹只有修改时间，读不到就没有这一行）；指向外面的链接和不能打开的条目没有元数据，不显示这一行。
// 不能打开的条目（指向外面或失效的链接、other）没有「添加到聊天」，和不能拖动一致；它们仍有复制路径和属性。
function pathMenu(event, row) {
  const dead = row.kind === EntryKind.LINK || row.kind === EntryKind.OTHER;
  menu.open(event, { title: row.path, detail: dead ? undefined : infoText(row) || undefined, items: [
    ...(dead ? [] : [{ label: '添加到聊天', run: () => chat.add(row.path) }]),
    { label: '复制相对路径', run: () => coda.copy(row.path) },
    { label: '复制绝对路径', run: () => coda.copy(`${model.root.path}/${row.path}`) },
    { separator: true },
    { label: '属性', run: () => openInfo(row) },
  ] });
}
$('tree').addEventListener('scroll', menu.hide, { passive: true });
grid.onScroll(menu.hide);

// ---- 图标视图的进入和返回 ----
// 进入子目录滚到顶部，先记下上层的位置；回上一层恢复进去之前的位置（记录在内存里，页面卸载后没有，回到顶部）。
// shownCwd：页面已经处理过的 cwd；它被模型自己换掉（目录没了退到上一层、根目录变了回到根目录）时，在 landed 里补上滚动。
let shownCwd = '';
function enterDir(path) {
  trail.remember(model.cwd, grid.scroll());
  model.enter(path);
  shownCwd = model.cwd;
  restore.drop('grid');
  grid.scrollTo(0);
  declareBack();
}
// 退 levels 层（到根为止）；已经在根目录返回 false。
function leaveDir(levels = 1) {
  if (model.cwd === '') return false;
  model.leave(levels);
  land(trail.take(model.cwd) ?? 0);
  declareBack();
  return true;
}
function land(top) {
  shownCwd = model.cwd;
  grid.scrollTo(0); // 先回到顶部：之后的滚动都是内容变化或用户滚的，恢复据此判断用户有没有动过
  restore.plan('grid', top);
}
// 落到哪一层就用哪一层的位置，失效目录待恢复的位置作废。
function landed() {
  if (model.cwd !== shownCwd) land(trail.take(model.cwd) ?? 0);
}

// ---- 上一层：iPhone 用原生返回，路径只在这里声明 ----
// 路径是上层的标题，由远到近，不含当前页：图标视图在 a/b 是 [根目录名, 'a']；列表视图没有。属性页多一层当前页：列表视图是 '资源管理器'，图标视图是当前目录名。
// 标题是当前目录名：根目录是根目录名。
const dirTitle = () => (model.cwd === '' || model.view !== View.ICONS ? rootName(model.root.path) : model.cwd.slice(model.cwd.lastIndexOf('/') + 1));
function backPath() {
  const icons = model.view === View.ICONS && model.ready;
  const upper = icons && model.cwd !== '' ? [rootName(model.root.path), ...model.cwd.split('/').slice(0, -1)] : [];
  return infoOpen ? [...upper, icons ? dirTitle() : '资源管理器'] : upper;
}
let declared = [];
// 路径没变不重复声明；force：客户端已经退了一层，路径没变也要重新告诉它现在在哪。
function declareBack(force = false) {
  if (!nativeBack) return;
  const path = backPath();
  if (!force && JSON.stringify(path) === JSON.stringify(declared)) return;
  declared = path;
  quiet(() => coda.back(path));
}
// 退 steps 层：先关属性页，再退图标视图的目录；返回是不是真的退了。横屏的返回和原生返回共用。
function goBack(steps) {
  let used = 0;
  if (infoOpen && steps > used) { closeInfo(); used++; }
  const levels = Math.min(steps - used, model.view === View.ICONS && model.cwd !== '' ? model.cwd.split('/').length : 0);
  if (levels > 0) { leaveDir(levels); used += levels; }
  return used > 0;
}
if (nativeBack) quiet(() => coda.on('back', event => {
  if (!goBack(Number.isInteger(event?.steps) && event.steps > 0 ? event.steps : 1)) declareBack(true); // 已经在最上层：重新声明一次
}));

// ---- 属性页：所有关闭的路径（原生返回、横屏的返回、换会话、根目录变化）都重新声明回上层 ----
function openInfo(row) {
  infoOpen = true;
  info.open(row.path, row);
  declareBack();
  schedule();
}
function closeInfo() {
  if (!infoOpen) return;
  infoOpen = false;
  info.close(); // 在统计的一并取消
  declareBack();
  schedule();
}

// ---- 模块的消息（代次和握手由 connection 处理）----
function onSession(data) {
  saveNow(); // 先存旧会话
  preview.close();
  closeInfo();
  menu.hide();
  tree.reset();
  grid.reset();
  epoch++;
  opening = false;
  clearTimeout(unlockTimer);
  hint.hide();
  const saved = persisted.sessions[data.session] ?? null;
  pending = { preview: saved ? { top: saved.scroll.top, left: saved.scroll.left } : null };
  model.receive(data, saved);
  trail.clear();
  restore.clear();
  // 两种视图的滚动位置各按当时的排序存；排序是全局的，在别的会话换过就对不上，等内容到了回到顶部。恢复绑定这个会话、根目录、排序和目录。
  tree.scrollTo(0);
  restore.plan('tree', saved && saved.scroll.sort === model.sort ? saved.scroll.tree : 0);
  shownCwd = model.cwd;
  land(saved && saved.scroll.gridSort === model.sort ? saved.scroll.grid : 0);
}

function onRoot(data) {
  const before = model.root;
  if (data.state !== before?.state || data.path !== before?.path) menu.hide(); // 开着的菜单里的路径是旧根目录下的
  if (data.state !== RootState.READY || before?.path !== data.path) closeInfo(); // 属性页看的是旧根目录下的路径
  const scope = model.scope;
  const done = model.receive(data);
  if (model.scope !== scope) invalidateScroll(); // 换了根目录（同根重建不算）：旧根目录的位置和记录不能给新的用
  if (done && data.state === RootState.READY) {
    if (before?.path !== data.path) preview.reload(); else preview.refresh();
  }
}

function onChanged(data) {
  if (!model.receive(data)) return;
  menu.hide(); // 开着的菜单可能指着已经删除的路径
  dataRound++;
  preview.refresh();
  info.refresh();
}

const remeasure = () => { tree.remeasure(); grid.remeasure(); };
remeasure();
quiet(() => coda.on('theme', remeasure));
render();
conn.hello();
