// 目录树的行内容：图标、箭头、尾标、分区标题，和标题不影响可见行的计算。真实的 app.mjs 和 tree.mjs，配假 DOM。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, rowNamed, sectionNameOf, sectionOf } from './support/treehost.mjs';
import { iconFor, icon } from '../view/icons.mjs';

const svgOf = node => node.find(child => child.tagName === 'SVG')[0];
const part = (node, cls) => node.find(child => child.classList.contains(cls))[0];
const listing = {
  '': ['src/', 'a.txt', 'main.mjs', 'logo.PNG', { name: 'to-file', kind: 'file', link: true }, { name: 'gone', kind: 'link' }, { name: 'dev', kind: 'other' }],
  src: ['x.js'],
};
const start = async (t, options) => {
  const ctx = await openTree(t, { listing, ...options });
  ctx.host.session();
  await flush();
  return ctx;
};

test('iconFor：目录、链接、其他按种类；文件按扩展名，不分大小写；没有匹配的是文档', () => {
  const file = name => iconFor({ kind: 'file', name });
  assert.equal(iconFor({ kind: 'dir', name: 'a.png' }), 'folder');
  assert.equal(iconFor({ kind: 'link', name: 'a.js' }), 'link');
  assert.equal(iconFor({ kind: 'other', name: 'a.js' }), 'other');
  assert.equal(file('main.mjs'), 'code');
  assert.equal(file('LOGO.PNG'), 'image');
  assert.equal(file('notes.txt'), 'doc');
  assert.equal(file('Makefile'), 'doc');
  assert.equal(file('.gitignore'), 'doc', '点开头的没有扩展名');
  assert.equal(file('archive.tar.gz'), 'doc');
  assert.equal(file('trailing.'), 'doc');
});

test('icon：用 createElementNS 造 SVG，颜色是 currentColor，目录是填充的', t => {
  const made = [];
  globalThis.document = { createElementNS: (ns, tag) => { const node = { ns, tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.kids.push(...n); } }; made.push(node); return node; } };
  t.after(() => { delete globalThis.document; });
  const folder = icon('folder', 20), doc = icon('doc');
  assert.equal(folder.ns, 'http://www.w3.org/2000/svg');
  assert.deepEqual([folder.attrs.width, folder.attrs.fill, folder.attrs.stroke], [20, 'currentColor', undefined]);
  assert.deepEqual([doc.attrs.width, doc.attrs.fill, doc.attrs.stroke], [16, 'none', 'currentColor']);
  assert.equal(doc.kids.length, 3);
});

test('目录行：文件夹图标和箭头，展开时带 open 类，aria-expanded 跟着变；读取中箭头槽显示 …', async t => {
  const { page, host } = await start(t);
  const dir = rowNamed(page, 'src');
  assert.ok(part(dir, 'ico') && svgOf(part(dir, 'ico')));
  assert.ok(svgOf(part(dir, 'chev')));
  assert.equal(dir.getAttribute('aria-expanded'), 'false');
  assert.equal(dir.classList.contains('open'), false);
  host.failing.add('src');
  dir.dispatch('click');
  await flush();
  const open = rowNamed(page, 'src');
  assert.equal(open.getAttribute('aria-expanded'), 'true');
  assert.ok(open.classList.contains('open'));
  assert.equal(part(open, 'tail').find(n => n.tagName === 'SVG').length, 1, '展开后读取失败：尾标是警告图标');
  assert.equal(part(open, 'tail').classList.contains('warn'), true);
  assert.match(open.title, /读取失败：读不了这个目录/);
});

test('目录行读取中：箭头槽是 …，不放箭头图标', async t => {
  const { page, host } = await start(t);
  host.listing.src = ['x.js'];
  host.generation++; // 让回答作废，目录停在读取中
  rowNamed(page, 'src').dispatch('click');
  await flush();
  const chev = part(rowNamed(page, 'src'), 'chev');
  assert.equal(chev.textContent, '…');
  assert.equal(svgOf(chev), undefined);
});

