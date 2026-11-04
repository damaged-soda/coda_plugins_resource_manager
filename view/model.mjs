// 页面的纯状态：目录树、状态保留。不碰 DOM，请求与代次在 connection.mjs，设计见 docs/design/phase-1.md 第 6、7 节。
import { DEFAULT_SORT, ErrorCode, RootState, Type, parseSort } from './protocol.mjs';

export const STATE_LIMIT = 96 * 1024;
export const MAX_PARALLEL = 8;
export const MAX_LOADED = 100_000; // 读回保存的条数时认的上界（view 侧校验用），与服务端的条目上限各自独立
// 恢复时每个目录最多取够这么多条（约 10 页）：#reload 串行取够才显示，条数太大返回后会等很久。
// 只管「按保存的条数恢复」，用户已经翻出来的条数不受限；也和 lib/tree.mjs 的目录上限无关。
export const RESTORE_LIMIT = 20_000;
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
  sort = { ...DEFAULT_SORT }; // 全局一份，由页面存进 persisted
  #round = 0; // refresh 的轮次：新一轮开始后，旧一轮不再派发排队的目录

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
    this.#round++;
    this.session = session ?? null;
    this.root = null;
    this.dirs = new Map();
    this.wanted = new Map(Object.entries(saved?.loaded ?? {}).map(([path, count]) => [path, Math.min(count, RESTORE_LIMIT)]));
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

  // 重新取根和全部已展开的目录，并行不超过 8 个。cap：这一轮每个目录最多取够这么多条（换排序时用）。
  // 每一轮带递增的轮次：只查 current() 不够，旧一轮的池子还会启动排队中的目录，递增它们的 token，作废较新的加载。
  refresh({ cap = Infinity } = {}) {
    if (!this.ready) return Promise.resolve();
    const { generation } = this.link, round = ++this.#round;
    return pool(['', ...this.expanded], MAX_PARALLEL, path => (round === this.#round ? this.#reload(path, generation, { cap }) : undefined));
  }

  // 换排序：已加载的目录按新顺序重新取，取够现在的条数，这次最多 RESTORE_LIMIT 条；每个目录一次替换。
  setSort(sort) {
    const next = parseSort(sort);
    if (!next || (next.key === this.sort.key && next.desc === this.sort.desc)) return Promise.resolve();
    this.sort = next;
    this.onChange();
    return this.refresh({ cap: RESTORE_LIMIT });
  }

  // 取够已加载的条数，一次替换；同目录有更新的请求就作废这一个。一次加载固定一种排序。
  // more、expired：「再显示」遇到游标过期转过来时，条数要比现在多一条，而且已经算重取过一次，不再重取。
  async #reload(path, generation, { cap = Infinity, more = false, expired = false } = {}) {
    if (this.link.generation !== generation) return; // 排队时会话已换，旧任务不碰新会话
    let dir = this.dirs.get(path);
    if (!dir) this.dirs.set(path, dir = { entries: [], next: null, loaded: false, loading: false, error: null, token: 0, pages: 0, sortFallback: false });
    const token = ++dir.token, { sort } = this;
    const want = more ? dir.entries.length + 1 : Math.min(Math.max(dir.entries.length, this.wanted.get(path) ?? 0), cap);
    dir.loading = true;
    this.onChange();
    const current = () => this.link.generation === generation && this.dirs.get(path) === dir && dir.token === token;
    try {
      let entries = [], next = null, pages = 0, sortFallback = false;
      do {
        let reply;
        try {
          reply = await this.link.call('list', { path, cursor: next, sort });
        } catch (error) {
          // 游标过期（快照被淘汰、释放，或根目录变了）：丢掉这一轮累积的，从第一页重取一次，再失败走失败行。
          if (error.code !== ErrorCode.CURSOR_EXPIRED || expired || !current()) throw error;
          expired = true;
          entries = []; next = null; pages = 0; sortFallback = false;
          continue;
        }
        if (!current()) return; // 回答到了、继续前会话换了或有更新的加载，不再取下一页
        if (pages === 0) sortFallback = reply.sortFallback === true;
        entries.push(...reply.entries);
        next = reply.nextCursor ?? null;
        pages++;
      } while (pages === 0 || (next && entries.length < want));
      if (!current()) return;
      Object.assign(dir, { entries, next, loaded: true, error: null, pages, sortFallback });
      this.wanted.delete(path); // 成功后才删：取页失败后重试还要取够保存的条数
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
      const reply = await this.link.call('list', { path, cursor: dir.next, sort: this.sort });
      if (!current()) return;
      dir.entries = dir.entries.concat(reply.entries);
      Object.assign(dir, { next: reply.nextCursor ?? null, error: null, pages: dir.pages + 1 });
    } catch (error) {
      if (error.stale || !current()) return;
      // 游标过期：从第一页重取，条数比现在多一条，所以还会接着往下取。重取自己管 loading。
      if (error.code === ErrorCode.CURSOR_EXPIRED) return this.#reload(path, generation, { more: true, expired: true });
      dir.error = { code: error.code, message: error.message };
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
  const state = { v: 1, seq: 0, hidden: false, sort: { ...DEFAULT_SORT }, sessions: {} };
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return state;
  state.hidden = raw.hidden === true;
  state.sort = parseSort(raw.sort) ?? { ...DEFAULT_SORT };
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
