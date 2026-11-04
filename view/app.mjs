// 资源管理器的页面入口：消息收发、状态保留、工具栏。状态在 model.mjs，渲染在 tree.mjs 和 preview.mjs。
import { EXIT, paintBar } from './bar.mjs';
import { connect } from './connection.mjs';
import { Model, STATE_LIMIT, noticeText, parseState, putSession, trimState } from './model.mjs';
import { mountPreview } from './preview.mjs';
import { RootState } from './protocol.mjs';
import { mountTree } from './tree.mjs';

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
  menu: (event, path) => showMenu(event, path),
}, { draggable: !isIOS });
const preview = mountPreview($('preview'), {
  read: (path, offset) => conn.link.call('read', { path, offset }), copy: text => coda.copy(text),
  actions: isIOS ? [] : [{ label: '窗口', run: openInView }],
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
function openInView(path) {
  return Promise.resolve().then(() => coda.open({ view: 'file', args: { session: model.session, path } }))
    .then(() => { $('hint').hidden = true; }, error => showHint(`打不开文件：${error?.message ?? '未知原因'}`));
}
function openFile(path) {
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
  if (!failed) { $('notice').textContent = key; return; }
  const retry = document.createElement('button'), title = document.createElement('p'), reason = document.createElement('p');
  title.textContent = '没有连上资源管理器的后台';
  reason.className = 'secondary';
  reason.textContent = conn.failure;
  retry.className = 'link';
  retry.textContent = '重试';
  retry.addEventListener('click', conn.hello);
  $('notice').replaceChildren(title, reason, retry);
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
let lastItems = '';
function syncToolbar(current) {
  const items = toolbarItems(current), key = JSON.stringify(items);
  if (key === lastItems) return;
  lastItems = key;
  if (hasToolbar) return quiet(() => coda.toolbar(items));
  paintBar($('bar'), isIOS ? [EXIT, ...items] : items, act);
}

function act(id) {
  if (id === EXIT.id) quiet(() => coda.close());
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

// ---- 复制路径的右键菜单 ----
const menu = $('menu');
function showMenu(event, path) {
  const entries = [['复制相对路径', path], ['复制绝对路径', `${model.root.path}/${path}`]];
  menu.replaceChildren(...entries.map(([label, text]) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => { coda.copy(text); hideMenu(); });
    return button;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight - 4))}px`;
}
const hideMenu = () => { menu.hidden = true; };
document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) hideMenu(); }, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);
$('tree').addEventListener('scroll', hideMenu, { passive: true });

// ---- 模块的消息（代次和握手由 connection 处理）----
function onSession(data) {
  saveNow(); // 先存旧会话
  preview.close();
  hideMenu();
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
