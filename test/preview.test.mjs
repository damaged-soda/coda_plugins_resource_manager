// 预览的读取逻辑（view/preview.mjs 的 readFile）：分块拼接、UTF-8 跨块解码、截断、变化检测。
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readChunk } from '../lib/content.mjs';
import { formatSize, lineCount, readFile } from '../view/preview.mjs';
import { TEXT_LIMIT } from '../view/protocol.mjs';
import { tempDir } from './support/fake.mjs';

// 按 step 字节一块的假读取：不管字符边界。
const slicer = (buffer, step, { size = buffer.length, mtimeMs = 1, kind = 'text' } = {}) => async offset => {
  const bytes = buffer.subarray(offset, offset + step);
  return { data: bytes.toString('base64'), offset, size, mtimeMs, kind, eof: bytes.length === 0 || offset + bytes.length >= buffer.length };
};

test('UTF-8：多字节字符被块边界切开也能还原', async () => {
  const text = '你好🙂世界 abc\n'.repeat(50);
  for (const step of [1, 2, 3, 5, 7, 64]) {
    const result = await readFile(slicer(Buffer.from(text), step));
    assert.equal(result.text, text, `块大小 ${step}`);
    assert.equal(result.truncated, false);
  }
});

test('真实模块的 64 KiB 块：大文件在块边界切开多字节字符仍然还原', async t => {
  const dir = await tempDir(t);
  const text = '你'.repeat(40_000); // 120000 字节，65536 不是 3 的倍数
  await writeFile(join(dir, 'zh.txt'), text);
  const progress = [];
  const result = await readFile(offset => readChunk(dir, 'zh.txt', offset), { onProgress: (got, total) => progress.push([got, total]) });
  assert.equal(result.text, text);
  assert.deepEqual(progress.map(p => p[0]), [65536, 120000]);
});

test('超过 1 MiB 的文本：只读前 1 MiB，标记截断，不带切坏的尾字符', async t => {
  const dir = await tempDir(t);
  const text = '你好世界\n'.repeat(120_000); // 约 1.37 MiB
  await writeFile(join(dir, 'big.txt'), text);
  const result = await readFile(offset => readChunk(dir, 'big.txt', offset));
  assert.equal(result.truncated, true);
  assert.equal(result.bytes.length, TEXT_LIMIT);
  assert.ok(!result.text.endsWith('�'));
  assert.ok(text.startsWith(result.text));
});

test('二进制和超过 8 MiB 的图片不给内容；图片字节原样拼起来', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'a.bin'), Buffer.from([1, 2, 0, 3]));
  await writeFile(join(dir, 'huge.png'), Buffer.alloc(8 * 1024 * 1024 + 1));
  const png = Buffer.alloc(150_000, 7);
  await writeFile(join(dir, 'ok.png'), png);
  const binary = await readFile(offset => readChunk(dir, 'a.bin', offset));
  assert.deepEqual([binary.kind, binary.bytes.length, binary.size], ['binary', 0, 4]);
  const huge = await readFile(offset => readChunk(dir, 'huge.png', offset));
  assert.deepEqual([huge.kind, huge.bytes.length, huge.size], ['image', 0, 8 * 1024 * 1024 + 1]);
  const image = await readFile(offset => readChunk(dir, 'ok.png', offset));
  assert.deepEqual(Buffer.from(image.bytes), png);
});

test('刷新：size、mtimeMs 没变只读第一块；变了才重读', async () => {
  let calls = 0;
  const read = (buffer, mtimeMs) => { const inner = slicer(buffer, 4, { mtimeMs }); return offset => { calls++; return inner(offset); }; };
  const first = await readFile(read(Buffer.from('hello world'), 1));
  calls = 0;
  assert.deepEqual(await readFile(read(Buffer.from('hello world'), 1), { prev: first }), { same: true });
  assert.equal(calls, 1);
  const changed = await readFile(read(Buffer.from('hello there'), 2), { prev: first });
  assert.equal(changed.text, 'hello there');
});

test('读的途中文件变了：重读；一直在变则报错；取消则停', async () => {
  const buffer = Buffer.from('abcdefgh');
  let tick = 0;
  const inner = slicer(buffer, 3);
  const flaky = async offset => ({ ...(await inner(offset)), mtimeMs: offset === 3 && tick++ === 0 ? 99 : 1 });
  assert.equal((await readFile(flaky)).text, 'abcdefgh');
  let n = 0;
  const always = async offset => ({ ...(await inner(offset)), mtimeMs: ++n });
  await assert.rejects(readFile(always), { code: 'io_error' });
  assert.deepEqual(await readFile(inner, { cancelled: () => true }), { cancelled: true });
});

test('行数和大小的显示', () => {
  assert.deepEqual(['', 'a', 'a\n', 'a\nb', '\n\n'].map(lineCount), [1, 1, 1, 2, 2]);
  assert.deepEqual([0, 1023, 1024, 1536, 10 * 1024 * 1024].map(formatSize), ['0 B', '1023 B', '1.0 KiB', '1.5 KiB', '10 MiB']);
});
