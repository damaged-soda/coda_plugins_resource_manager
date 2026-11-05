// 属性和文件夹大小（设计见 docs/design/phase-3.md 第 13.3、13.4 节）。
// 只读：都经视图共用的读取状态（lib/tree.mjs 的 createListing）的 fs 和并发上限，不另起一套。
import { basename, join, relative, sep } from 'node:path';
import { EntryKind } from '../view/protocol.mjs';
import { fromFsError, parseRelative, resolveInRoot } from './paths.mjs';
import { classifyLink } from './tree.mjs';

export const DIR_SIZE_ITEMS = 200_000;
export const DIR_SIZE_MS = 5000;
// 一批同时排进并发上限的 lstat 数；等它们回来才排下一批。
const BATCH = 4;

const integer = value => (Number.isFinite(value) ? Math.floor(value) : undefined);

// 一个条目自己的元数据：size 只有文件有，读不到的不带。
function metaOf(info, kind) {
  const meta = {};
  const mtimeMs = integer(info.mtimeMs), birthtimeMs = integer(info.birthtimeMs), mode = integer(info.mode);
  if (kind === EntryKind.FILE && integer(info.size) !== undefined) meta.size = integer(info.size);
  if (mtimeMs !== undefined) meta.mtimeMs = mtimeMs;
  if (birthtimeMs !== undefined && birthtimeMs > 0) meta.birthtimeMs = birthtimeMs; // 0 是文件系统没有这个值
  if (mode !== undefined) meta.mode = mode & 0o7777;
  return meta;
}

const kindOf = info => (info.isDirectory() ? EntryKind.DIR : info.isFile() ? EntryKind.FILE : EntryKind.OTHER);

// 先解析父目录，再 lstat 最后一级，不跟随链接。
// 指向工作目录内的链接按目标显示（target 是目标的相对路径）；指向外面或已失效的链接只给自己的元数据，不给目标路径。
export async function statPath(listing, root, path) {
  const segments = parseRelative(path);
  const { fs } = listing;
  let name, dir, item;
  try {
    if (segments.length === 0) {
      name = basename(root);
      item = { kind: EntryKind.DIR, info: await listing.run(() => fs.lstat(root)) };
    } else {
      name = segments[segments.length - 1];
      dir = await resolveInRoot(root, segments.slice(0, -1).join('/'));
      const own = await listing.run(() => fs.lstat(join(dir, name)));
      if (own.isSymbolicLink()) {
        const linked = await listing.run(() => classifyLink(fs, root, dir, name));
        item = linked.link
          ? { kind: linked.kind, info: linked.info, link: true, target: relative(root, linked.real).split(sep).join('/') }
          : { kind: EntryKind.LINK, info: own, link: true };
      } else item = { kind: kindOf(own), info: own };
    }
  } catch (error) { throw fromFsError(error); }
  const { kind, info, link, target } = item;
  const body = { name, kind };
  if (link) body.link = true;
  if (target !== undefined) body.target = target;
  return { ...body, ...metaOf(info, kind) };
}

// 文件夹大小：边读边统计，不一次性为全部条目建任务。
// - 同一时间只读一个目录，用只取名字的 readdir（不用 opendir、withFileTypes：文件系统不报类型时它们可能同步 lstat）。
// - lstat 一批最多 BATCH 个，经视图的并发上限排队，等回来才排下一批；排到名额后先核对停止条件再读。
// - 不跟随链接：链接算一项，不计大小。
// - 项数到 limit 或用时到 timeoutMs，立刻回答 complete: false，已发出的读取结果不再计入；
//   signal 中止、valid() 为假（会话、根目录变了或视图关了）静默停止，返回 null，不回答。
// - 子目录读不到、条目 lstat 失败都计入 unreadable；起点读不到才算错误。
export async function dirSize(listing, root, path, {
  valid = () => true, signal, limit = DIR_SIZE_ITEMS, timeoutMs = DIR_SIZE_MS,
} = {}) {
  const start = await resolveInRoot(root, path);
  const { fs } = listing;
  const total = { size: 0, items: 0, unreadable: 0 };
  let over = false;

  return new Promise((resolve, reject) => {
    let timer = null;
    // 结算一次：之后的一切读取结果、定时器、中止都不再有影响。
    const settle = done => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done();
    };
    const end = result => settle(() => resolve(result));
    const onAbort = () => end(null);
    // 停了没有。valid() 为假或已中止的在这里顺便结算成静默停止。
    const stopped = () => {
      if (over) return true;
      if (signal?.aborted || !valid()) { end(null); return true; }
      return false;
    };

    if (signal?.aborted) return end(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => end({ ...total, complete: false }), timeoutMs);

    // 数一个条目。读失败的也算一项。
    async function measure(dir, name, dirs) {
      if (stopped()) return; // 排到名额之后先核对
      let info = null;
      try { info = await fs.lstat(join(dir, name)); } catch { /* 下面计入 unreadable */ }
      if (stopped()) return; // 已经停了，回来的结果不再计入
      total.items++;
      if (!info) total.unreadable++;
      else if (info.isDirectory()) dirs.push(join(dir, name));
      else if (info.isFile()) total.size += Math.max(0, Math.floor(info.size) || 0);
    }

    async function walk() {
      const dirs = [start]; // 待访问的目录，数量不超过项数上限
      while (dirs.length > 0 && !stopped()) {
        const dir = dirs.pop();
        let names;
        try { names = await fs.readdir(dir); } catch (error) {
          if (dir === start) throw fromFsError(error);
          if (stopped()) return;
          total.unreadable++;
          continue;
        }
        let at = 0;
        while (at < names.length) {
          if (stopped()) return;
          if (total.items >= limit) return end({ ...total, complete: false });
          const batch = names.slice(at, at + Math.min(BATCH, limit - total.items));
          at += batch.length;
          await Promise.all(batch.map(name => listing.run(() => measure(dir, name, dirs))));
        }
        if (!stopped() && total.items >= limit && dirs.length > 0) return end({ ...total, complete: false });
      }
      end({ ...total, complete: true });
    }

    walk().catch(error => settle(() => reject(error)));
  });
}
