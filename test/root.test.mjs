import assert from 'node:assert/strict';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { queryRoot } from '../lib/root.mjs';
import { checkoutOf, fakeCoda, tempDir } from './support/fake.mjs';

test('根目录状态映射：ready 给规范路径，preparing/failed/无 checkout/无会话各是对应状态', async t => {
  const base = await tempDir(t);
  await mkdir(join(base, 'real'));
  await symlink('real', join(base, 'link'));
  const fake = fakeCoda({
    ok: checkoutOf(join(base, 'link')),
    preparing: checkoutOf(null, 'preparing'),
    failed: checkoutOf(join(base, 'real'), 'failed'),
    bare: {},
    nopath: checkoutOf(null, 'ready'),
  });
  assert.deepEqual(await queryRoot(fake.coda, 'ok'), { state: 'ready', path: join(base, 'real') });
  assert.deepEqual(await queryRoot(fake.coda, 'preparing'), { state: 'preparing', path: null });
  assert.deepEqual(await queryRoot(fake.coda, 'failed'), { state: 'none', path: null });
  assert.deepEqual(await queryRoot(fake.coda, 'bare'), { state: 'none', path: null });
  assert.deepEqual(await queryRoot(fake.coda, 'nopath'), { state: 'none', path: null });
  assert.deepEqual(await queryRoot(fake.coda, null), { state: 'none', path: null });
  assert.equal(fake.api.length, 5, '没有会话时不调接口');
});

test('ready 但目录已被回收（或变成文件）是 gone；接口出错则抛出', async t => {
  const base = await tempDir(t);
  const path = join(base, 'worktree');
  await mkdir(path);
  const fake = fakeCoda({ a: checkoutOf(path), boom: new Error('接口出错') });
  assert.equal((await queryRoot(fake.coda, 'a')).state, 'ready');
  await rm(path, { recursive: true });
  assert.deepEqual(await queryRoot(fake.coda, 'a'), { state: 'gone', path });
  await assert.rejects(queryRoot(fake.coda, 'boom'), /接口出错/);
});
