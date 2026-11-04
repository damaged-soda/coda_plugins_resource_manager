import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { isInside, parseRelative, resolveInRoot } from '../lib/paths.mjs';
import { tempDir } from './support/fake.mjs';

const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('isInside：/repo-other 不算在 /repo 里，根目录自己算', () => {
  assert.equal(isInside('/repo', '/repo'), true);
  assert.equal(isInside('/repo', '/repo/a/b'), true);
  assert.equal(isInside('/repo', '/repo-other'), false);
  assert.equal(isInside('/repo', '/repo-other/a'), false);
  assert.equal(isInside('/repo', '/'), false);
  assert.equal(isInside('/', '/anything'), true);
});

test('parseRelative：拒绝绝对路径、..、控制字符和非字符串', () => {
  for (const bad of ['/etc/passwd', '..', '../x', 'a/../b', 'a/..', 'a\u0000b', 'a\nb', 'a\u007fb', 'a\u001bb', 5, null, undefined, 'x'.repeat(5000)]) {
    assert.throws(() => parseRelative(bad), { code: 'invalid_path' }, String(bad));
  }
  assert.deepEqual(parseRelative(''), []);
  assert.deepEqual(parseRelative('./a//b/./c'), ['a', 'b', 'c']);
  assert.deepEqual(parseRelative('..a/b..'), ['..a', 'b..']);
});

async function fixture(t) {
  const base = await tempDir(t);
  const root = join(base, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.txt'), 'a');
  await mkdir(join(base, 'repo-other'));
  await writeFile(join(base, 'repo-other', 'secret.txt'), 's');
  await writeFile(join(base, 'outside.txt'), 'o');
  await symlink(join(base, 'outside.txt'), join(root, 'out-file'));
  await symlink(join(base, 'repo-other'), join(root, 'out-dir'));
  await symlink('../../repo-other', join(root, 'src', 'rel-out'));
  await symlink(join(root, 'src', 'a.txt'), join(root, 'in-file'));
  await symlink('src', join(root, 'in-dir'));
  await symlink('missing', join(root, 'dangling'));
  return { base, root };
}

test('resolveInRoot：根目录内的路径和指向内部的链接返回规范路径', async t => {
  const { root } = await fixture(t);
  assert.equal(await resolveInRoot(root, ''), root);
  assert.equal(await resolveInRoot(root, 'src/a.txt'), join(root, 'src', 'a.txt'));
  assert.equal(await resolveInRoot(root, 'in-file'), join(root, 'src', 'a.txt'));
  assert.equal(await resolveInRoot(root, 'in-dir/a.txt'), join(root, 'src', 'a.txt'));
});

test('resolveInRoot：指向外部的链接（含 /repo-other 同名前缀目录）一律拒绝', async t => {
  const { root } = await fixture(t);
  for (const path of ['out-file', 'out-dir', 'out-dir/secret.txt', 'src/rel-out', 'src/rel-out/secret.txt']) {
    await rejects(resolveInRoot(root, path), 'outside_root');
  }
});

test('resolveInRoot：.. 、绝对路径、控制字符在碰文件系统之前就拒绝；不存在的是 not_found', async t => {
  const { root } = await fixture(t);
  await rejects(resolveInRoot(root, '../repo-other/secret.txt'), 'invalid_path');
  await rejects(resolveInRoot(root, join(root, 'src')), 'invalid_path');
  await rejects(resolveInRoot(root, 'src/a\u0000.txt'), 'invalid_path');
  await rejects(resolveInRoot(root, 'nope.txt'), 'not_found');
  await rejects(resolveInRoot(root, 'dangling'), 'not_found');
  await rejects(resolveInRoot(root, 'src/a.txt/child'), 'not_dir');
});
