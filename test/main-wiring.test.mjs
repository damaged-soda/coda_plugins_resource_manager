// main.mjs 对读取状态的接线：refresh、changed 之后进行中的读取不再被共用；读的途中根目录换了不回答旧内容。
// 注入带门的假文件系统（activate 的 makeListing），读取卡在 readdir 上，才能在读的途中动手。
import assert from 'node:assert/strict';
import { mkdir, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { createListing } from '../lib/tree.mjs';
import { countingFs } from './support/countfs.mjs';
import { checkoutOf, deferred, fakeCoda, tempDir, waitFor } from './support/fake.mjs';

async function dirWith(root, name, count) {
  await mkdir(join(root, name), { recursive: true });
  for (let i = 0; i < count; i++) {
    const path = join(root, name, `f${i}`);
    await writeFile(path, '');
    await truncate(path, 10 + i);
    await utimes(path, 1_700_000_000, 1_700_000_000 + i);
  }
}

// 第 n 次 readdir 之后才放行的假文件系统：gates[n] 是第 n 次（从 0 起）要等的门，没有就直接过。
function gated(gates) {
  let calls = 0;
  return countingFs({ hooks: { readdir: async (...args) => {
    const original = args.pop(), gate = gates[calls++];
    if (gate) await gate.promise;
    return original(...args);
  } } });
}

async function started(fake, session, spy) {
  activate(fake.coda, { makeListing: () => createListing({ fs: spy.fs }) });
  const view = fake.open(session);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return view;
}

let seq = 0;
const list = (view, body) => {
  const requestId = `w${++seq}`;
  view.send({ type: 'list', generation: 1, requestId, cursor: null, ...body });
  return requestId;
};
const BY_DATE = 'date';

test('refresh：进行中的第一页读取不再被共用，同身份的新请求重新读，拿到的是新内容', async t => {
  const root = await tempDir(t);
  await dirWith(root, 'd', 3);
  const gate = deferred(), spy = gated([gate]);
  const view = await started(fakeCoda({ A: checkoutOf(root) }), 'A', spy);
  const first = list(view, { path: 'd', sort: BY_DATE });
  await waitFor(() => spy.counts.readdir === 1, '第一次 readdir');
  await writeFile(join(root, 'd', 'newer'), '');
  view.send({ type: 'refresh', generation: 1 });
  const second = list(view, { path: 'd', sort: BY_DATE });
  await waitFor(() => spy.counts.readdir === 2, 'refresh 之后重新读，而不是共用第一次');
  assert.equal((await view.answer(second)).entries.some(entry => entry.name === 'newer'), true);
  gate.resolve();
  assert.equal((await view.answer(first)).error, undefined, '旧读取的回答照常返回');
});

test('一轮结束（changed）：进行中的第一页读取不再被共用', async t => {
  const root = await tempDir(t);
  await dirWith(root, 'd', 3);
  const gate = deferred(), spy = gated([gate]);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A', spy);
  fake.emit('A', null, 'ADDED'); // 先记下这个会话没有在跑
  list(view, { path: 'd', sort: BY_DATE });
  await waitFor(() => spy.counts.readdir === 1, '第一次 readdir');
  fake.emit('A', 't');
  fake.emit('A', null);
  await waitFor(() => view.of('changed').length === 1, 'changed');
  list(view, { path: 'd', sort: BY_DATE });
  await waitFor(() => spy.counts.readdir === 2, 'changed 之后重新读，而不是共用第一次');
  gate.resolve();
});

test('读的途中根目录换了（同一会话从 A 换到 B）：名称排序和日期排序都不回答 A 的内容', async t => {
  const base = await tempDir(t);
  const a = join(base, 'a'), b = join(base, 'b');
  await dirWith(a, 'd', 3); await dirWith(b, 'd', 3);
  const byName = deferred(), byDate = deferred();
  const spy = gated([byName, byDate]);
  const fake = fakeCoda({ S: checkoutOf(a) });
  const view = await started(fake, 'S', spy);
  const named = list(view, { path: 'd' });
  await waitFor(() => spy.counts.readdir === 1, '名称排序卡住');
  const dated = list(view, { path: 'd', sort: BY_DATE });
  await waitFor(() => spy.counts.readdir === 2, '日期排序卡住');
  fake.threads.S = checkoutOf(b);
  view.send({ type: 'refresh', generation: 1 });
  await waitFor(() => view.of('root').length === 2, '新的 root');
  assert.equal(view.lastRoot().path, b);
  byName.resolve(); byDate.resolve();
  for (const id of [named, dated]) {
    const reply = await view.answer(id);
    assert.equal(reply.error?.code, 'no_root', id);
    assert.equal(reply.entries, undefined, '不回答 A 的内容');
  }
  const again = await view.answer(list(view, { path: 'd', sort: BY_DATE }));
  assert.equal(again.error, undefined);
  assert.equal(again.entries.length, 3, 'B 照常读');
});

test('并发：8 个视图请求同时列 8 个大目录，经 activate 接线后文件系统并发峰值不超过 8（日期和名称）', async t => {
  const root = await tempDir(t);
  for (let d = 0; d < 8; d++) await dirWith(root, `d${d}`, 60);
  for (const sort of [BY_DATE, undefined]) {
    const spy = countingFs();
    const view = await started(fakeCoda({ A: checkoutOf(root) }), 'A', spy);
    const ids = Array.from({ length: 8 }, (_, d) => list(view, { path: `d${d}`, sort }));
    for (const id of ids) assert.equal((await view.answer(id)).error, undefined);
    assert.ok(spy.peak > 1 && spy.peak <= 8, `${sort ? '日期' : '名称'}：峰值 ${spy.peak}`);
  }
});
