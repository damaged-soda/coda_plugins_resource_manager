// lib/tree.mjs 的排序、游标、快照、上限、读取量与并发、根目录和越界。文件系统用 test/support/countfs.mjs 数调用。
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SORT_STAT_LIMIT, createListing, listDirectory } from '../lib/tree.mjs';
import { createSnapshots } from '../lib/snapshots.mjs';
import { ENVELOPE_BYTES, PAGE_BYTES } from '../view/protocol.mjs';
import { countingFs } from './support/countfs.mjs';
import { deferred, tempDir, waitFor } from './support/fake.mjs';

const names = page => page.entries.map(entry => entry.name);
const code = c => error => error.code === c;
const T0 = 1_700_000_000; // 修改时间（秒）；带小数，验证取整
// 小到每页大约只放一条（至少一条）。
const TINY = ENVELOPE_BYTES + 1;

// 建文件：size 是字节数，at 是修改时间相对 T0 的秒数。
async function file(root, name, size, at = 0) {
  await writeFile(join(root, name), '');
  await truncate(join(root, name), size); // 稀疏文件，大小可以很大
  await utimes(join(root, name), T0, T0 + at + 0.789);
}
async function folder(root, name, at = 0) {
  await mkdir(join(root, name), { recursive: true });
  await utimes(join(root, name), T0, T0 + at + 0.789);
}

