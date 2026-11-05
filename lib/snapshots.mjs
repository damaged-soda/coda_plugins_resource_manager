// 日期、大小排序的快照：第一页读全部条目并排好序，之后的页只从这里取，不再碰文件系统。
// 快照属于一个视图，由 main.mjs 建一份传给 lib/tree.mjs；这里只管存放、淘汰和释放，不碰 fs。
export const MAX_SNAPSHOTS = 8;
export const MAX_SNAPSHOT_ENTRIES = 100_000;
export const SNAPSHOT_IDLE_MS = 60_000;

export function createSnapshots({
  now = Date.now, maxCount = MAX_SNAPSHOTS, maxEntries = MAX_SNAPSHOT_ENTRIES, idleMs = SNAPSHOT_IDLE_MS,
} = {}) {
  const items = new Map(); // id → 快照；Map 的顺序就是最近使用的顺序，最前面的最久没用
  let nextId = 1, total = 0;

  const drop = id => {
    const item = items.get(id);
    if (item) { total -= item.entries.length; items.delete(id); }
  };
  // 不起定时器：每次访问任何快照时顺便清掉闲置的。
  const sweep = () => {
    const time = now();
    for (const [id, item] of items) if (time - item.used > idleMs) drop(id);
  };

  return {
    get size() { return items.size; },
    get total() { return total; },

    // 取快照并记为刚用过；已被淘汰、释放或闲置过期的返回 null。
    get(id) {
      sweep();
      const item = items.get(id);
      if (!item) return null;
      item.used = now();
      items.delete(id);
      items.set(id, item);
      return item;
    },

    // 存一份，替换同身份的旧快照，超出数量或总条目时淘汰最久没用的。id 递增、不复用，旧游标不会指到新快照上。
    put({ identity, root, path, entries }) {
      sweep();
      for (const [id, item] of items) if (item.identity === identity) drop(id);
      while (items.size > 0 && (items.size >= maxCount || total + entries.length > maxEntries)) drop(items.keys().next().value);
      const item = { id: nextId++, identity, root, path, entries, used: now() };
      items.set(item.id, item);
      total += entries.length;
      return item;
    },

    release: drop,
    clear() { items.clear(); total = 0; },
  };
}
