// 路径校验：页面只传相对路径，读取只用这里返回的规范路径。
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { ErrorCode, fail } from '../view/protocol.mjs';

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 4096;

// 名字里能不能带进路径（含控制字符的名字只显示，不能打开）。
export const isSafeName = name => !CONTROL.test(name);

// 相对路径 → 片段。空串是根目录；拒绝绝对路径、`..`、控制字符。
export function parseRelative(path) {
  if (typeof path !== 'string' || path.length > MAX_PATH) throw fail(ErrorCode.INVALID_PATH, '路径无效');
  if (CONTROL.test(path)) throw fail(ErrorCode.INVALID_PATH, '路径含控制字符');
  if (path.startsWith('/')) throw fail(ErrorCode.INVALID_PATH, '只接受相对路径');
  const segments = path.split('/').filter(part => part !== '' && part !== '.');
  if (segments.includes('..')) throw fail(ErrorCode.INVALID_PATH, '路径不能含 ..');
  return segments;
}

// 等于根目录，或以「根目录 + 分隔符」开头；不能只比前缀，否则 /repo-other 会误匹配 /repo。
export function isInside(root, target) {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

// 文件系统错误 → 带 code 的错误，不把带路径的原文交给页面。
export function fromFsError(error) {
  if (error?.protocol) return error;
  switch (error?.code) {
    case 'ENOENT': return fail(ErrorCode.NOT_FOUND, '不存在');
    case 'ENOTDIR': return fail(ErrorCode.NOT_DIR, '不是目录');
    case 'EISDIR': return fail(ErrorCode.NOT_FILE, '不是文件');
    case 'EACCES': case 'EPERM': return fail(ErrorCode.DENIED, '没有权限');
    case 'ELOOP': return fail(ErrorCode.NOT_FOUND, '链接循环');
    default: return fail(ErrorCode.IO, '读取失败');
  }
}

// 把相对路径解析成根目录内的规范路径；`root` 须是已取过 realpath 的根目录。
export async function resolveInRoot(root, path) {
  const segments = parseRelative(path);
  let real;
  try { real = await realpath(join(root, ...segments)); } catch (error) { throw fromFsError(error); }
  if (!isInside(root, real)) throw fail(ErrorCode.OUTSIDE_ROOT, '链接指向工作目录之外');
  return real;
}