async function pagesOf(root, path, sort, { listing = createListing(), ...options } = {}) {
  const pages = [];
  let cursor = null;
  do {
    const page = await listDirectory(root, path, cursor, { ...options, listing, sort: pages.length ? undefined : sort });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}
const flat = async (...args) => (await pagesOf(...args)).flatMap(names);

async function sample(t) {
  const root = await tempDir(t);
  await folder(root, 'zdir', 5); await folder(root, 'adir', 9);
  await file(root, 'big.TXT', 300, 1); await file(root, 'mid.md', 200, 3); await file(root, 'small.txt', 100, 2); await file(root, 'noext', 400, 4);
  return root;
}

test('排序：每种键的方向固定（名称、种类升序，日期、大小降序），文件夹始终在前', async t => {
  const root = await sample(t);
  // 文件夹 zdir 的日期 +5、adir +9；文件 big +1、mid +3、small +2、noext +4；大小 300、200、100、400。
  const expect = {
    name: ['adir', 'zdir', 'big.TXT', 'mid.md', 'noext', 'small.txt'],
    kind: ['adir', 'zdir', 'noext', 'mid.md', 'big.TXT', 'small.txt'],
    date: ['adir', 'zdir', 'noext', 'mid.md', 'small.txt', 'big.TXT'],
    size: ['adir', 'zdir', 'noext', 'big.TXT', 'mid.md', 'small.txt'],
  };
  for (const [key, order] of Object.entries(expect)) assert.deepEqual(await flat(root, '', key), order, key);
  assert.deepEqual(await flat(root, ''), expect.name, '不带 sort 是名称');
});

test('条目带整数 size（只有文件）和向下取整的 mtimeMs；文件夹只有 mtimeMs', async t => {
  const root = await sample(t);
  const { entries } = (await pagesOf(root, '', 'size'))[0];
  const byName = Object.fromEntries(entries.map(entry => [entry.name, entry]));
  assert.deepEqual(byName.adir, { name: 'adir', kind: 'dir', mtimeMs: (T0 + 9) * 1000 + 789 });
  assert.deepEqual(byName['small.txt'], { name: 'small.txt', kind: 'file', size: 100, mtimeMs: (T0 + 2) * 1000 + 789 });
  for (const entry of entries) assert.ok(Number.isInteger(entry.mtimeMs) && (entry.size === undefined || Number.isInteger(entry.size)));
});

test('缺元数据的不管升降序都排在组内最后，不当成 0', async t => {
  const root = await tempDir(t);
  await file(root, 'zero', 0, 5); await file(root, 'one', 1, 1); await file(root, 'gone', 50, 9);
  const missing = countingFs({ hooks: { lstat: (path, original) => (path.endsWith('gone') ? Promise.reject(new Error('没权限')) : original(path)) } });
  for (const key of ['size', 'date']) {
    const [page] = await pagesOf(root, '', key, { listing: createListing({ fs: missing.fs }) });
    assert.equal(names(page).at(-1), 'gone', key);
    assert.deepEqual(page.entries.at(-1), { name: 'gone', kind: 'file' });
  }
  const [page] = await pagesOf(root, '', 'size', { listing: createListing({ fs: missing.fs }) });
  assert.deepEqual(names(page), ['one', 'zero', 'gone'], '大小降序：1 在 0 前面，缺的不是 0，排最后');
});

test('相同键按名字（不分大小写）升序，再按原名，降序的排序也一样', async t => {
  // 只名字大小写不同的文件在 macOS 上建不出来，所以用假的目录项和 lstat。
  const dirent = name => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
  const info = size => ({ isFile: () => true, isDirectory: () => false, size, mtimeMs: 1000 });
  const sizes = { b: 7, a: 7, A: 7, B: 7, c: 9 };
  const spy = countingFs({ hooks: {
    readdir: async () => Object.keys(sizes).map(dirent),
    lstat: async path => info(sizes[path.split('/').pop()]),
  } });
  const root = await tempDir(t);
  const ask = key => flat(root, '', key, { listing: createListing({ fs: spy.fs }) });
  assert.deepEqual(await ask('size'), ['c', 'A', 'a', 'B', 'b'], '大小降序：9 在前，平手的 7 按名字升序');
  assert.deepEqual(await ask('date'), ['A', 'a', 'B', 'b', 'c'], '日期全相同，只按名字');
});

test('invalid_sort：不是四种键之一一律拒绝（含带方向的旧形状）；不带 sort 是名称', async t => {
  const root = await sample(t);
  for (const sort of ['color', '', 'Size', { key: 'size', desc: true }, { key: 'name', desc: false }, 7, [], true]) {
    await assert.rejects(listDirectory(root, '', null, { sort }), code('invalid_sort'), JSON.stringify(sort));
  }
  assert.deepEqual(names(await listDirectory(root, '')), names(await listDirectory(root, '', null, { sort: 'name' })));
});

test('一页不超字节上限：带上元数据，四种排序、很长的名字，每页整条回答都不超 96 KiB', async t => {
  const root = await tempDir(t);
  for (let i = 0; i < 1500; i++) await file(root, `${i % 2 ? '"'.repeat(100) : '😀'.repeat(30)}${String(i).padStart(4, '0')}`, i * 1e6, i);
  const bytes = page => Buffer.byteLength(JSON.stringify({ type: 'listed', generation: 12345, requestId: 'r'.repeat(64), ...page }));
  for (const key of ['name', 'kind', 'date', 'size']) {
    const pages = await pagesOf(root, '', key);
    assert.ok(pages.length >= 3, key);
    for (const page of pages) assert.ok(bytes(page) <= PAGE_BYTES, `${key}：${bytes(page)} 字节`);
    assert.equal(new Set(pages.flatMap(names)).size, 1500, key);
  }
});

test('名称、种类的游标：翻页途中增删条目，不重复，也不漏游标之后留下的', async t => {
  for (const key of ['name', 'kind']) {
    const root = await tempDir(t);
    for (let i = 0; i < 8; i++) await file(root, `f${i}.e${i % 2}`, 1);
    const sort = key, options = { pageBytes: TINY + 150 };
    const first = await listDirectory(root, '', null, { ...options, sort });
    assert.ok(first.nextCursor && first.entries.length < 8, key);
    const last = first.entries.at(-1).name;
    await rm(join(root, 'f7.e1'));
    await rm(join(root, first.entries[0].name)); // 游标之前的删了也不影响
    await file(root, 'f0a.e0', 1);
    const rest = [];
    for (let cursor = first.nextCursor; cursor;) {
      const page = await listDirectory(root, '', cursor, { ...options, sort: 'size' }); // 请求里的 sort 被游标盖过
      rest.push(...names(page)); cursor = page.nextCursor;
    }
    const all = [...names(first), ...rest];
    assert.equal(new Set(all).size, all.length, key);
    const expected = await flat(root, '', sort);
    assert.deepEqual(rest, expected.slice(expected.indexOf(last) + 1).filter(name => name !== last), key);
  }
});

test('快照：评审反例 a=10、b=20、c=30，第一页后 a→40、c→15，翻完不重复不漏，内容是快照时刻的', async t => {
  const root = await tempDir(t);
  await file(root, 'a', 10); await file(root, 'b', 20); await file(root, 'c', 30);
  const listing = createListing(), options = { listing, pageBytes: TINY };
  const first = await listDirectory(root, '', null, { ...options, sort: 'size' });
  assert.deepEqual(names(first), ['c'], '大小降序，最大的在前');
  await file(root, 'a', 40); await file(root, 'c', 15);
  const second = await listDirectory(root, '', first.nextCursor, options);
  const third = await listDirectory(root, '', second.nextCursor, options);
  assert.deepEqual([...names(first), ...names(second), ...names(third)], ['c', 'b', 'a']);
  assert.deepEqual([first, second, third].map(page => page.entries[0].size), [30, 20, 10]);
  assert.equal(third.nextCursor, null);
});

test('快照：第二页起不碰文件系统（连目录都删了也照常回答），翻完释放，再用游标是 cursor_expired', async t => {
  const root = await tempDir(t);
  await mkdir(join(root, 'd'));
  for (let i = 0; i < 6; i++) await file(join(root, 'd'), `f${i}`, i, i);
  const spy = countingFs(), listing = createListing({ fs: spy.fs }), options = { listing, pageBytes: TINY + 100 };
  const first = await listDirectory(root, 'd', null, { ...options, sort: 'date' });
  assert.ok(first.nextCursor);
  const after = { ...spy.counts };
  assert.deepEqual([after.readdir, after.lstat], [1, 6], '第一页读全部元数据');
  await rm(join(root, 'd'), { recursive: true });
  const seen = [...names(first)];
  let cursor = first.nextCursor, last;
  while (cursor) { last = cursor; const page = await listDirectory(root, 'd', cursor, options); seen.push(...names(page)); cursor = page.nextCursor; }
  assert.deepEqual(seen, ['f5', 'f4', 'f3', 'f2', 'f1', 'f0']);
  assert.deepEqual(spy.counts, after, '后面的页没有任何文件系统调用');
  assert.equal(listing.snapshots.size, 0, '翻完就释放');
  await assert.rejects(listDirectory(root, 'd', last, options), code('cursor_expired'));
});

test('快照：一页放得下的目录不建快照', async t => {
  const root = await sample(t);
  const listing = createListing();
  const page = await listDirectory(root, '', null, { listing, sort: 'date' });
  assert.equal(page.nextCursor, null);
  assert.equal(listing.snapshots.size, 0);
});

test('快照：闲置 60 秒后游标过期；期间用过就重新计时', async t => {
  const root = await tempDir(t);
  for (let i = 0; i < 4; i++) await file(root, `f${i}`, i);
  const time = { at: 0 }, options = () => ({ listing: createListing({ snapshots: createSnapshots({ now: () => time.at }) }), pageBytes: TINY });
  const a = options();
  const first = await listDirectory(root, '', null, { ...a, sort: 'size' });
  time.at += 50_000;
  const second = await listDirectory(root, '', first.nextCursor, a);
  time.at += 50_000;
  assert.ok(await listDirectory(root, '', second.nextCursor, a), '距上次用只有 50 秒');
  const b = options();
  const early = await listDirectory(root, '', null, { ...b, sort: 'size' });
  time.at += 60_001;
  await assert.rejects(listDirectory(root, '', early.nextCursor, b), code('cursor_expired'));
  assert.equal(b.listing.snapshots.size, 0);
});

test('快照：数量上限，第 9 个把最久没用的挤掉，它的游标是 cursor_expired，其他照常', async t => {
  const root = await tempDir(t);
  const listing = createListing(), options = { listing, pageBytes: TINY };
  const cursors = [];
  for (let d = 0; d < 9; d++) {
    await mkdir(join(root, `d${d}`));
    for (let i = 0; i < 3; i++) await file(join(root, `d${d}`), `f${i}`, i);
    cursors.push((await listDirectory(root, `d${d}`, null, { ...options, sort: 'size' })).nextCursor);
  }
  assert.equal(listing.snapshots.size, 8);
  await assert.rejects(listDirectory(root, 'd0', cursors[0], options), code('cursor_expired'));
  for (let d = 1; d < 9; d++) assert.deepEqual(names(await listDirectory(root, `d${d}`, cursors[d], options)), ['f1']);
});

test('快照：新的第一页替换同身份的旧快照，旧游标过期；游标优先于 sort，目录和根目录对不上也过期', async t => {
  const base = await tempDir(t);
  const root = join(base, 'r'), other = join(base, 'o');
  for (const dir of [root, other]) { await mkdir(join(dir, 'd'), { recursive: true }); for (let i = 0; i < 3; i++) await file(join(dir, 'd'), `f${i}`, i); }
  await mkdir(join(root, 'e')); await file(join(root, 'e'), 'x', 1); await file(join(root, 'e'), 'y', 1);
  const listing = createListing(), options = { listing, pageBytes: TINY };
  const old = (await listDirectory(root, 'd', null, { ...options, sort: 'size' })).nextCursor;
  const fresh = (await listDirectory(root, 'd', null, { ...options, sort: 'size' })).nextCursor;
  await assert.rejects(listDirectory(root, 'd', old, options), code('cursor_expired'));
  assert.deepEqual(names(await listDirectory(root, 'd', fresh, { ...options, sort: 'name' })), ['f1'], '按快照的大小降序，不按请求里的名称');
  const again = (await listDirectory(root, 'd', null, { ...options, sort: 'size' })).nextCursor;
  await assert.rejects(listDirectory(root, 'e', again, options), code('cursor_expired'), '目录对不上');
  await assert.rejects(listDirectory(other, 'd', again, options), code('cursor_expired'), '根目录对不上');
  assert.ok(await listDirectory(root, './d/', again, options), '同一目录的另一种写法认得');
});

test('游标格式不对、下标越界都是 cursor_expired', async t => {
  const root = await sample(t);
  const bad = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of ['???', bad([]), bad(['s', 1]), bad(['s', 1, 0]), bad(['s', 1, 99]), bad(['k', 'date', 0, 'a']), bad(['k', 'name', 2, 'a']), bad(['k', 'name', 0, 1, 'a']), bad(['k', 'name', 1, 'a', 'x']), bad({})]) {
    await assert.rejects(listDirectory(root, '', cursor), code('cursor_expired'), cursor);
  }
});

