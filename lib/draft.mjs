// 把文字追加到会话的输入框草稿（设计见 docs/design/phase-3.md 第 13.5 节）。
// 用的是 Coda 未公开的草稿接口：依赖它的代码只在这一个文件里，上游开放正式接口后只改这里。
// 流程：读草稿 → 拼文字 → 保存。保存带上现有附件的 ID，否则会删掉用户已添加的附件。
import { DRAFT_LIMIT, ErrorCode, fail } from '../view/protocol.mjs';

const RETRIES = 2; // 版本不符后用服务端的内容重拼，最多再试这么多次

// block 为 false（路径、位置）：接在现有文字后面，前后各留一个空格（已有空白或为空时前面不加）。
// block 为 true（内容）：另起一行，结尾换行；文字本身已以换行结尾的不再多加，免得多出空行。只能追加到末尾。
export function compose(current, text, block) {
  if (block) return `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${text}${text.endsWith('\n') ? '' : '\n'}`;
  return `${current}${current === '' || /\s$/.test(current) ? '' : ' '}${text} `;
}

const failed = () => fail(ErrorCode.DRAFT_FAILED, '读写草稿失败');

// 接口回答里的草稿 → { text, revision, ids }；形状不对算失败。
function parseDraft(draft) {
  if (typeof draft?.text !== 'string' || !Array.isArray(draft.attachments)) throw failed();
  const ids = draft.attachments.map(attachment => attachment?.id);
  if (!ids.every(id => typeof id === 'string')) throw failed();
  return { text: draft.text, revision: draft.revision, ids };
}

// 追加成功返回 true；valid() 变假（会话换了、视图关了）静默结束，返回 false：不写、不报。
// 每次保存之前、每个 await 回来之后都核对，重试也始终写传进来的这个会话。
// 失败抛 draft_failed，拼完超过上限抛 draft_too_long，不截断。
export async function addText(coda, session, { text, block }, { valid = () => true } = {}) {
  if (typeof text !== 'string' || text.includes('\0') || typeof block !== 'boolean') throw failed();
  const path = `threads/${encodeURIComponent(session)}/draft`;
  const call = async body => {
    try { return await (body ? coda.api(path, body) : coda.api(path)); } catch { throw failed(); }
  };

  const first = await call();
  if (!valid()) return false;
  let draft = parseDraft(first);
  for (let attempt = 0; ; attempt++) {
    const next = compose(draft.text, text, block);
    if (next.length > DRAFT_LIMIT) throw fail(ErrorCode.DRAFT_TOO_LONG, '草稿太长，放不下');
    const saved = await call({ text: next, attachments: draft.ids, revision: draft.revision });
    if (!valid()) return false;
    if (!saved?.conflict) return true;
    if (attempt >= RETRIES) throw failed();
    draft = parseDraft(saved.draft);
    if (!valid()) return false;
  }
}
