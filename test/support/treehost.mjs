// 树页的脚本化假模块：目录内容由 listing 给（键是目录路径，名字以 / 结尾的是目录），
// list 可以按路径让它失败（host.failing）；记下 coda.open、coda.copy 的调用。
import { loadApp } from './dom.mjs';

export async function openTree(t, { platform = 'ios', listing = { '': ['a.txt', 'b.txt'] }, state } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], calls = { open: [], copy: [] };
  const host = { sent, calls, listing, failing: new Set(), generation: 0, openResult: undefined, lists: () => sent.filter(m => m.type === 'list') };
  let page;
  const answer = request => {
    if (request.generation !== host.generation) return;
    const base = { generation: host.generation, requestId: request.requestId };
    if (host.failing.has(request.path)) return page.post({ type: 'listed', ...base, error: { code: 'io_error', message: '读不了这个目录' } });
    const entries = (host.listing[request.path] ?? []).map(name => ({ name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'dir' : 'file' }));
    page.post({ type: 'listed', ...base, entries, nextCursor: null });
  };
  page = await loadApp(t, {
    platform,
    postMessage: message => { sent.push(message); if (message.type === 'list') queueMicrotask(() => answer(message)); },
    on: () => {},
    copy: text => calls.copy.push(text),
    getState: () => state,
    setState: () => {},
    open: args => { calls.open.push(args); return host.openResult?.(); },
    close: () => {},
  });
  host.session = (id = 's1') => { host.generation++; page.post({ type: 'session', generation: host.generation, session: id }); page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/A' }); };
  host.changed = () => page.post({ type: 'changed', generation: host.generation });
  return { page, host, tick: ms => t.mock.timers.tick(ms) };
}

export const rowsOf = page => page.tree.find(node => node.classList.contains('row'));
export const rowNamed = (page, text) => rowsOf(page).find(node => node.textContent.includes(text));