test('上限：20,000 条仍按日期；20,001 条回 sortFallback 按名称；翻页途中 20,000→20,001 继续用快照；名称、种类不受限', async t => {
  assert.equal(SORT_STAT_LIMIT, 20_000);
  const root = await tempDir(t);
  const make = async (from, to) => {
    for (let i = from; i < to; i += 500) await Promise.all(Array.from({ length: Math.min(500, to - i) }, (_, k) => writeFile(join(root, `f${String(i + k).padStart(5, '0')}`), '')));
  };
  await make(0, 20_000);
  const spy = countingFs(), listing = createListing({ fs: spy.fs });
  const first = await listDirectory(root, '', null, { listing, sort: 'date' });
  assert.equal(first.sortFallback, undefined);
  assert.equal(spy.counts.lstat, 20_000);
  assert.ok(first.entries.every(entry => Number.isInteger(entry.mtimeMs)));
  // 翻页途中长到 20,001：继续用快照翻完，不重复、不漏、不算超限。
  await writeFile(join(root, 'f20000'), '');
  const seen = names(first);
  for (let cursor = first.nextCursor; cursor;) { const page = await listDirectory(root, '', cursor, { listing }); seen.push(...names(page)); cursor = page.nextCursor; }
  assert.equal(seen.length, 20_000);
  assert.equal(new Set(seen).size, 20_000);
  assert.ok(!seen.includes('f20000'));
  assert.equal(spy.counts.lstat, 20_000, '翻页没有再读');
  // 下一次第一页才退回名称，并且只读这一页的元数据。
  const lstatBefore = spy.counts.lstat;
  const fallback = await listDirectory(root, '', null, { listing, sort: 'size' });
  assert.equal(fallback.sortFallback, true);
  assert.equal(fallback.entries[0].name, 'f00000');
  assert.equal(spy.counts.lstat - lstatBefore, fallback.entries.length, '退回名称后只读这一页的元数据');
  assert.ok(fallback.nextCursor && !(await listDirectory(root, '', fallback.nextCursor, { listing })).sortFallback, '只有第一页带 sortFallback');
  assert.equal(listing.snapshots.size, 0);
  for (const key of ['name', 'kind']) {
    const page = await listDirectory(root, '', null, { sort: key });
    assert.equal(page.sortFallback, undefined, key);
    assert.ok(page.entries.length > 100);
  }
});

