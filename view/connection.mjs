// 页面到模块的连接：请求与回答（Link）、hello 握手与超时、按代次分发协议消息。
// 树页和文件页共用。只管连接：树的 Model、状态保存、提示文案和 DOM 都在各自的页面里。
import { ErrorCode, Type } from './protocol.mjs';

export const TIMEOUT_MS = 30_000;

// 会话已经换了，请求作废。调用方一律吞掉，不显示。
export class Stale extends Error { constructor() { super('已过期'); this.stale = true; } }
export class RequestError extends Error { constructor(code, message) { super(message); this.code = code; } }

// 请求与回答按 requestId 对应。回答要代次相同、请求号还在等待才算；换会话时 reset 作废所有等待并停掉超时。
export class Link {
  generation = null;
  pending = new Map();
  #next = 1;

  constructor({ post, timers = globalThis, timeoutMs = TIMEOUT_MS }) {
    Object.assign(this, { post, timers, timeoutMs });
  }

  reset(generation) {
    this.generation = generation;
    for (const entry of this.pending.values()) { this.timers.clearTimeout(entry.timer); entry.reject(new Stale()); }
    this.pending.clear();
  }

  call(type, fields) {
    if (this.generation === null) return Promise.reject(new Stale());
    const { generation } = this, requestId = `q${this.#next++}`;
    return new Promise((resolve, reject) => {
      const settle = error => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        this.timers.clearTimeout(entry.timer);
        reject(error);
      };
      const timer = this.timers.setTimeout(() => settle(new RequestError('timeout', '30 秒没有回答')), this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      Promise.resolve().then(() => this.post({ type, generation, requestId, ...fields }))
        .catch(() => settle(new RequestError(ErrorCode.IO, '消息发不出去')));
    });
  }

  receive(message) {
    if (message.generation !== this.generation) return false;
    const entry = this.pending.get(message.requestId);
    if (!entry) return false;
    this.pending.delete(message.requestId);
    this.timers.clearTimeout(entry.timer);
    if (message.error) entry.reject(new RequestError(message.error.code, message.error.message));
    else entry.resolve(message);
    return true;
  }
}

// 建立连接并开始监听模块的消息；调用 hello() 才发出握手。
// handlers：session、root、changed。session 先作废旧代次的请求再交给页面；
// root、changed 只在代次等于当前时才交出；listed、chunk 直接对应请求，页面不用管。
// 握手的结束条件是收到首个 root；之后不再提示超时。
// onStatus：握手状态变了（开始、失败、重试）时调用，页面据此重画说明。
export function connect(coda, { handlers, onStatus = () => {} }) {
  const link = new Link({ post: message => coda.postMessage(message) });
  let answered = false, timer = null, failure = null;

  function fail(reason) {
    if (answered) return;
    clearTimeout(timer);
    failure = reason;
    onStatus();
  }

  window.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case Type.SESSION:
        link.reset(data.generation);
        return handlers.session(data);
      case Type.ROOT: case Type.CHANGED:
        if (data.generation !== link.generation) return;
        if (data.type === Type.ROOT) { // 首个 root 才算模块回答了：只收到 session 时页面还是空的，照样要提示
          answered = true;
          clearTimeout(timer);
          failure = null;
        }
        return handlers[data.type](data);
      case Type.LISTED: case Type.CHUNK:
        link.receive(data);
    }
  });

  return {
    link,
    // 握手失败的原因，没有失败时为 null。
    get failure() { return failure; },
    async hello() {
      clearTimeout(timer);
      failure = null;
      timer = setTimeout(() => fail('30 秒没有收到回答'), TIMEOUT_MS);
      onStatus();
      try { await coda.postMessage({ type: Type.HELLO }); } catch { fail('消息发不出去'); }
    },
    // 用户手动刷新：让模块先重新查询根目录。还没有代次（没收到 session）时无事可做。
    refresh() {
      if (link.generation === null) return;
      try { Promise.resolve(coda.postMessage({ type: Type.REFRESH, generation: link.generation })).catch(() => {}); } catch { /* 宿主不可用 */ }
    },
  };
}
