// 页面状态层的测试支架：手动回答的传输，和接真实模块的传输。
import { Link } from '../../view/connection.mjs';
import { Model } from '../../view/model.mjs';
import { flush } from './fake.mjs';

export function fakeTimers() {
  let id = 0;
  const map = new Map();
  return {
    setTimeout: fn => { map.set(++id, fn); return id; },
    clearTimeout: handle => { map.delete(handle); },
    fire: () => { for (const [handle, fn] of [...map]) { map.delete(handle); fn(); } },
    count: () => map.size,
  };
}

// 目录页的回答内容：以 / 结尾的是目录。
export const entries = (names, nextCursor = null) => ({
  entries: names.map(name => ({ name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'dir' : 'file' })), nextCursor,
});

// 手动传输：页面发出的消息记在 sent 里，测试自己决定回答什么、什么时候回答。
export function manual(modelOptions = {}) {
  const sent = [], timers = fakeTimers();
  const link = new Link({ post: message => sent.push(message), timers });
  const model = new Model({ link, ...modelOptions });
  const t = {
    sent, timers, link, model,
    session: (generation, session, saved) => model.receive({ type: 'session', generation, session }, saved),
    root: (generation, state = 'ready', path = '/r') => model.receive({ type: 'root', generation, state, path }),
    // 等微任务把消息投出去，再取发出的 list 请求。
    lists: async path => { await flush(); return sent.filter(m => m.type === 'list' && (path === undefined || m.path === path)); },
    reply: (request, body) => model.receive({
      type: request.type === 'list' ? 'listed' : 'chunk', generation: request.generation, requestId: request.requestId, ...body,
    }),
    fail: (request, code, message = code) => t.reply(request, { error: { code, message } }),
  };
  return t;
}

// 真实模块 + 真实页面状态层：模块推出的消息异步送给 model.receive，页面的请求交给模块。
export function connected(fake, session) {
  const view = fake.open(session);
  const link = new Link({ post: message => view.send(message) });
  const model = new Model({ link });
  view.listen(message => queueMicrotask(() => model.receive(message)));
  view.send({ type: 'hello' });
  return { model, link, view };
}
