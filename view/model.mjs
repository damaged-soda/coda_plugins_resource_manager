// 页面的纯状态：目录树、状态保留。不碰 DOM，请求与代次在 connection.mjs，设计见 docs/design/phase-1.md 第 6、7 节。
import { ErrorCode, RootState, Type } from './protocol.mjs';

export const STATE_LIMIT = 96 * 1024;
export const MAX_PARALLEL = 8;
export const MAX_LOADED = 100_000; // 单个目录已加载条数的上限，同服务端的条目上限
const MAX_LOADED_DIRS = 500;
const HIDDEN = new Set(['.git', '.DS_Store']);
export const isHidden = name => HIDDEN.has(name);
export const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

async function pool(items, limit, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]);
  }));
}

// 根目录不可用时，树页和文件页显示的说明。root 为 null 表示还没收到。
export function noticeText(root, session) {
  if (!root) return '正在读取…';
  if (!session) return '没有打开的会话。';
  return {
    [RootState.NONE]: '这个会话没有可浏览的工作目录。',
    [RootState.PREPARING]: '工作树还在准备，好了会自动显示。',
    [RootState.GONE]: '工作目录已不存在，可能已随归档收回。再发消息会重建，之后自动恢复。',
  }[root.state] ?? '';
}

export class Model {
  session = null;
  root = null; // 收到 root 之前是 null
  dirs = new Map(); // path → { entries, next, loaded, loading, error, token }
  expanded = new Set(); // 不变量：展开的目录，它的每一级上层也展开
  wanted = new Map(); // 恢复状态时各目录要取够的条数，第一次取用后删掉
  selected = null;
  showHidden = false;

  constructor({ link, onChange = () => {} }) { Object.assign(this, { link, onChange }); }

  get ready() { return this.root?.state === RootState.READY; }

  // 模块来的消息统一从这里进。session 带上这个会话保存的状态；返回值同各个处理方法。
  receive(message, saved = null) {
    switch (message.type) {
      case Type.SESSION: return this.onSession(message, saved);
      case Type.ROOT: return this.onRoot(message);
      case Type.CHANGED: return this.onChanged(message);
      case Type.LISTED: case Type.CHUNK: return this.link.receive(message);
    }
  }

  // 换会话：清空一切，展开状态换成这个会话保存的。
  onSession({ generation, session }, saved = null) {
    this.link.reset(generation);
    this.session = session ?? null;
    this.root = null;
    this.dirs = new Map();
    this.wanted = new Map(Object.entries(saved?.loaded ?? {}));
    const paths = (saved?.expanded ?? []).filter(path => path !== '');
    this.expanded = new Set(paths.filter(path => !path.includes('/') || paths.includes(path.slice(0, path.lastIndexOf('/')))));
    this.selected = saved?.selected ?? null;
    this.onChange();
  }

  // 只换根目录状态，不动会话状态；ready 时重新取全部。
  onRoot({ generation, state, path }) {
    if (generation !== this.link.generation) return null;
    this.root = { state, path };
    this.onChange();
    return state === RootState.READY ? this.refresh() : Promise.resolve();
  }

  onChanged({ generation }) {
    return generation === this.link.generation && this.ready ? this.refresh() : null;
  }

  // 重新取根和全部已展开的目录，并行不超过 8 个。
  refresh() {
    if (!this.ready) return Promise.resolve();
    const { generation } = this.link;
    return pool(['', ...this.expanded], MAX_PARALLEL, path => this.#reload(path, generation));
  }

  // 取够已加载的条数，一次替换；同目录有更新的请求就作废这一个。
  async #reload(path, generation) {
    if (this.link.generation !== generation) return; // 排队时会话已换，旧任务不碰新会话
    let dir = this.dirs.get(path);
    if (!dir) this.dirs.set(path, dir = { entries: [], next: null, loaded: false, loading: false, error: null, token: 0, pages: 0 });
    const token = ++dir.token, want = Math.max(dir.entries.length, this.wanted.get(path) ?? 0);
    this.wanted.delete(path);
    dir.loading = true;
    this.onChange();
    const current = () => this.link.generation === generation && this.dirs.get(path) === dir && dir.token === token;
    try {
      const entries = [];
      let next = null, pages = 0;
      do {
        const reply = await this.link.call('list', { path, cursor: next });
        if (this.link.generation !== generation) return; // 回答到了、继续前会话换了，不再取下一页
        entries.push(...reply.entries);
        next = reply.nextCursor ?? null;
        pages++;
      } while (next && entries.length < want);
      if (!current()) return;
      Object.assign(dir, { entries, next, loaded: true, error: null, pages });
    } catch (error) {
      if (error.stale || !current()) return;
      if (error.code === ErrorCode.NOT_FOUND && path !== '') this.#drop(path);
      else if (error.code !== ErrorCode.NO_ROOT) dir.error = { code: error.code, message: error.message };
    } finally {
      if (current()) dir.loading = false;
      this.onChange();
    }
  }

