// 从 activate(coda) 入口走：排序请求、快照游标、根目录变化、会话切换。
import assert from 'node:assert/strict';
import { mkdir, utimes, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { checkoutOf, fakeCoda, tempDir, waitFor } from './support/fake.mjs';

async function dirWith(root, name, count) {
  await mkdir(join(root, name), { recursive: true });
  for (let i = 0; i < count; i++) {
    const path = join(root, name, `${'n'.repeat(120)}${String(i).padStart(4, '0')}`);
    await writeFile(path, '');
    await truncate(path, 1000 + i);
    await utimes(path, 1_700_000_000, 1_700_000_000 + i);
  }
}

async function started(fake, session) {
  activate(fake.coda);
  const view = fake.open(session);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return view;
}

let seq = 0;
async function ask(view, generation, body) {
  const requestId = `q${++seq}`;
  view.send({ type: 'list', generation, requestId, ...body });
  return view.answer(requestId);
}

test('排序请求：invalid_sort；日期降序分页翻完不重复不漏，条目带整数 size 和 mtimeMs，没有消息超限', async t => {
  const root = await tempDir(t);
  await dirWith(root, 'd', 1500);
  const view = await started(fakeCoda({ A: checkoutOf(root) }), 'A');
  for (const sort of [{ key: 'color', desc: false }, { key: 'size' }, 'size', 3]) {
    assert.equal((await ask(view, 1, { path: 'd', cursor: null, sort })).error.code, 'invalid_sort', JSON.stringify(sort));
  }
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const reply = await ask(view, 1, { path: 'd', cursor, sort: { key: 'date', desc: true } });
    assert.equal(reply.error, undefined);
    for (const entry of reply.entries) assert.ok(Number.isInteger(entry.size) && Number.isInteger(entry.mtimeMs));
    seen.push(...reply.entries.map(entry => entry.name));
    cursor = reply.nextCursor; pages++;
  } while (cursor);
  assert.ok(pages >= 2);
  assert.equal(new Set(seen).size, 1500);
  assert.deepEqual(seen, [...seen].sort().reverse());
  assert.equal(view.dropped.length, 0);
});

test('不带 sort 仍是名称升序，行为和以前一样', async t => {
  const root = await tempDir(t);
  await dirWith(root, 'd', 3);
  const view = await started(fakeCoda({ A: checkoutOf(root) }), 'A');
  const reply = await ask(view, 1, { path: 'd', cursor: null });
  assert.deepEqual(reply.entries.map(entry => entry.name.slice(-4)), ['0000', '0001', '0002']);
});

test('根目录：同一会话从 A 换到 B，A 的快照游标用在 B 上是 cursor_expired，A 的内容不会回答给 B', async t => {
  const base = await tempDir(t);
  const a = join(base, 'a'), b = join(base, 'b');
  await dirWith(a, 'd', 1000); await dirWith(b, 'd', 1000);
  const fake = fakeCoda({ S: checkoutOf(a) });
  const view = await started(fake, 'S');
  const first = await ask(view, 1, { path: 'd', cursor: null, sort: { key: 'size', desc: false } });
  assert.ok(first.nextCursor);
  fake.threads.S = checkoutOf(b);
  view.send({ type: 'refresh', generation: 1 });
  await waitFor(() => view.of('root').length === 2, '新的 root');
  assert.equal(view.lastRoot().path, b);
  const reply = await ask(view, 1, { path: 'd', cursor: first.nextCursor });
  assert.equal(reply.error?.code, 'cursor_expired');
  assert.equal(reply.entries, undefined);
});

test('换会话：旧会话的游标在新会话里是 cursor_expired', async t => {
  const base = await tempDir(t);
  const a = join(base, 'a'), b = join(base, 'b');
  await dirWith(a, 'd', 1000); await dirWith(b, 'd', 1000);
  const fake = fakeCoda({ A: checkoutOf(a), B: checkoutOf(b) });
  const view = await started(fake, 'A');
  const first = await ask(view, 1, { path: 'd', cursor: null, sort: { key: 'date', desc: false } });
  view.switchTo('B');
  await waitFor(() => view.of('root').length === 2, 'B 的 root');
  const reply = await ask(view, 2, { path: 'd', cursor: first.nextCursor });
  assert.equal(reply.error?.code, 'cursor_expired');
});

test('视图关闭后，进行中的请求不再回答', async t => {
  const root = await tempDir(t);
  await dirWith(root, 'd', 50);
  const view = await started(fakeCoda({ A: checkoutOf(root) }), 'A');
  const before = view.posted.length;
  view.send({ type: 'list', generation: 1, requestId: 'late', path: 'd', cursor: null, sort: { key: 'date', desc: false } });
  await view.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(view.posted.length, before);
});
