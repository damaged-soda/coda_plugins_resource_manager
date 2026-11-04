// 从会话取根目录。这是唯一读取 `threads/<id>` 返回结构（checkout）的地方，它不是文档写明的契约。
import { realpath, stat } from 'node:fs/promises';
import { RootState } from '../view/protocol.mjs';

export const NO_ROOT = Object.freeze({ state: RootState.NONE, path: null });

export const sameRoot = (a, b) => a?.state === b?.state && a?.path === b?.path;

// checkout.state 是 preparing、ready、failed。failed 没有可看的目录，按 none；
// ready 但目录已不在（归档后工作树被回收）是 gone。
// 查询失败（接口出错、读目录权限）直接抛出，由调用方保留上一次的结果。
export async function queryRoot(coda, session) {
  if (!session) return NO_ROOT;
  const thread = await coda.api(`threads/${encodeURIComponent(session)}`);
  const checkout = thread?.checkout;
  if (!checkout || typeof checkout !== 'object') return NO_ROOT;
  if (checkout.state === 'preparing') return { state: RootState.PREPARING, path: null };
  if (checkout.state !== 'ready' || typeof checkout.path !== 'string' || !checkout.path) return NO_ROOT;
  try {
    const real = await realpath(checkout.path);
    if ((await stat(real)).isDirectory()) return { state: RootState.READY, path: real };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  return { state: RootState.GONE, path: checkout.path };
}
