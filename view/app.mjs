// 资源管理器的页面入口：消息收发、状态保留、工具栏。状态在 model.mjs，渲染在 tree.mjs 和 preview.mjs。
import { EXIT, paintBar } from './bar.mjs';
import { connect } from './connection.mjs';
import { icon } from './icons.mjs';
import { Model, STATE_LIMIT, noticeText, parseState, putSession, trimState } from './model.mjs';
import { showNotice } from './notice.mjs';
import { mountPreview } from './preview.mjs';
import { RootState } from './protocol.mjs';
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
const tree = mountTree($('tree'), model, {
  open: openFile,
  toggle: path => model.toggle(path),
  more: path => model.loadMore(path),
  retry: path => model.retry(path),
  menu: (event, path) => pathMenu(event, path),
}, { draggable: !isIOS, longPress: isIOS });
const preview = mountPreview($('preview'), {
  read: (path, offset) => conn.link.call('read', { path, offset }), copy: text => coda.copy(text),
  actions: isIOS ? [] : [{ label: '窗口', icon: 'window', run: openInView }], copyInHead: !isIOS,
});

// ---- 在独立视图里打开：iPhone 点文件，Mac 预览头部的「窗口」 ----
// 会话 ID 放进 args：被打开的视图 context.session 是 null。失败（含同步抛出）在原地提示。
let hintTimer = null;
function showHint(text) {
  $('hint').textContent = text;
  $('hint').hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { $('hint').hidden = true; }, 5000);
}
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
      $('hint').hidden = true;
      if (isIOS) { clearTimeout(unlockTimer); unlockTimer = setTimeout(() => { opening = false; }, REOPEN_MS); }
    }, error => {
      if (mine !== epoch) return;
      opening = false;
      showHint(`打不开文件：${error?.message ?? '未知原因'}`);
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

const mode = () => (!model.ready ? 'notice' : model.selected !== null && !isIOS ? 'preview' : 'tree');

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
  for (const [id, name] of [['tree', 'tree'], ['preview', 'preview'], ['notice', 'notice']]) {
    $(id).classList.toggle('off', current !== name);
    $(id).inert = current !== name;
  }
  if (current === 'notice') paintNotice();
  tree.render();
  if (current === 'preview' && preview.path !== model.selected) {
    preview.open(model.selected, pending.preview);
    pending.preview = null;
  } else if (current !== 'preview' && preview.path !== null) preview.close();
  syncToolbar(current);
}

// ---- 工具栏：Mac 用 coda.toolbar，没有的（iOS）退成页内一条 ----
const toolbarItems = current => [
  ...(current === 'preview' ? [{ id: 'back', label: '返回', icon: 'chevron.left', kind: 'button' }] : []),
  { id: 'refresh', label: '刷新', icon: 'arrow.clockwise', kind: 'button' },
  { id: 'hidden', label: '显示隐藏文件', icon: 'eye', kind: 'toggle', on: model.showHidden },
];
// iPhone 树页顶部：返回（仅横屏）、根目录名、⋯。刷新和显示隐藏文件在 ⋯ 的菜单里。
const MORE = { id: 'more', label: '更多', kind: 'button', glyph: 'ellipsis', iconOnly: true, menu: true };
const phoneItems = () => [EXIT, { kind: 'title', label: model.ready ? rootName(model.root.path) : '' }, MORE];
// 比较键就是要画的项：根目录名变了（换会话）工具条跟着重画。
let lastItems = '';
function syncToolbar(current) {
  const items = isIOS ? phoneItems() : toolbarItems(current), key = JSON.stringify(items);
  if (key === lastItems) return;
  lastItems = key;
  if (hasToolbar) return quiet(() => coda.toolbar(items));
  hideMenu(); // 重画会换掉 ⋯ 按钮，开着的菜单认不得新按钮
  paintBar($('bar'), items, act);
}

