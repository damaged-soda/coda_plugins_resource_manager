// 预览头部和 iPhone 文件页的底部工具条：真实的 file-app.mjs 和 preview.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';

const MIB = 1024 * 1024;
// files：路径 → { kind, text, size?, mtimeMs? }；size 省略就是正文的字节数。
const timersOn = new WeakSet();
async function open(t, { path, files, platform = 'ios', coda = {} }) {
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
const start = async (t, options) => {
  const ctx = await open(t, options);
  ctx.host.start();
  await flush();
  return ctx;
};
const named = (root, label) => root.find(node => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? node.textContent) === label)[0];
const meta = page => page.preview.find(node => node.classList.contains('pmeta'))[0];
const head = page => page.preview.find(node => node.classList.contains('phead'))[0];
const bar = page => page.bar.find(node => node.tagName === 'BUTTON').map(node => node.getAttribute('aria-label') ?? node.textContent);

test('元信息 目录 · 行数 · 大小：子目录里的文本文件', async t => {
  const { page } = await start(t, { path: 'lib/a.txt', files: { 'lib/a.txt': { text: `${'一行\n'.repeat(26)}`, size: 1434 } } });
  assert.equal(meta(page).textContent, 'lib · 26 行 · 1.4 KiB');
  assert.match(meta(page).title, /^修改于 /, '修改时间放进 title');
});

test('元信息：根目录下的文件省略目录；多级目录写全；不带换行的最后一行也算一行', async t => {
  const root = await start(t, { path: 'f.txt', files: { 'f.txt': { text: 'abc' } } });
  assert.equal(meta(root.page).textContent, '1 行 · 3 B');
  const deep = await start(t, { path: 'a/b/c.txt', files: { 'a/b/c.txt': { text: 'x\ny' } } });
  assert.equal(meta(deep.page).textContent, 'a/b · 2 行 · 3 B');
});

test('元信息：非文本没有行数；二进制的说明区仍写修改时间', async t => {
  const { page } = await start(t, { path: 'bin/x.dat', files: { 'bin/x.dat': { kind: 'binary', size: 2048, mtimeMs: 0 } } });
  assert.equal(meta(page).textContent, 'bin · 2.0 KiB');
  assert.match(page.preview.textContent, /二进制文件，不预览。2\.0 KiB，修改于 /);
  const image = await start(t, { path: 'logo.png', files: { 'logo.png': { kind: 'image', text: 'png', size: 3 } } });
  assert.equal(meta(image.page).textContent, '3 B', '根目录的图片只有大小');
});

test('元信息：截断时写明只显示前 1.0 MiB，行数是显示出来的行数', async t => {
  const { page } = await start(t, { path: 'big.log', files: { 'big.log': { text: 'a\nb\nc\n', size: 2 * MIB } } });
  assert.equal(meta(page).textContent, '3 行 · 2.0 MiB · 只显示前 1.0 MiB');
});

test('元信息：更新失败占用这一行，原因进 title；恢复后复原，修改时间的 title 还在', async t => {
  const { page, host } = await start(t, { path: 'lib/a.txt', files: { 'lib/a.txt': { text: 'x' } } });
  const normal = meta(page).textContent, time = meta(page).title;
  host.failRead = { code: 'denied', message: '没有读取权限' };
  host.changed();
  await flush();
  assert.equal(meta(page).textContent, '更新失败：没有读取权限');
  assert.equal(meta(page).title, '没有读取权限');
  host.failRead = null;
  named(page.preview, '重试').dispatch('click');
  await flush();
  assert.equal(meta(page).textContent, normal);
  assert.equal(meta(page).title, time);
  assert.equal(named(page.preview, '重试').textContent, '重试', '「重试」保持文字');
});

test('头部：文件图标按扩展名选；名字是路径末段，title 是完整路径', async t => {
  const { page } = await start(t, { path: 'src/main.mjs', files: { 'src/main.mjs': { text: 'x' } } });
  const mark = head(page).find(node => node.classList.contains('pico'))[0];
  assert.equal(mark.getAttribute('aria-hidden'), 'true');
  assert.equal(mark.find(node => node.tagName === 'SVG').length, 1);
  const name = head(page).find(node => node.classList.contains('pname'))[0];
  assert.equal(name.textContent, 'main.mjs');
  assert.equal(name.title, 'src/main.mjs');
});

