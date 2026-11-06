// 文件页（iPhone 或 Mac 窗口）的测试台：真实的 file-app.mjs 和预览，配假 DOM 和脚本化的假宿主。
import { loadFileApp } from './dom.mjs';
import { flush } from './fake.mjs';

// files：路径 → { kind, text, size?, mtimeMs? }；size 省略就是正文的字节数。
const timersOn = new WeakSet();
export async function open(t, { path, files, platform = 'ios', coda = {} }) {
  const sent = [], copied = [], events = {}, host = { files, failRead: null, closed: 0, copied, events };
  let generation = 0, page;
  const answer = request => {
    if (request.generation !== generation) return;
    const base = { generation, requestId: request.requestId };
    if (host.failRead) return page.post({ type: 'chunk', ...base, error: host.failRead });
    const file = host.files[request.path];
    if (!file) return page.post({ type: 'chunk', ...base, error: { code: 'not_found', message: '没有这个文件' } });
    const data = Buffer.from(file.text ?? '');
    page.post({ type: 'chunk', ...base, data: data.toString('base64'), offset: 0, size: file.size ?? data.length, mtimeMs: file.mtimeMs ?? 1, kind: file.kind ?? 'text', eof: true });
  };
  if (!timersOn.has(t)) { timersOn.add(t); t.mock.timers.enable({ apis: ['setTimeout'] }); }
  page = await loadFileApp(t, {
    platform, args: { session: 's1', path },
    postMessage: message => { sent.push(message); if (message.type === 'read') queueMicrotask(() => answer(message)); },
    on: (name, fn) => { events[name] = fn; }, copy: text => copied.push(text), getState: () => undefined, setState: () => {},
    close: () => { host.closed++; }, ...coda,
  });
  Object.assign(host, {
    sent,
    start(rootPath = '/A') { generation++; page.post({ type: 'session', generation, session: 's1' }); page.post({ type: 'root', generation, state: 'ready', path: rootPath }); },
    gone() { page.post({ type: 'root', generation, state: 'gone', path: '/A' }); },
    changed() { page.post({ type: 'changed', generation }); },
  });
  return { page, host };
}
export const start = async (t, options) => {
  const ctx = await open(t, options);
  ctx.host.start();
  await flush();
  return ctx;
};
