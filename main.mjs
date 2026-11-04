// 资源管理器的模块：跟踪侧栏的会话、代次和根目录，把页面的请求交给 lib/*，把变化推给页面。
// 协议见 docs/design/phase-1.md 第 6 节，消息格式见 view/protocol.mjs。
import { listDirectory } from './lib/tree.mjs';
import { readChunk } from './lib/content.mjs';
import { NO_ROOT, queryRoot, sameRoot } from './lib/root.mjs';
import {
  ErrorCode, MESSAGE_LIMIT, REQUEST_ID_MAX, RootState, Type, fail, messageSize,
} from './view/protocol.mjs';

const POLL_MS = 2000;

export function activate(coda) {
  coda.views.register('files', { open: view => serve(coda, view) });
}

const validRequestId = id => (typeof id === 'string' && id.length <= REQUEST_ID_MAX) || Number.isSafeInteger(id);
const errorOf = error => (error?.protocol ? { code: error.code, message: error.message } : { code: ErrorCode.IO, message: '读取失败' });

function serve(coda, view) {
  // 代次：每换一次会话加 1，所有异步出口回来后都要核对。
  const s = {
    session: view.context.session ?? null, generation: 1, root: NO_ROOT, sent: null,
    hello: false, closed: false, rootSeq: 0, poll: null,
  };
  const turns = new Map();
  const stale = generation => s.closed || generation !== s.generation;

  function post(message) {
    if (s.closed) return;
    if (messageSize(message) > MESSAGE_LIMIT) {
      // 兜底：各模块自己守着上限，到这里说明有遗漏；有请求号的换成错误，其余丢弃。
      if (message.requestId === undefined) return;
      const { type, generation, requestId } = message;
      message = { type, generation, requestId, error: { code: ErrorCode.TOO_LARGE, message: '回答超过消息上限' } };
    }
    try { view.postMessage(message); } catch { /* 视图已关 */ }
  }

  const postSession = () => post({ type: Type.SESSION, generation: s.generation, session: s.session });
  function postRoot() {
    s.sent = s.root;
    post({ type: Type.ROOT, generation: s.generation, state: s.root.state, path: s.root.path });
  }

  // 重新查询根目录。结果和上次推给页面的不同才推送；查询失败保留上一次的。
  // 被后发的查询取代的，结果丢掉，由后发的那个去推。
  async function refreshRoot() {
    const { generation } = s, seq = ++s.rootSeq;
    let next = null;
    try { next = await queryRoot(coda, s.session); } catch { /* 保留上一次 */ }
    if (stale(generation) || seq !== s.rootSeq) return;
    if (next) s.root = next;
    syncPoll();
    if (s.hello && !sameRoot(s.sent, s.root)) postRoot();
  }

  const stopPoll = () => { if (s.poll) clearTimeout(s.poll.handle); s.poll = null; };
  // 只有当前代次、没关闭、状态是 preparing 时才挂着一个计时器。
  function syncPoll() {
    if (s.closed || !s.session || s.root.state !== RootState.PREPARING) return stopPoll();
    if (s.poll?.generation === s.generation) return;
    stopPoll();
    const { generation } = s;
    const poll = { generation, handle: setTimeout(() => {
      if (s.poll === poll) s.poll = null;
      if (!stale(generation)) refreshRoot();
    }, POLL_MS) };
    s.poll = poll;
  }

  function switchSession(session) {
    stopPoll();
    s.session = session ?? null;
    s.generation++;
    s.root = NO_ROOT;
    s.sent = null;
    if (s.hello) postSession();
    refreshRoot();
  }

  async function request(message) {
    const { type, generation, requestId } = message;
    if (stale(generation) || !validRequestId(requestId)) return;
    const reply = type === Type.LIST ? Type.LISTED : Type.CHUNK;
    try {
      if (s.root.state !== RootState.READY) throw fail(ErrorCode.NO_ROOT, '没有可浏览的工作目录');
      const body = type === Type.LIST
        ? await listDirectory(s.root.path, message.path, message.cursor)
        : await readChunk(s.root.path, message.path, message.offset);
      if (!stale(generation)) post({ type: reply, generation, requestId, ...body });
    } catch (error) {
      if (!stale(generation)) post({ type: reply, generation, requestId, error: errorOf(error) });
    }
  }

  view.onMessage(async message => {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      // 页面（重新）就绪：它什么都不知道，所以不管有没有变，下一次查询的结果都要推。
      case Type.HELLO: s.hello = true; s.sent = null; postSession(); return refreshRoot();
      case Type.REFRESH: return stale(message.generation) ? undefined : refreshRoot();
      case Type.LIST: case Type.READ: return request(message);
    }
  });

  view.onContext(context => {
    const session = context?.session ?? null;
    if (session !== s.session) switchSession(session);
  });

  // 这个会话一轮开始或结束：根目录先更新；结束时再通知页面重新取。
  const watching = Promise.resolve(coda.watch('threads', ({ type, id, object }) => {
    const before = turns.get(id), after = type === 'DELETED' ? undefined : object?.turn ?? null;
    if (after === undefined) turns.delete(id); else turns.set(id, after);
    if (s.closed || id !== s.session || before === undefined || after === undefined || before === after) return;
    const { generation } = s;
    const refreshed = refreshRoot();
    if (before) refreshed.then(() => { if (s.hello && !stale(generation)) post({ type: Type.CHANGED, generation }); });
  })).catch(() => null);

  view.onClose(async () => {
    s.closed = true;
    stopPoll();
    try { await (await watching)?.dispose(); } catch { /* 已经取消 */ }
  });

  refreshRoot();
}