test('读取量：名称、种类只读当前页的元数据；日期、大小第一页读全部', async t => {
  const root = await tempDir(t);
  for (let i = 0; i < 300; i++) await file(root, `f${String(i).padStart(3, '0')}`, i);
  for (const key of ['name', 'kind']) {
    const spy = countingFs();
    const page = await listDirectory(root, '', null, { listing: createListing({ fs: spy.fs }), sort: key, pageBytes: ENVELOPE_BYTES + 3000 });
    assert.ok(page.nextCursor);
    assert.equal(spy.counts.lstat, page.entries.length, key);
    assert.ok(page.entries.length < 100);
  }
  const spy = countingFs();
  await listDirectory(root, '', null, { listing: createListing({ fs: spy.fs }), sort: 'size' });
  assert.equal(spy.counts.lstat, 300);
});

test('并发：8 个目录同时读，同时在读的不超过 8（日期和名称都是）', async t => {
  const root = await tempDir(t);
  for (let d = 0; d < 8; d++) { await mkdir(join(root, `d${d}`)); for (let i = 0; i < 60; i++) await file(join(root, `d${d}`), `f${i}`, i); }
  for (const key of ['date', 'name']) {
    const spy = countingFs(), listing = createListing({ fs: spy.fs });
    await Promise.all(Array.from({ length: 8 }, (_, d) => listDirectory(root, `d${d}`, null, { listing, sort: key, pageBytes: PAGE_BYTES })));
    assert.equal(spy.peak, 8, `${key}：峰值 ${spy.peak}`);
  }
});