function act(id, button) {
  if (id === EXIT.id) quiet(() => coda.close());
  else if (id === 'more') {
    // 键盘激活没有 pointerdown，菜单外点击那条规则不管用：同一个按钮再次激活就关闭。
    if (!menu.hidden && opener === button) hideMenu();
    else openMenu(button, { items: [
      { label: '刷新', run: () => act('refresh') },
      { label: '显示隐藏文件', checked: model.showHidden, run: () => act('hidden') },
    ] });
  }
  else if (id === 'back') model.select(null);
  else if (id === 'hidden') { model.setShowHidden(!model.showHidden); persisted.hidden = model.showHidden; }
  else if (id === 'refresh') {
    conn.refresh();
    model.refresh();
    preview.refresh();
  }
}
quiet(() => coda.on('toolbar', ({ id }) => act(id)));

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
    scroll: { tree: pending.tree ?? tree.scroll(), top: pending.preview?.top ?? top.top, left: pending.preview?.left ?? top.left },
  });
  persisted = trimState(persisted, session);
  // setState 超限会同步抛错：再收紧一次，仍失败就放弃这次，不影响界面。
  if (quiet(() => (coda.setState(persisted), true)) === undefined) quiet(() => coda.setState(trimState(persisted, session, STATE_LIMIT / 4)));
}
quiet(() => coda.on('visibility', visible => { if (!visible) saveNow(); }));
$('tree').addEventListener('scroll', queueSave, { passive: true });
preview.onScroll(queueSave);

// ---- 菜单：Mac 右键、iPhone 长按出复制路径，iPhone 的 ⋯ 出刷新和显示隐藏文件 ----
// anchor：按钮元素（菜单贴在它下面、右对齐）或 { clientX, clientY } 的点。items：[{ label, run, checked? }]，
// checked 不是 undefined 的是带对勾的开关项。title 写在菜单顶上：iPhone 没有 title 悬停，长文件名在行里被截断，这里看全。
// 位置按安全区夹住（横屏时客户端不替页面留）；offsetWidth 在显示后才量得到。
const menu = $('menu');
let opener = null; // 打开菜单的按钮；用点打开的没有
function openMenu(anchor, { title, items }) {
  hideMenu();
  const head = title === undefined ? [] : [Object.assign(document.createElement('p'), { className: 'menu-path secondary', textContent: title })];
  const checkable = items.some(item => item.checked !== undefined); // 有开关项时，每一项都留出对勾的位置，文字才对齐
  menu.replaceChildren(...head, ...items.map(({ label, run, checked }) => {
    const button = document.createElement('button'), name = document.createElement('span');
    name.textContent = label;
    if (checkable) {
      const mark = document.createElement('span');
      mark.className = 'check';
      if (checked) mark.append(icon('check', 16));
      button.append(mark);
    }
    button.append(name);
    button.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
    button.addEventListener('click', () => { run(); hideMenu(); });
    return button;
  }));
  menu.hidden = false;
  const box = anchor.getBoundingClientRect?.();
  const x = box ? box.right - menu.offsetWidth : anchor.clientX, y = box ? box.bottom + 4 : anchor.clientY;
  menu.style.left = `max(var(--safe-left), min(${x}px, calc(100vw - var(--safe-right) - ${menu.offsetWidth + 4}px)))`;
  menu.style.top = `max(var(--safe-top), min(${y}px, calc(100vh - var(--safe-bottom) - ${menu.offsetHeight + 4}px)))`;
  if (box) { opener = anchor; opener.setAttribute('aria-expanded', 'true'); }
}
const pathMenu = (event, path) => openMenu(event, { title: path, items: [
  { label: '复制相对路径', run: () => coda.copy(path) },
  { label: '复制绝对路径', run: () => coda.copy(`${model.root.path}/${path}`) },
] });
function hideMenu() {
  menu.hidden = true;
  opener?.setAttribute('aria-expanded', 'false');
  opener = null;
}
// 菜单开着时点菜单外：只关菜单，紧接着的那次点击不交给树。
let menuDismissed = false;
document.addEventListener('pointerdown', event => {
  menuDismissed = !menu.hidden && !menu.contains(event.target);
  if (!menu.contains(event.target)) hideMenu();
}, true);
document.addEventListener('click', event => {
  if (menuDismissed) { menuDismissed = false; event.stopPropagation(); }
}, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);
$('tree').addEventListener('scroll', hideMenu, { passive: true });

// ---- 模块的消息（代次和握手由 connection 处理）----
function onSession(data) {
  saveNow(); // 先存旧会话
  preview.close();
  hideMenu();
  tree.reset();
  epoch++;
  opening = false;
  clearTimeout(unlockTimer);
  clearTimeout(hintTimer);
  $('hint').hidden = true;
  const saved = persisted.sessions[data.session] ?? null;
  pending = saved ? { tree: saved.scroll.tree, preview: { top: saved.scroll.top, left: saved.scroll.left } } : { tree: null, preview: null };
  model.receive(data, saved);
}

function onRoot(data) {
  const before = model.root;
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
  if (model.receive(data)) preview.refresh();
}

tree.remeasure();
quiet(() => coda.on('theme', () => tree.remeasure()));
render();
conn.hello();
