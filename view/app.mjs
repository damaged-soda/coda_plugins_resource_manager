// 资源管理器的页面入口：消息收发、状态保留、工具栏。状态在 model.mjs，渲染在 tree.mjs、preview.mjs 和 info.mjs，菜单和提示在 menu.mjs 和 hint.mjs。
import { EXIT, paintBar } from './bar.mjs';
import { createChat } from './chat.mjs';
import { connect } from './connection.mjs';
import { infoText, sortName } from './format.mjs';
import { mountHint } from './hint.mjs';
import { mountInfo } from './info.mjs';
import { mountMenu } from './menu.mjs';
import { Model, STATE_LIMIT, noticeText, parseState, putSession, trimState } from './model.mjs';
import { showNotice } from './notice.mjs';
import { mountPreview } from './preview.mjs';
import { EntryKind, RootState, SortKey, Type } from './protocol.mjs';
import { mountTree, rootName } from './tree.mjs';

const coda = window.coda;
const $ = id => document.getElementById(id);
const quiet = fn => { try { return fn(); } catch { return undefined; } };
const hasToolbar = typeof coda.toolbar === 'function' && coda.platform === 'mac';
// iPhone 上打开文件推入新视图，树页不进预览模式；selected 只用来高亮，从保存的状态恢复出来也一样。
const isIOS = coda.platform === 'ios';

let persisted = parseState(quiet(() => coda.getState()));
// 恢复出来的滚动位置，等内容到了再用一次。
let pending = { tree: null, preview: null };

const conn = connect(coda, { handlers: { session: onSession, root: onRoot, changed: onChanged }, onStatus: () => schedule() });
const model = new Model({ link: conn.link, onChange: () => schedule() });
model.showHidden = persisted.hidden;
model.sort = persisted.sort;
const hint = mountHint($('hint'));
const menu = mountMenu($('menu'));
const chat = createChat({ link: conn.link, copy: text => coda.copy(text), hint });
const tree = mountTree($('tree'), model, {
  open: openFile,
  toggle: path => model.toggle(path),
  more: path => model.loadMore(path),
  retry: path => model.retry(path),
  menu: (event, row) => pathMenu(event, row),
}, { draggable: !isIOS, longPress: isIOS });
const preview = mountPreview($('preview'), {
  read: (path, offset) => conn.link.call('read', { path, offset }), copy: text => coda.copy(text),
  actions: isIOS ? [] : [{ label: '窗口', icon: 'window', run: openInView }], copyInHead: !isIOS,
  back: isIOS ? null : () => { backPressed = true; model.select(null); },
  // 选中文字的右键菜单只有 Mac：iPhone 用系统的选区菜单。
  selectionMenu: isIOS ? null : (event, selection) => menu.open(event, { items: chat.selectionItems(selection) }),
});
// 属性页：页内一层。有原生返回（coda.back）时返回在客户端的导航里，没有的环境（旧客户端、harness）头部自己放一个。
const nativeBack = typeof coda.back === 'function';
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
const mode = () => (infoOpen ? 'info' : !model.ready ? 'notice' : model.selected !== null && !isIOS ? 'preview' : 'tree');

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
  for (const [id, name] of [['tree', 'tree'], ['preview', 'preview'], ['notice', 'notice'], ['info', 'info']]) {
    $(id).classList.toggle('off', current !== name);
    $(id).inert = current !== name;
  }
  if (current === 'notice') paintNotice();
  tree.render();
  if (current === 'preview' && preview.path !== model.selected) {
    preview.open(model.selected, pending.preview);
    pending.preview = null;
  } else if ((current === 'tree' || current === 'notice') && preview.path !== null) preview.close(); // 属性页和预览一样只切可见性，不动别的面板的内容
  // 返回按钮随预览一起 inert，焦点会掉到页面外：用户刚点了返回、页面又持有焦点时交给目录树。
  // 后台刷新、切会话、root 变化造成的切换不动焦点，免得抢走客户端输入框的焦点。
  if (refocus && current === 'tree') { $('tree').tabIndex = -1; $('tree').focus(); }
  syncToolbar();
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
// iPhone 树页顶部：返回（仅横屏）、根目录名、⋯。刷新、显示隐藏文件和排序都在 ⋯ 的菜单里；属性页上没有 ⋯。
const MORE = { id: 'more', label: '更多', kind: 'button', glyph: 'ellipsis', iconOnly: true, menu: true };
const phoneItems = () => [EXIT, { kind: 'title', label: model.ready ? rootName(model.root.path) : '' }, ...(infoOpen ? [] : [MORE])];
// 比较键就是要画的项：根目录名变了（换会话）工具条跟着重画。
let lastItems = '';
function syncToolbar() {
  const items = isIOS ? phoneItems() : toolbarItems(), key = JSON.stringify(items);
  if (key === lastItems) return;
  lastItems = key;
  if (hasToolbar) return quiet(() => coda.toolbar(items));
  menu.hide(); // 重画会换掉 ⋯ 按钮，开着的菜单认不得新按钮
  paintBar($('bar'), items, act);
  $('bar').hidden = items.length === 0; // 没有项（属性页上的页内工具条）就整条不显示
}