test('并发：目录里的链接解析（realpath、stat）也算在同一个上限里', async t => {
  const root = await tempDir(t);
  for (let d = 0; d < 4; d++) {
    await mkdir(join(root, `d${d}`)); await file(root, `target${d}`, 3);
    for (let i = 0; i < 30; i++) await symlink(join(root, `target${d}`), join(root, `d${d}`, `l${i}`));
  }
  const spy = countingFs(), listing = createListing({ fs: spy.fs });
  await Promise.all(Array.from({ length: 4 }, (_, d) => listDirectory(root, `d${d}`, null, { listing, sort: 'size' })));
  assert.equal(spy.peak, 8);
});

test('同身份的第一页并发共用一次读取；detach 之后不再共用', async t => {
  const root = await sample(t);
  const gate = deferred();
  const spy = countingFs({ hooks: { readdir: async (...args) => { const original = args.pop(); await gate.promise; return original(...args); } } });
  const listing = createListing({ fs: spy.fs });
  const ask = () => listDirectory(root, '', null, { listing, sort: 'date' });
  const a = ask(), b = ask();
  await waitFor(() => spy.counts.readdir > 0, 'readdir');
  assert.equal(spy.counts.readdir, 1);
  listing.detach(); // refresh、changed：进行中的不再共用
  const c = ask();
  await waitFor(() => spy.counts.readdir === 2, '第二次 readdir');
  gate.resolve();
  const [pa, pb, pc] = await Promise.all([a, b, c]);
  assert.deepEqual(pa, pb);
  assert.deepEqual(names(pc), names(pa));
  assert.equal(spy.counts.readdir, 2);
  await ask();
  assert.equal(spy.counts.readdir, 3, '上一次读完了，不再共用');
  const other = createListing({ fs: spy.fs }); // 不同排序也不共用
  await Promise.all([listDirectory(root, '', null, { listing: other, sort: 'date' }), listDirectory(root, '', null, { listing: other, sort: 'size' })]);
  assert.equal(spy.counts.readdir, 5);
});

test('同身份的旧读取晚到：只有最新发起的读取存快照，新第一页的游标仍有效；旧读取的回答照常返回，它的游标过期', async t => {
  const root = await tempDir(t);
  for (let i = 0; i < 4; i++) await file(root, `f${i}`, i);
  const gate = deferred();
  let calls = 0;
  const spy = countingFs({ hooks: { readdir: async (...args) => { const original = args.pop(); if (calls++ === 0) await gate.promise; return original(...args); } } });
  const listing = createListing({ fs: spy.fs });
  const ask = cursor => listDirectory(root, '', cursor, { listing, sort: 'size', pageBytes: TINY });
  const old = ask(null);
  await waitFor(() => spy.counts.readdir === 1, '旧读取卡在 readdir');
  listing.detach(); // refresh、changed：不再共用，新请求重新读
  const fresh = await ask(null);
  assert.equal(spy.counts.readdir, 2);
  assert.equal(listing.snapshots.size, 1);
  gate.resolve();
  const late = await old;
  assert.equal(listing.snapshots.size, 1, '旧读取没有顶掉新快照');
  assert.deepEqual(names(late), names(fresh), '旧读取的回答照常返回');
  const second = await ask(fresh.nextCursor);
  assert.deepEqual(names(second), ['f2']);
  await assert.rejects(ask(late.nextCursor), code('cursor_expired'));
  assert.equal(listing.latest.size, 0, '读完不留记录');
});

