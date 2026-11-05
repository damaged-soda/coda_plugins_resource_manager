// 路径校验：页面只传相对路径，读取只用这里返回的规范路径。
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { ErrorCode, fail, hasControl, splitRelative } from '../view/protocol.mjs';

// 名字里能不能带进路径（含控制字符的名字只显示，不能打开）。
export const isSafeName = name => !hasControl(name);

// 相对路径 → 片段。规则在 view/protocol.mjs 的 splitRelative，页面恢复 cwd 时用的是同一个。
export function parseRelative(path) {
  const { segments, problem } = splitRelative(path);
  if (problem) throw fail(ErrorCode.INVALID_PATH, problem);
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
