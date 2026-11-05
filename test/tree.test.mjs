import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { listDirectory } from '../lib/tree.mjs';
import { PAGE_BYTES } from '../view/protocol.mjs';
import { tempDir } from './support/fake.mjs';

// 页面收到的整条回答（含信封）按 UTF-8 字节算的大小。
const pageBytes = (page, requestId = 'r'.repeat(64)) => Buffer.byteLength(JSON.stringify({ type: 'listed', generation: 12345, requestId, ...page }));
const names = page => page.entries.map(entry => entry.name);
const bare = page => page.entries.map(({ size, mtimeMs, ...entry }) => entry);

async function listAll(root, path = '', options) {
  const pages = [];
  let cursor;
  do {
    const page = await listDirectory(root, path, cursor, options);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

test('排序：先目录后文件，名字不分大小写', async t => {
  const root = await tempDir(t);
  for (const dir of ['zeta', 'Alpha', 'beta']) await mkdir(join(root, dir));
  for (const file of ['b.txt', 'A.txt', 'Z.txt', '.hidden']) await writeFile(join(root, file), '');
  const [page] = await listAll(root);
  assert.deepEqual(names(page), ['Alpha', 'beta', 'zeta', '.hidden', 'A.txt', 'b.txt', 'Z.txt']);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.entries.map(e => e.kind), ['dir', 'dir', 'dir', 'file', 'file', 'file', 'file']);
});

test('链接：指向内部的按目标显示并带 link，指向外部和失效的显示为 link，不暴露目标', async t => {
  const base = await tempDir(t);
  const root = join(base, 'repo');
  await mkdir(join(root, 'real-dir'), { recursive: true });
  await writeFile(join(root, 'real.txt'), '');
  await writeFile(join(base, 'outside.txt'), '');
  await symlink('real-dir', join(root, 'to-dir'));
  await symlink('real.txt', join(root, 'to-file'));
  await symlink(join(base, 'outside.txt'), join(root, 'to-outside'));
  await symlink('nowhere', join(root, 'dangling'));
  const [page] = await listAll(root);
  assert.deepEqual(bare(page), [
    { name: 'real-dir', kind: 'dir' }, { name: 'to-dir', kind: 'dir', link: true },
    { name: 'dangling', kind: 'link' }, { name: 'real.txt', kind: 'file' },
    { name: 'to-file', kind: 'file', link: true }, { name: 'to-outside', kind: 'link' },
  ]);
});

test('名字含控制字符的条目只显示（other），不会变成可打开的路径', async t => {
  const root = await tempDir(t);
  await writeFile(join(root, 'bad\u0001name'), '');
  const [page] = await listAll(root);
  assert.deepEqual(bare(page), [{ name: 'bad\u0001name', kind: 'other' }]);
});

test('分页：大量需要转义的名字，每页整条回答不超过 96 KiB，合起来不重不漏且有序', async t => {
  const root = await tempDir(t);
  const created = [];
  // 引号、反斜杠在 JSON 里翻倍；非 BMP 字符按 UTF-8 占 4 字节。
  for (let i = 0; i < 1000; i++) {
    const base = i % 3 === 0 ? '"'.repeat(120) : i % 3 === 1 ? '\\'.repeat(100) : '😀'.repeat(40);
    const name = `${base}${String(i).padStart(4, '0')}`;
    await writeFile(join(root, name), '');
    created.push(name);
  }
  const pages = await listAll(root);
  assert.ok(pages.length >= 3, `应分成多页，实际 ${pages.length}`);
  for (const page of pages.slice(0, -1)) assert.ok(page.nextCursor);
  for (const page of pages) assert.ok(pageBytes(page) <= PAGE_BYTES, `一页 ${pageBytes(page)} 字节`);
  const all = pages.flatMap(names);
  assert.equal(new Set(all).size, created.length);
  const expected = [...created].sort((a, b) => {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x === y ? (a < b ? -1 : 1) : x < y ? -1 : 1;
  });
  assert.deepEqual(all, expected);
});

test('分页：游标之后的条目被删、被新增时，不重复也不漏掉游标之后留下的', async t => {
  const root = await tempDir(t);
  for (let i = 0; i < 6; i++) await writeFile(join(root, `f${i}.txt`), '');
  const first = await listDirectory(root, '', undefined, { pageBytes: 4096 + 60 });
  assert.ok(first.nextCursor && first.entries.length < 6);
  await rm(join(root, 'f5.txt'));
  await writeFile(join(root, 'f0a.txt'), '');
  const rest = [];
  for (let cursor = first.nextCursor; cursor;) {
    const page = await listDirectory(root, '', cursor, { pageBytes: 4096 + 60 });
    rest.push(...names(page));
    cursor = page.nextCursor;
  }
  assert.deepEqual([...names(first), ...rest].filter(n => n !== 'f0a.txt'), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
  assert.equal(new Set([...names(first), ...rest]).size, names(first).length + rest.length);
});

test('一条也放不下一页时仍然至少给一条，不会死循环', async t => {
  const root = await tempDir(t);
  await writeFile(join(root, 'a'), '');
  await writeFile(join(root, 'b'), '');
  const pages = await listAll(root, '', { pageBytes: 1 });
  assert.deepEqual(pages.map(names), [['a'], ['b']]);
});

test('错误：游标无效、路径越界、不是目录、不存在、条目过多', async t => {
  const root = await tempDir(t);
  await writeFile(join(root, 'file'), '');
  await mkdir(join(root, 'sub'));
  const code = c => error => error.code === c;
  await assert.rejects(listDirectory(root, '', 'not-a-cursor!'), code('cursor_expired'));
  await assert.rejects(listDirectory(root, '', Buffer.from('[7,"x"]').toString('base64url')), code('cursor_expired'));
  await assert.rejects(listDirectory(root, '..'), code('invalid_path'));
  await assert.rejects(listDirectory(root, 'file'), code('not_dir'));
  await assert.rejects(listDirectory(root, 'nope'), code('not_found'));
  await assert.rejects(listDirectory(root, '', undefined, { maxEntries: 1 }), code('too_large'));
});