test('根目录：读的途中根目录换了，不存快照，也不回答内容；游标换到别的根目录用不了', async t => {
  const root = await tempDir(t);
  for (let i = 0; i < 4; i++) await file(root, `f${i}`, i);
  const gate = deferred();
  const spy = countingFs({ hooks: { readdir: async (...args) => { const original = args.pop(); await gate.promise; return original(...args); } } });
  const listing = createListing({ fs: spy.fs });
  let current = true;
  const read = listDirectory(root, '', null, { listing, sort: 'size', pageBytes: TINY, valid: () => current });
  await waitFor(() => spy.counts.readdir === 1, 'readdir');
  current = false; // 同一会话下根目录从 A 换到了 B
  gate.resolve();
  await assert.rejects(read, code('no_root'));
  assert.equal(listing.snapshots.size, 0);
  assert.equal(listing.reads.size, 0);
});

test('越界：不跟随链接。指向外面的链接不带元数据；link: true 不解析第二次', async t => {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'dir'), { recursive: true });
  await file(root, 'in.txt', 5); await file(base, 'outside.txt', 12_345);
  await symlink(join(base, 'outside.txt'), join(root, 'to-outside'));
  await symlink('in.txt', join(root, 'to-in'));
  await symlink('dir', join(root, 'to-dir'));
  await symlink('nowhere', join(root, 'dangling'));
  for (const key of ['name', 'date']) {
    const spy = countingFs();
    const { entries } = await listDirectory(root, '', null, { listing: createListing({ fs: spy.fs }), sort: key });
    const byName = Object.fromEntries(entries.map(entry => [entry.name, entry]));
    assert.deepEqual(byName['to-outside'], { name: 'to-outside', kind: 'link' }, key);
    assert.deepEqual(byName.dangling, { name: 'dangling', kind: 'link' }, key);
    assert.equal(byName['to-in'].size, 5, key);
    assert.ok(Number.isInteger(byName['to-dir'].mtimeMs) && byName['to-dir'].size === undefined, key);
    assert.deepEqual([spy.counts.realpath, spy.counts.stat], [4, 0], `${key}：4 个链接各解析一次，不跟随链接的 stat`);
    assert.equal(spy.counts.lstat, 4, `${key}：目标在里面的两个链接校验时 lstat 一次，dir 和 in.txt 两个普通条目各一次；链接复用校验时的结果`);
  }
});

test('越界：readdir 之后条目被换成指向外面的链接，读元数据读不到外面的信息', async t => {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(root);
  await file(root, 'swap.txt', 1); await file(root, 'plain.txt', 2); await file(base, 'secret.txt', 99_999, 77);
  const swap = async (...args) => {
    const original = args.pop(), result = await original(...args);
    await rm(join(root, 'swap.txt'));
    await symlink(join(base, 'secret.txt'), join(root, 'swap.txt'));
    return result;
  };
  for (const [key, bytes] of [['date', PAGE_BYTES], ['name', PAGE_BYTES]]) {
    await rm(join(root, 'swap.txt'), { force: true }); await file(root, 'swap.txt', 1);
    const spy = countingFs({ hooks: { readdir: swap } });
    const { entries } = await listDirectory(root, '', null, { listing: createListing({ fs: spy.fs }), sort: key, pageBytes: bytes });
    const swapped = entries.find(entry => entry.name === 'swap.txt');
    assert.deepEqual(swapped, { name: 'swap.txt', kind: 'file' }, key);
    assert.ok(!JSON.stringify(entries).includes('99999'), key);
  }
});

test('越界：realpath 校验之后目标被换成指向外面的链接，回答里没有外面文件的元数据，条目是 link', async t => {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(root);
  await file(base, 'outside.txt', 99_999, 77);
  for (const key of ['date', 'name']) {
    await rm(join(root, 'inside.txt'), { force: true }); await file(root, 'inside.txt', 5);
    await rm(join(root, 'alias'), { force: true }); await symlink('inside.txt', join(root, 'alias'));
    const swap = async (...args) => {
      const original = args.pop(), result = await original(...args);
      if (String(args[0]).endsWith('alias')) {
        await rm(join(root, 'inside.txt'));
        await symlink(join(base, 'outside.txt'), join(root, 'inside.txt'));
      }
      return result;
    };
    const spy = countingFs({ hooks: { realpath: swap } });
    const { entries } = await listDirectory(root, '', null, { listing: createListing({ fs: spy.fs }), sort: key });
    assert.deepEqual(entries.find(entry => entry.name === 'alias'), { name: 'alias', kind: 'link' }, key);
    assert.ok(!JSON.stringify(entries).includes('99999') && !JSON.stringify(entries).includes(String(1_700_000_077)), key);
  }
});