test('文件行：图标按扩展名，没有 aria-expanded，箭头槽还在（Mac 由 CSS 藏起来）', async t => {
  const { page } = await start(t);
  for (const name of ['a.txt', 'main.mjs', 'logo.PNG']) {
    const row = rowNamed(page, name);
    assert.ok(svgOf(part(row, 'ico')), name);
    assert.equal(row.getAttribute('aria-expanded'), null);
    assert.ok(row.classList.contains('file'));
    assert.ok(svgOf(part(row, 'chev')));
  }
  assert.equal(part(rowNamed(page, 'a.txt'), 'tail').children.length, 0);
});

test('链接尾标：指向内部的链接有箭头图标；失效和其他是 dead，没有箭头也没有尾标', async t => {
  const { page } = await start(t);
  const link = rowNamed(page, 'to-file');
  assert.equal(part(link, 'tail').find(n => n.tagName === 'SVG').length, 1);
  assert.equal(link.title, 'to-file\n— · —', '路径，加上读不到时的 —');
  assert.equal(link.classList.contains('dead'), false);
  for (const [name, text] of [['gone', '指向工作目录外的链接，不能打开'], ['dev', '不能打开的文件']]) {
    const row = rowNamed(page, name);
    assert.ok(row.classList.contains('dead'));
    assert.equal(row.title, `${name}\n${text}`);
    assert.equal(svgOf(part(row, 'chev')), undefined, '没有箭头');
    assert.ok(svgOf(part(row, 'ico')));
    assert.equal(part(row, 'tail').children.length, 0);
  }
});

test('行的 DOM 只有一份：箭头、图标、名字（带第二行）、meta、尾标，缩进走 --d', async t => {
  const { page } = await start(t);
  rowNamed(page, 'src').dispatch('click');
  await flush();
  const row = rowNamed(page, 'x.js');
  assert.deepEqual(row.children.map(node => node.className), ['chev', 'ico', 'main', 'meta caption secondary', 'tail']);
  assert.equal(row.style.cssText, '--d: 1');
  assert.equal(rowNamed(page, 'a.txt').style.cssText, '--d: 0');
});

test('分区标题：根目录的最后一段，随会话变；根目录不是 ready 时不显示', async t => {
  const { page, host } = await openTree(t, { listing });
  assert.equal(visible(sectionOf(page)), false, '还没有根目录');
  host.session('s1', '/Users/x/code/alpha');
  await flush();
  assert.equal(sectionNameOf(page).textContent, 'alpha');
  assert.ok(visible(sectionOf(page)));
  assert.equal(page.tree.children[0], sectionOf(page), '标题在滚动容器里、卡片和列表之前');
  host.session('s2', '/tmp/beta/');
  await flush();
  assert.equal(sectionNameOf(page).textContent, 'beta');
  host.session('s3', '/');
  await flush();
  assert.equal(sectionNameOf(page).textContent, '/', '根就是 /');
});

test('标题高度不影响可见行：spacer 前面的偏移从滚动值里扣掉', async t => {
  const many = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
  const { page, host } = await openTree(t, { platform: 'mac', listing: { '': many } });
  host.session();
  await flush();
  const spacer = page.tree.children[1], first = () => Number(page.tree.find(n => n.classList.contains('row'))[0].dataset.i);
  page.tree.clientHeight = 240; // 24 点一行，10 行
  page.tree.scrollTop = 24 * 100;
  page.tree.dispatch('scroll');
  assert.equal(first(), 100 - 8, '没有标题：滚到第 100 行，向前多画 8 行');
  spacer.offsetTop = 48; // 标题占 2 行高
  page.tree.dispatch('scroll');
  assert.equal(first(), 98 - 8, '标题占 48 点：容器滚了 2400，列表内只滚了 2352');
});