// 原生按钮没有 DOM 元素可以当锚点：用一个固定在页面右上角的假锚点，同时也是「谁打开的菜单」的标记。
const TOOLBAR = { getBoundingClientRect: () => ({ right: window.innerWidth, bottom: 0 }) };
// 「更多」菜单的内容只写这一处，iPhone 的 ⋯ 和 Mac 的原生按钮共用：刷新、显示隐藏文件，分隔线，小标题和平铺的四个排序项。
const moreMenu = () => ({ items: [
  { label: '刷新', run: () => act('refresh') },
  { label: '显示隐藏文件', checked: model.showHidden, run: () => act('hidden') },
  { separator: true },
  { heading: '排序' },
  ...Object.values(SortKey).map(key => ({ label: sortName(key), checked: key === model.sort, radio: true, run: () => changeSort(key) })),
] });

// 换排序：旧的滚动位置对新顺序没有意义，待恢复的作废，回到顶部；排序是全局的，存进 persisted。选当前项什么都不做。
function changeSort(sort) {
  const before = model.sort;
  model.setSort(sort);
  if (model.sort === before) return; // 同值：什么都没换
  persisted.sort = model.sort;
  pending.tree = null;
  tree.scrollTo(0);
}

function act(id, button) {
  // 横屏时导航栏隐藏，属性页的原生返回看不到：这里的「返回」先关属性页，在根层才关视图。
  if (id === EXIT.id) { if (infoOpen) closeInfo(); else quiet(() => coda.close()); }
  else if (id === 'more') {
    // 键盘激活没有 pointerdown，菜单外点击那条规则不管用：同一个按钮再次激活就关闭。
    if (!menu.hidden && menu.opener === button) menu.hide();
    else menu.open(button, moreMenu());
  }
  else if (id === 'hidden') { model.setShowHidden(!model.showHidden); persisted.hidden = model.showHidden; }
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
    scroll: { tree: pending.tree ?? tree.scroll(), top: pending.preview?.top ?? top.top, left: pending.preview?.left ?? top.left, sort: model.sort },
  });
  persisted = trimState(persisted, session);
  // setState 超限会同步抛错：再收紧一次，仍失败就放弃这次，不影响界面。
  if (quiet(() => (coda.setState(persisted), true)) === undefined) quiet(() => coda.setState(trimState(persisted, session, STATE_LIMIT / 4)));
}
quiet(() => coda.on('visibility', visible => { if (!visible) saveNow(); }));
$('tree').addEventListener('scroll', queueSave, { passive: true });
preview.onScroll(queueSave);
preview.onScroll(menu.hide);

// ---- 行菜单：Mac 右键、iPhone 长按；iPhone 的 ⋯ 和 Mac 的原生「更多」出刷新、显示隐藏文件和排序（菜单本身在 menu.mjs）----
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

// ---- 属性页：进入声明原生返回一层，所有关闭的路径（原生返回、页内返回、横屏的返回、换会话、根目录变化）都重新声明回根层 ----
function openInfo(row) {
  infoOpen = true;
  info.open(row.path, row);
  if (nativeBack) quiet(() => coda.back(['资源管理器']));
  schedule();
}
function closeInfo() {
  if (!infoOpen) return;
  infoOpen = false;
  info.close(); // 在统计的一并取消
  if (nativeBack) quiet(() => coda.back([]));
  schedule();
}
// steps 是退几级，属性页只有一级，不论几都回到目录树；已经不在属性页时也重新声明一次根层。
quiet(() => coda.on('back', () => {
  if (infoOpen) closeInfo();
  else if (nativeBack) quiet(() => coda.back([]));
}));

// ---- 模块的消息（代次和握手由 connection 处理）----
function onSession(data) {
  saveNow(); // 先存旧会话
  preview.close();
  closeInfo();
  menu.hide();
  tree.reset();
  epoch++;
  opening = false;
  clearTimeout(unlockTimer);
  hint.hide();
  const saved = persisted.sessions[data.session] ?? null;
  // 目录树的滚动位置是按当时的排序存的；排序是全局的，在别的会话换过就对不上，等内容到了回到顶部。
  pending = saved ? { tree: saved.scroll.sort === model.sort ? saved.scroll.tree : 0, preview: { top: saved.scroll.top, left: saved.scroll.left } } : { tree: null, preview: null };
  model.receive(data, saved);
}

function onRoot(data) {
  const before = model.root;
  if (data.state !== RootState.READY || before?.path !== data.path) closeInfo(); // 属性页看的是旧根目录下的路径
  const done = model.receive(data);
  if (done && data.state === RootState.READY) {
    if (before?.path !== data.path) preview.reload(); else preview.refresh();
    const { generation } = conn.link;
    done.then(() => {
      if (conn.link.generation !== generation || pending.tree === null) return;
      tree.scrollTo(pending.tree);
      pending.tree = null;
    });
  }
}

function onChanged(data) {
  if (!model.receive(data)) return;
  dataRound++;
  preview.refresh();
  info.refresh();
}

tree.remeasure();
quiet(() => coda.on('theme', () => tree.remeasure()));
render();
conn.hello();
