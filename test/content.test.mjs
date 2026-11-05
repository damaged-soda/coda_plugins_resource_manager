import assert from 'node:assert/strict';
import { mkdir, open, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readChunk } from '../lib/content.mjs';
import { CHUNK_BYTES, ErrorCode, IMAGE_LIMIT, MESSAGE_LIMIT, TEXT_LIMIT, messageSize } from '../view/protocol.mjs';
import { tempDir } from './support/fake.mjs';

async function readAll(root, path) {
  const chunks = [];
  for (let offset = 0; ;) {
    const chunk = await readChunk(root, path, offset);
    chunks.push(chunk);
    if (chunk.eof) return chunks;
    offset += Buffer.from(chunk.data, 'base64').length;
  }
}
const join64 = chunks => Buffer.concat(chunks.map(c => Buffer.from(c.data, 'base64')));

test('分块：每块原始 64 KiB，整条消息不超过 128 KiB，拼起来和原文件一致', async t => {
  const root = await tempDir(t);
  const body = Buffer.alloc(CHUNK_BYTES * 2 + 123, 'x');
  await writeFile(join(root, 'big.txt'), body);
  const chunks = await readAll(root, 'big.txt');
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(c => c.offset), [0, CHUNK_BYTES, CHUNK_BYTES * 2]);
  assert.deepEqual(chunks.map(c => c.eof), [false, false, true]);
  for (const chunk of chunks) {
    assert.equal(chunk.size, body.length);
    assert.equal(chunk.kind, 'text');
    assert.ok(messageSize({ type: 'chunk', generation: 99999, requestId: 'r'.repeat(64), ...chunk }) <= MESSAGE_LIMIT);
  }
  assert.ok(join64(chunks).equals(body));
});

test('UTF-8 多字节字符被块边界切开，拼接后再解码是完整的', async t => {
  const root = await tempDir(t);
  const text = 'ab' + '汉'.repeat(CHUNK_BYTES);
  await writeFile(join(root, 'han.txt'), text);
  const chunks = await readAll(root, 'han.txt');
  const first = Buffer.from(chunks[0].data, 'base64');
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(first), '第一块在字符中间被切断');
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(join64(chunks)), text);
});

test('类型：前 8000 字节有 NUL 是二进制（不给内容），图片按扩展名，空文件是空文本', async t => {
  const root = await tempDir(t);
  await writeFile(join(root, 'a.bin'), Buffer.from([1, 2, 0, 3]));
  await writeFile(join(root, 'late-nul.txt'), Buffer.concat([Buffer.alloc(8000, 'a'), Buffer.from([0])]));
  await writeFile(join(root, 'pic.PNG'), Buffer.from([0x89, 0x50, 0, 0]));
  await writeFile(join(root, 'empty.txt'), '');
  assert.deepEqual(await readChunk(root, 'a.bin', 0), { data: '', offset: 0, size: 4, mtimeMs: (await readChunk(root, 'a.bin', 0)).mtimeMs, kind: 'binary', eof: true });
  assert.equal((await readChunk(root, 'late-nul.txt', 0)).kind, 'text');
  const pic = await readChunk(root, 'pic.PNG', 0);
  assert.equal(pic.kind, 'image');
  assert.equal((await readChunk(root, './pic.PNG/', 0)).kind, 'image', '末尾的斜杠不影响类型判断');
  assert.equal(pic.data, Buffer.from([0x89, 0x50, 0, 0]).toString('base64'));
  const empty = await readChunk(root, 'empty.txt', 0);
  assert.deepEqual([empty.data, empty.size, empty.kind, empty.eof], ['', 0, 'text', true]);
});

test('上限：文本只给前 1 MiB，超过 8 MiB 的图片不给内容，偏移在末尾之外得到空块', async t => {
  const root = await tempDir(t);
  await writeFile(join(root, 'long.txt'), '');
  await truncate(join(root, 'long.txt'), TEXT_LIMIT + 5000);
  // truncate 补的是 NUL，会被当成二进制；换成真正的文本
  await writeFile(join(root, 'long.txt'), Buffer.alloc(TEXT_LIMIT + 5000, 'y'));
  const chunks = await readAll(root, 'long.txt');
  assert.equal(join64(chunks).length, TEXT_LIMIT);
  assert.equal(chunks.at(-1).size, TEXT_LIMIT + 5000);
  const past = await readChunk(root, 'long.txt', TEXT_LIMIT);
  assert.deepEqual([past.data, past.eof], ['', true]);

  await writeFile(join(root, 'huge.png'), '');
  await truncate(join(root, 'huge.png'), IMAGE_LIMIT + 1);
  const huge = await readChunk(root, 'huge.png', 0);
  assert.deepEqual([huge.data, huge.kind, huge.size, huge.eof], ['', 'image', IMAGE_LIMIT + 1, true]);

  assert.deepEqual((await readChunk(root, 'empty-less.txt'.replace('empty-less', 'long'), 10_000_000)).data, '');
});

test('错误：偏移无效、目录、越界和指向外部的链接、不存在', async t => {
  const base = await tempDir(t);
  const root = join(base, 'repo');
  await mkdir(join(root, 'dir'), { recursive: true });
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(base, 'secret.txt'), 's');
  await symlink(join(base, 'secret.txt'), join(root, 'leak.txt'));
  await symlink('a.txt', join(root, 'inner.txt'));
  const code = c => error => error.code === c;
  for (const offset of [-1, 1.5, NaN, '0', null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    await assert.rejects(readChunk(root, 'a.txt', offset), code('invalid_offset'), String(offset));
  }
  await assert.rejects(readChunk(root, 'dir', 0), code('not_file'));
  await assert.rejects(readChunk(root, '../secret.txt', 0), code('invalid_path'));
  await assert.rejects(readChunk(root, 'leak.txt', 0), code('outside_root'));
  await assert.rejects(readChunk(root, 'nope.txt', 0), code('not_found'));
  assert.equal((await readChunk(root, 'inner.txt', 0)).data, Buffer.from('a').toString('base64'));
});

test('校验之后目标被换成指向外面的链接：回答越界错误，不带外面文件的字节', async t => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await writeFile(join(root, 'a.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET-BYTES');
  // 校验已经通过之后、真正打开之前，把目标换成链接
  const swapping = async (file, flags) => {
    await rm(file);
    await symlink(join(outside, 'secret.txt'), file);
    return open(file, flags);
  };
  await assert.rejects(readChunk(root, 'a.txt', 0, { open: swapping }), error => {
    assert.equal(error.code, ErrorCode.OUTSIDE_ROOT);
    assert.ok(!JSON.stringify(error).includes('TOP-SECRET'));
    return true;
  });
});

test('打开时没有被换：普通文件读取不变', async t => {
  const root = await tempDir(t);
  await writeFile(join(root, 'a.txt'), 'inside');
  const chunk = await readChunk(root, 'a.txt', 0, { open });
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'inside');
});
