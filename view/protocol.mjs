// 模块和页面共用的消息格式与上限。只用浏览器和 Node 都有的东西。

// 宿主按 JSON.stringify({ message }).length 计量，超过的消息会被丢弃。
export const MESSAGE_LIMIT = 128 * 1024;
export const CHUNK_BYTES = 64 * 1024;
// 目录一页的上限（序列化后的 UTF-8 字节，含信封）；信封（类型、代次、请求号、游标）留给下面这些字节。
export const PAGE_BYTES = 96 * 1024;
export const ENVELOPE_BYTES = 4096;
export const TEXT_LIMIT = 1024 * 1024;
export const IMAGE_LIMIT = 8 * 1024 * 1024;
// 前这么多字节里有 NUL 就当二进制（照 Coda 判断二进制的惯例）。
export const SNIFF_BYTES = 8000;
export const REQUEST_ID_MAX = 64;
// 输入框草稿的文字上限（UTF-16 单元）；拼完超过就不写。
export const DRAFT_LIMIT = 100_000;

export const Type = Object.freeze({
  HELLO: 'hello', REFRESH: 'refresh', LIST: 'list', READ: 'read', STAT: 'stat', DIR_SIZE: 'dir_size', ADD_TEXT: 'add_text',
  DIR_SIZE_CANCEL: 'dir_size_cancel', // 没有回答
  SESSION: 'session', ROOT: 'root', CHANGED: 'changed',
  LISTED: 'listed', CHUNK: 'chunk', STATTED: 'statted', SIZED: 'sized', ADDED: 'added',
});

// 请求 → 回答的类型。模块回答、页面分发都查这一张。
export const ReplyOf = Object.freeze({
  [Type.LIST]: Type.LISTED, [Type.READ]: Type.CHUNK, [Type.STAT]: Type.STATTED,
  [Type.DIR_SIZE]: Type.SIZED, [Type.ADD_TEXT]: Type.ADDED,
});
export const isReply = type => Object.values(ReplyOf).includes(type);

export const RootState = Object.freeze({ READY: 'ready', NONE: 'none', PREPARING: 'preparing', GONE: 'gone' });

export const ErrorCode = Object.freeze({
  NO_ROOT: 'no_root', INVALID_PATH: 'invalid_path', OUTSIDE_ROOT: 'outside_root', NOT_FOUND: 'not_found',
  NOT_DIR: 'not_dir', NOT_FILE: 'not_file', DENIED: 'denied', CURSOR_EXPIRED: 'cursor_expired',
  INVALID_OFFSET: 'invalid_offset', INVALID_SORT: 'invalid_sort', TOO_LARGE: 'too_large', IO: 'io_error',
  DRAFT_FAILED: 'draft_failed', DRAFT_TOO_LONG: 'draft_too_long',
});

// 目录排序：值是下面四种之一，缺省（请求不带 sort）是名称。方向由排序键决定，只在 lib/tree.mjs 里定义一处。
export const SortKey = Object.freeze({ NAME: 'name', KIND: 'kind', DATE: 'date', SIZE: 'size' });
export const DEFAULT_SORT = SortKey.NAME;
// 是四种之一的返回它，否则 null（含旧版本保存过的 { key, desc } 对象）。
export const parseSort = raw => (Object.values(SortKey).includes(raw) ? raw : null);

// 目录条目的 kind：dir、file；link 是指向工作目录外或已失效的链接；other 是不能打开的（套接字、名字含控制字符等）。
// 指向工作目录内的链接按目标显示成 dir 或 file，并带 link: true。
// 条目还可带整数 size（只有文件有）和 mtimeMs（向下取整）；读不到时不带。
export const EntryKind = Object.freeze({ DIR: 'dir', FILE: 'file', LINK: 'link', OTHER: 'other' });
// 文件块的 kind。
export const ContentKind = Object.freeze({ TEXT: 'text', IMAGE: 'image', BINARY: 'binary' });

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

// 按扩展名给出图片的 MIME 类型，不是图片返回 null。
export function imageType(name) {
  const dot = String(name).lastIndexOf('.');
  return dot < 0 ? null : IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

export const messageSize = message => JSON.stringify({ message }).length;

// 带 code 的错误，模块里到处抛，主模块转成回答里的 error。
export function fail(code, message) {
  return Object.assign(new Error(message), { code, protocol: true });
}
