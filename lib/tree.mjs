// 读目录：先目录后文件，按名字不分大小写排序，按序列化字节数分页。模块回答全部条目，隐藏规则在页面。
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EntryKind, ENVELOPE_BYTES, ErrorCode, PAGE_BYTES, fail } from '../view/protocol.mjs';
import { fromFsError, isInside, isSafeName, resolveInRoot } from './paths.mjs';

const MAX_ENTRIES = 100_000;
const LINK_CONCURRENCY = 8;

const rank = entry => (entry.kind === EntryKind.DIR ? 0 : 1);
function compare(a, b) {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const x = a.name.toLowerCase(), y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
}

const encodeCursor = entry => Buffer.from(JSON.stringify([rank(entry), entry.name])).toString('base64url');
function decodeCursor(cursor) {
  try {
    const [group, name] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if ((group === 0 || group === 1) && typeof name === 'string') return { kind: group === 0 ? EntryKind.DIR : EntryKind.FILE, name };
  } catch { /* 下面统一报错 */ }
  throw fail(ErrorCode.INVALID_CURSOR, '游标无效');
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index]); }
  }));
  return results;
}

// 只有符号链接要额外解析：目标在根目录内按目标显示，在外或已失效显示为 link。
async function classify(root, dir, dirent) {
  const { name } = dirent;
  if (!isSafeName(name)) return { name, kind: EntryKind.OTHER };
  if (dirent.isDirectory()) return { name, kind: EntryKind.DIR };
  if (dirent.isFile()) return { name, kind: EntryKind.FILE };
  if (!dirent.isSymbolicLink()) return { name, kind: EntryKind.OTHER };
  try {
    const real = await realpath(join(dir, name));
    if (!isInside(root, real)) return { name, kind: EntryKind.LINK };
    const info = await stat(real);
    const kind = info.isDirectory() ? EntryKind.DIR : info.isFile() ? EntryKind.FILE : EntryKind.OTHER;
    return { name, kind, link: true };
  } catch { return { name, kind: EntryKind.LINK }; }
}

// 游标是上一页最后一条的排序键，所以每页都重新读目录；条目增减不会造成重复，也不会漏掉游标之后的。
export async function listDirectory(root, path, cursor, { maxEntries = MAX_ENTRIES, pageBytes = PAGE_BYTES } = {}) {
  const dir = await resolveInRoot(root, path);
  let dirents;
  try { dirents = await readdir(dir, { withFileTypes: true }); } catch (error) { throw fromFsError(error); }
  if (dirents.length > maxEntries) throw fail(ErrorCode.TOO_LARGE, `目录条目超过 ${maxEntries} 个`);
  const entries = await mapLimit(dirents, LINK_CONCURRENCY, dirent => classify(root, dir, dirent));
  entries.sort(compare);

  const after = cursor == null ? null : decodeCursor(cursor);
  let index = 0;
  if (after) while (index < entries.length && compare(entries[index], after) <= 0) index++;

  const page = [];
  let used = 0;
  while (index < entries.length) {
    const size = Buffer.byteLength(JSON.stringify(entries[index])) + 1;
    if (page.length && used + size > pageBytes - ENVELOPE_BYTES) break;
    used += size;
    page.push(entries[index++]);
  }
  return { entries: page, nextCursor: index < entries.length ? encodeCursor(page[page.length - 1]) : null };
}
