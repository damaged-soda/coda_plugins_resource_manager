// 分块读文件并判断类型。页面一块一块要，模块不记状态。
import { open } from 'node:fs/promises';
import {
  CHUNK_BYTES, ContentKind, ErrorCode, IMAGE_LIMIT, SNIFF_BYTES, TEXT_LIMIT, fail, imageType,
} from '../view/protocol.mjs';
import { fromFsError, parseRelative, resolveInRoot } from './paths.mjs';

async function readAt(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = length ? await handle.read(buffer, 0, length, position) : { bytesRead: 0 };
  return buffer.subarray(0, bytesRead);
}

// 返回 { data, offset, size, mtimeMs, kind, eof }。文本最多给前 TEXT_LIMIT 字节，
// 超过限制的图片和二进制文件不给内容（页面看 size 和 kind 说明）。
export async function readChunk(root, path, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw fail(ErrorCode.INVALID_OFFSET, '偏移无效');
  const real = await resolveInRoot(root, path);
  let handle;
  try { handle = await open(real, 'r'); } catch (error) { throw fromFsError(error); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail(ErrorCode.NOT_FILE, '不是文件');
    const { size, mtimeMs } = info;
    const image = imageType(parseRelative(path).at(-1) ?? '') !== null;
    const head = image ? null : await readAt(handle, 0, Math.min(SNIFF_BYTES, size));
    const kind = image ? ContentKind.IMAGE : head.includes(0) ? ContentKind.BINARY : ContentKind.TEXT;
    const limit = kind === ContentKind.TEXT ? TEXT_LIMIT : kind === ContentKind.IMAGE ? IMAGE_LIMIT : 0;
    const end = kind === ContentKind.IMAGE && size > limit ? 0 : Math.min(size, limit);
    const bytes = offset < end ? await readAt(handle, offset, Math.min(CHUNK_BYTES, end - offset)) : Buffer.alloc(0);
    return {
      data: bytes.toString('base64'), offset, size, mtimeMs, kind,
      eof: bytes.length === 0 || offset + bytes.length >= end,
    };
  } catch (error) { throw fromFsError(error); } finally { await handle.close(); }
}
