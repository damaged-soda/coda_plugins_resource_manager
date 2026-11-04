// 日期、大小排序的快照仓：身份替换、数量和总条目上限、闲置清理、释放。
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SNAPSHOTS, MAX_SNAPSHOT_ENTRIES, SNAPSHOT_IDLE_MS, createSnapshots } from '../lib/snapshots.mjs';

const clock = () => { const c = { at: 1000, now: () => c.at }; return c; };
const rows = count => Array.from({ length: count }, (_, i) => ({ name: `n${i}`, kind: 'file' }));
const put = (store, name, count = 1) => store.put({ identity: name, root: '/r', path: name, entries: rows(count) });

test('默认上限：同时 8 个、总条目 10 万、闲置 60 秒', () => {
  assert.deepEqual([MAX_SNAPSHOTS, MAX_SNAPSHOT_ENTRIES, SNAPSHOT_IDLE_MS], [8, 100_000, 60_000]);
});

test('同身份的新快照替换旧的，旧编号作废，编号不复用', () => {
  const store = createSnapshots();
  const first = put(store, 'a', 3);
  const second = put(store, 'a', 2);
  assert.notEqual(first.id, second.id);
  assert.equal(store.get(first.id), null);
  assert.equal(store.get(second.id).entries.length, 2);
  assert.deepEqual([store.size, store.total], [1, 2]);
});

test('超过 8 个淘汰最久没用的；取用过的算新用的', () => {
  const store = createSnapshots();
  const made = Array.from({ length: 8 }, (_, i) => put(store, `d${i}`));
  store.get(made[0].id); // d0 刚用过，d1 成了最久的
  const ninth = put(store, 'd8');
  assert.equal(store.size, 8);
  assert.equal(store.get(made[1].id), null);
  assert.ok(store.get(made[0].id) && store.get(ninth.id));
});

test('总条目超过上限淘汰最久没用的，按需要淘汰到放得下', () => {
  const store = createSnapshots({ maxEntries: 10 });
  const a = put(store, 'a', 4), b = put(store, 'b', 4), c = put(store, 'c', 3);
  assert.equal(store.get(a.id), null);
  assert.ok(store.get(b.id) && store.get(c.id));
  assert.equal(store.total, 7);
  const d = put(store, 'd', 9);
  assert.deepEqual([store.get(b.id), store.get(c.id)], [null, null]);
  assert.equal(store.get(d.id).entries.length, 9);
  assert.equal(store.total, 9);
});

test('闲置超过 60 秒的在下一次访问时清掉，不起定时器；取用会重新计时', () => {
  const time = clock();
  const store = createSnapshots({ now: time.now });
  const kept = put(store, 'kept'), idle = put(store, 'idle');
  time.at += 50_000;
  assert.ok(store.get(kept.id));
  time.at += 50_000; // kept 距上次取用 50 秒，idle 已 100 秒
  assert.equal(store.get(idle.id), null);
  assert.ok(store.get(kept.id));
  time.at += SNAPSHOT_IDLE_MS + 1;
  assert.equal(store.get(kept.id), null);
  assert.deepEqual([store.size, store.total], [0, 0]);
});

test('闲置的快照在存新快照时也被清掉，总量跟着减', () => {
  const time = clock();
  const store = createSnapshots({ now: time.now });
  put(store, 'old', 5);
  time.at += SNAPSHOT_IDLE_MS + 1;
  put(store, 'new', 2);
  assert.deepEqual([store.size, store.total], [1, 2]);
});

test('释放和清空', () => {
  const store = createSnapshots();
  const a = put(store, 'a', 2), b = put(store, 'b', 3);
  store.release(a.id);
  store.release(a.id); // 重复释放不出错、不重复扣总量
  assert.deepEqual([store.get(a.id), store.total], [null, 3]);
  store.clear();
  assert.deepEqual([store.get(b.id), store.size, store.total], [null, 0, 0]);
});