test('Mac 的文件视图（有 coda.toolbar）：头部的「复制路径」是图标按钮，有 aria-label 和 title，点了复制路径', async t => {
  const toolbar = [];
  const { page, host } = await start(t, { path: 'lib/a.txt', platform: 'mac', files: { 'lib/a.txt': { text: 'x' } }, coda: { toolbar: items => toolbar.push(items) } });
  const copy = named(head(page), '复制路径');
  assert.ok(copy.classList.contains('icon'));
  assert.equal(copy.textContent, '');
  assert.equal(copy.title, '复制路径');
  assert.equal(copy.find(node => node.tagName === 'SVG').length, 1);
  copy.dispatch('click');
  assert.deepEqual(host.copied, ['lib/a.txt']);
  assert.equal(visible(page.bar), false, 'Mac 的工具条是原生的');
  assert.deepEqual(toolbar.at(-1), [{ id: 'refresh', label: '刷新', icon: 'arrow.clockwise', kind: 'button' }]);
});

test('iPhone 的文件视图：头部没有「复制路径」，底部工具条是 返回、刷新、复制路径（图标加文字）', async t => {
  const { page, host } = await start(t, { path: 'lib/a.txt', files: { 'lib/a.txt': { text: 'x' } } });
  assert.equal(named(head(page), '复制路径'), undefined);
  assert.deepEqual(bar(page), ['返回', '刷新', '复制路径']);
  assert.ok(page.bar.find(node => node.tagName === 'BUTTON').every(node => node.find(n => n.tagName === 'SVG').length === 1));
  assert.ok(page.bar.find(node => node.tagName === 'BUTTON')[0].classList.contains('exit'), '返回只在横屏显示');

  named(page.bar, '复制路径').dispatch('click');
  assert.deepEqual(host.copied, ['lib/a.txt']);
  const reads = host.sent.filter(m => m.type === 'read').length;
  named(page.bar, '刷新').dispatch('click');
  await flush();
  assert.equal(host.sent.filter(m => m.type === 'refresh').length, 1);
  assert.ok(host.sent.filter(m => m.type === 'read').length > reads, '刷新重读文件');
  named(page.bar, '返回').dispatch('click');
  assert.equal(host.closed, 1);
});

test('iPhone 的文件视图：说明区下底部工具条照样能用，复制的是启动值里的路径', async t => {
  const { page, host } = await start(t, { path: 'lib/a.txt', files: { 'lib/a.txt': { text: 'x' } } });
  host.gone();
  await flush();
  assert.match(page.notice.textContent, /工作目录已不存在/);
  assert.ok(visible(page.bar) && !page.bar.inert, '工具条不在 inert 的面板里');
  named(page.bar, '复制路径').dispatch('click');
  assert.deepEqual(host.copied, ['lib/a.txt']);
  named(page.bar, '刷新').dispatch('click');
  assert.equal(host.sent.filter(m => m.type === 'refresh').length, 1);
  named(page.bar, '返回').dispatch('click');
  assert.equal(host.closed, 1);
});

test('没有指定路径时复制路径什么都不做；非 iPhone 非 Mac（harness）只有一条文字刷新，复制在头部', async t => {
  const none = await start(t, { path: null, files: {} });
  named(none.page.bar, '复制路径').dispatch('click');
  assert.deepEqual(none.host.copied, []);
  const web = await start(t, { path: 'f.txt', platform: 'web', files: { 'f.txt': { text: 'x' } } });
  assert.deepEqual(bar(web.page), ['刷新']);
  assert.ok(named(head(web.page), '复制路径'));
});

test('说明区加了图标：没有会话和连不上都有，文字照旧', async t => {
  const { page } = await open(t, { path: 'f.txt', files: {} });
  await flush();
  assert.equal(page.notice.find(node => node.classList.contains('notice-icon')).length, 1);
  assert.equal(page.notice.textContent, '正在读取…');
});
