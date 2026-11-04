// 资源管理器的页面入口：消息收发、状态保留、工具栏。状态在 model.mjs，渲染在 tree.mjs 和 preview.mjs。
import { Link, Model, STATE_LIMIT, parseState, putSession, trimState } from './model.mjs';
import { mountPreview } from './preview.mjs';
import { RootState, Type } from './protocol.mjs';
import { mountTree } from './tree.mjs';

const coda = window.coda;
const $ = id => document.getElementById(id);
const quiet = fn => { try { return fn(); } catch { return undefined; } };
const hasToolbar = typeof coda.toolbar === 'function' && coda.platform === 'mac';

let persisted = parseState(quiet(() => coda.getState()));
// 恢复出来的滚动位置，等内容到了再用一次。
let pending = { tree: null, preview: null };

const link = new Link({ post: message => coda.postMessage(message) });
const model = new Model({ link, onChange: () => schedule() });
model.showHidden = persisted.hidden;
const tree = mountTree($('tree'), model, {
  open: path => model.select(path),
  toggle: path => model.toggle(path),
  more: path => model.loadMore(path),
  retry: path => model.retry(path),
  menu: (event, path) => showMenu(event, path),
});
const preview = mountPreview($('preview'), { read: (path, offset) => link.call('read', { path, offset }), copy: text => coda.copy(text) });

// ---- 渲染：同一批变化合并成一次 ----
let queued = false;
function schedule() {
  queueSave();
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
}

const mode = () => (!model.ready ? 'notice' : model.selected !== null ? 'preview' : 'tree');

function noticeText() {
  const root = model.root;
  if (!root) return '正在读取…';
  if (!model.session) return '没有打开的会话。';
  return {
    [RootState.NONE]: '这个会话没有可浏览的工作目录。',
    [RootState.PREPARING]: '工作树还在准备，好了会自动显示。',
    [RootState.GONE]: '工作目录已不存在，可能已随归档收回。再发消息会重建，之后自动恢复。',
  }[root.state] ?? '';
}

function render() {
  const current = mode();
  for (const [id, name] of [['tree', 'tree'], ['preview', 'preview'], ['notice', 'notice']]) {
    $(id).classList.toggle('off', current !== name);
    $(id).inert = current !== name;
  }
  if (current === 'notice') $('notice').textContent = noticeText();
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
  $('bar').hidden = false;
  $('bar').replaceChildren(...items.map(item => {
    const button = document.createElement('button');
    button.textContent = item.label;
    button.setAttribute('aria-pressed', item.kind === 'toggle' ? String(item.on) : 'false');
    if (item.on) button.classList.add('on');
    button.addEventListener('click', () => act(item.id));
    return button;
  }));
}

function act(id) {
  if (id === 'back') model.select(null);
  else if (id === 'hidden') { model.setShowHidden(!model.showHidden); persisted.hidden = model.showHidden; }
  else if (id === 'refresh') {
    if (link.generation !== null) Promise.resolve(quiet(() => coda.postMessage({ type: Type.REFRESH, generation: link.generation }))).catch(() => {});
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

// ---- 模块的消息 ----
window.addEventListener('message', ({ data }) => {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case Type.SESSION: {
      saveNow(); // 先存旧会话
      preview.close();
      hideMenu();
      const saved = persisted.sessions[data.session] ?? null;
      pending = saved ? { tree: saved.scroll.tree, preview: { top: saved.scroll.top, left: saved.scroll.left } } : { tree: null, preview: null };
      model.receive(data, saved);
      return;
    }
    case Type.ROOT: {
      const done = model.receive(data);
      if (done && data.state === RootState.READY) {
        preview.refresh();
        const { generation } = link;
        done.then(() => {
          if (link.generation !== generation || pending.tree === null) return;
          tree.scrollTo(pending.tree);
          pending.tree = null;
        });
      }
      return;
    }
    case Type.CHANGED:
      if (model.receive(data)) preview.refresh();
      return;
    case Type.LISTED: case Type.CHUNK:
      model.receive(data);
  }
});

tree.remeasure();
quiet(() => coda.on('theme', () => tree.remeasure()));
render();
Promise.resolve(quiet(() => coda.postMessage({ type: Type.HELLO }))).catch(() => {});
