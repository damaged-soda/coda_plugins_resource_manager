// 树页的脚本化假模块：目录内容由 listing 给（键是目录路径，名字以 / 结尾的是目录），
// 条目也可以直接写成 { name, kind, link }；list 可以按路径让它失败（host.failing）；记下 coda.open、coda.copy 的调用。
// back：true 时 coda 有 back（原生返回），声明过的路径记在 calls.back；客户端的事件（back、toolbar……）记在 host.events，测试自己触发。
// host.requests(type) 等微任务把消息投出去，再取发出的这种请求；host.answer(请求, 回答内容) 按请求的类型回答，回答内容可以是 { error }。
import { ReplyOf } from '../../view/protocol.mjs';
import { loadApp } from './dom.mjs';
import { flush } from './fake.mjs';

export async function openTree(t, { platform = 'ios', listing = { '': ['a.txt', 'b.txt'] }, state, coda = {}, back = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], calls = { open: [], copy: [], back: [] }, events = {};
  const host = { sent, calls, events, listing, failing: new Set(), generation: 0, openResult: undefined, lists: () => sent.filter(m => m.type === 'list') };
  let page;
  const answer = request => {
    if (request.generation !== host.generation) return;
    const base = { generation: host.generation, requestId: request.requestId };
    if (host.failing.has(request.path)) return page.post({ type: 'listed', ...base, error: { code: 'io_error', message: '读不了这个目录' } });
    const entries = (host.listing[request.path] ?? []).map(name => typeof name === 'object' ? name : ({ name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'dir' : 'file' }));
    page.post({ type: 'listed', ...base, entries, nextCursor: null });
  };
  page = await loadApp(t, {
    platform,
    postMessage: message => { sent.push(message); if (message.type === 'list') queueMicrotask(() => answer(message)); },
    on: (name, fn) => { events[name] = fn; },
    ...(back ? { back: titles => calls.back.push(titles) } : {}),
    copy: text => calls.copy.push(text),
    getState: () => state,
    setState: () => {},
    open: args => { calls.open.push(args); return host.openResult?.(); },
    close: () => { calls.close = (calls.close ?? 0) + 1; },
    ...coda,
  });
  host.session = (id = 's1', path = '/A') => { host.generation++; page.post({ type: 'session', generation: host.generation, session: id }); page.post({ type: 'root', generation: host.generation, state: 'ready', path }); };
  host.requests = async type => { await flush(); return sent.filter(m => m.type === type); };
  host.answer = (request, body) => page.post({ type: ReplyOf[request.type], generation: request.generation, requestId: request.requestId, ...body });
  host.changed = () => page.post({ type: 'changed', generation: host.generation });
  return { page, host, tick: ms => t.mock.timers.tick(ms) };
}

export const rowsOf = page => page.tree.find(node => node.classList.contains('row'));
export const rowNamed = (page, text) => rowsOf(page).find(node => node.textContent.includes(text));
export const sectionOf = page => page.tree.find(node => node.classList.contains('section'))[0];