  #drop(path) {
    for (const key of [...this.dirs.keys()]) if (inside(key, path)) this.dirs.delete(key);
    for (const key of [...this.expanded]) if (inside(key, path)) this.expanded.delete(key);
  }

  toggle(path) {
    if (this.expanded.has(path)) {
      for (const key of [...this.expanded]) if (inside(key, path)) this.expanded.delete(key);
      for (const key of [...this.dirs.keys()]) if (key !== '' && inside(key, path)) this.dirs.delete(key);
      this.onChange();
    } else {
      this.expanded.add(path);
      this.retry(path);
    }
  }

  retry(path) { return this.ready ? this.#reload(path, this.link.generation) : Promise.resolve(); }

  // 「再显示」：取下一页接在后面。
  async loadMore(path) {
    const dir = this.dirs.get(path), { generation } = this.link;
    if (!dir?.next || dir.loading || !this.ready) return;
    const token = ++dir.token;
    dir.loading = true;
    this.onChange();
    const current = () => this.link.generation === generation && this.dirs.get(path) === dir && dir.token === token;
    try {
      const reply = await this.link.call('list', { path, cursor: dir.next });
      if (!current()) return;
      dir.entries = dir.entries.concat(reply.entries);
      Object.assign(dir, { next: reply.nextCursor ?? null, error: null, pages: dir.pages + 1 });
    } catch (error) {
      if (!error.stale && current()) dir.error = { code: error.code, message: error.message };
    } finally {
      if (current()) dir.loading = false;
      this.onChange();
    }
  }

  select(path) { this.selected = path; this.onChange(); }
  setShowHidden(on) { this.showHidden = on; this.onChange(); }
  // loaded：取过不止一页的目录已加载的条数，只存条数不存内容；第一页每次都会重新取，不用存。
  snapshot() {
    const loaded = {};
    for (const [path, dir] of this.dirs) if (dir.pages > 1 && dir.entries.length > 0) loaded[path] = dir.entries.length;
    return { expanded: [...this.expanded], selected: this.selected, loaded };
  }
}

// ---- 状态保留：setState 没有会话维度，内部按会话分开 ----

export const byteSize = value => new TextEncoder().encode(JSON.stringify(value)).length;
const depth = path => path.split('/').length;
const strings = (value, max) => (Array.isArray(value) ? value.filter(s => typeof s === 'string' && s.length <= 1024).slice(0, max) : []);

const parseLoaded = raw => Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {})
  .filter(([path, count]) => path.length <= 1024 && Number.isSafeInteger(count) && count > 0 && count <= MAX_LOADED).slice(0, MAX_LOADED_DIRS));

// 读回来的值可能是别的版本或坏的，只认自己的形状。
export function parseState(raw) {
  const state = { v: 1, seq: 0, hidden: false, sessions: {} };
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return state;
  state.hidden = raw.hidden === true;
  state.seq = Number.isSafeInteger(raw.seq) ? raw.seq : 0;
  for (const [id, item] of Object.entries(raw.sessions ?? {})) {
    if (!item || typeof item !== 'object') continue;
    const scroll = item.scroll ?? {}, num = n => (Number.isFinite(n) && n >= 0 ? n : 0);
    state.sessions[id] = {
      at: Number.isSafeInteger(item.at) ? item.at : 0, expanded: strings(item.expanded, 5000),
      selected: typeof item.selected === 'string' && item.selected.length <= 1024 ? item.selected : null,
      scroll: { tree: num(scroll.tree), top: num(scroll.top), left: num(scroll.left) },
    };
    const loaded = parseLoaded(item.loaded);
    if (Object.keys(loaded).length > 0) state.sessions[id].loaded = loaded;
  }
  return state;
}

export function putSession(state, session, record) {
  state.seq++;
  state.sessions[session] = { ...record, at: state.seq };
}

// 总量不超过 limit（序列化后的 UTF-8 字节）：先淘汰最旧的会话，再从深到浅裁当前会话的展开目录，最后兜底清空。不抛。
export function trimState(state, keep, limit = STATE_LIMIT) {
  const next = { ...state, sessions: { ...state.sessions } };
  const fits = () => byteSize(next) <= limit;
  const others = Object.keys(next.sessions).filter(id => id !== keep).sort((a, b) => next.sessions[a].at - next.sessions[b].at);
  for (const id of others) { if (fits()) return next; delete next.sessions[id]; }
  let current = next.sessions[keep];
  if (fits() || !current) return fits() ? next : { ...next, sessions: {} };
  // 条数只影响返回后的滚动落点，比展开状态先舍。
  current = next.sessions[keep] = { ...current, loaded: {} };
  if (fits()) return next;
  // 按层级从浅到深排，取最长的、放得下的前缀；前缀仍然满足「上层也展开」。
  const sorted = [...current.expanded].sort((a, b) => depth(a) - depth(b));
  let low = 0, high = sorted.length;
  const withCount = count => { next.sessions[keep] = { ...current, expanded: sorted.slice(0, count) }; return fits(); };
  while (low < high) { const mid = (low + high + 1) >> 1; if (withCount(mid)) low = mid; else high = mid - 1; }
  if (withCount(low)) return next;
  return { ...next, sessions: {} };
}
