// 预览头部和文件视图的工具条：真实的 file-app.mjs 和 preview.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open, start } from './support/filepage.mjs';

const MIB = 1024 * 1024;
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

test('iPhone 上别的入口打开的文件视图：没有工具条，正文照常显示，头部有「复制路径」，没有报错', async t => {
  const { page, host } = await start(t, { path: 'lib/a.txt', platform: 'ios', files: { 'lib/a.txt': { text: 'x' } } });
  assert.ok(visible(page.preview));
  assert.equal(page.preview.find(node => node.classList.contains('text'))[0].textContent, 'x');
  assert.equal(page.bar.hidden, true, '底部工具条已删');
  assert.deepEqual(bar(page), []);
  named(head(page), '复制路径').dispatch('click');
  assert.deepEqual(host.copied, ['lib/a.txt']);
});

test('没有指定路径时说明区写「没有指定要打开的文件」；非 iPhone 非 Mac（harness）只有一条文字刷新，复制在头部', async t => {
  const none = await start(t, { path: null, files: {} });
  assert.match(none.page.notice.textContent, /没有指定要打开的文件/);
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

test('文件页（独立窗口和 iPhone）头部没有「返回」按钮', async t => {
  const files = { 'f.txt': { text: 'x' } };
  const mac = await start(t, { path: 'f.txt', platform: 'mac', files, coda: { toolbar: () => {} } });
  assert.equal(named(head(mac.page), '返回'), undefined);
  const ios = await start(t, { path: 'f.txt', platform: 'ios', files });
  assert.equal(named(head(ios.page), '返回'), undefined);
});
