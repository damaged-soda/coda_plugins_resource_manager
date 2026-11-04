// 文件预览：只接收路径和读块的能力，不依赖树的状态。readFile 是纯逻辑；mountPreview 才碰 DOM。
import { ContentKind, ErrorCode, IMAGE_LIMIT, TEXT_LIMIT, imageType } from './protocol.mjs';

function fromBase64(data) {
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 一块一块读完一个文件。read(offset) 返回 chunk 回答。
// 文本把所有块拼成字节后再解码，多字节字符被块边界切开也没关系。
// 传入 prev（上次的 size、mtimeMs）时，没变就只返回 { same: true }；读的途中文件变了就重读，最多三次。
export async function readFile(read, { prev = null, onProgress = () => {}, cancelled = () => false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let chunk = await read(0);
    if (prev && chunk.size === prev.size && chunk.mtimeMs === prev.mtimeMs) return { same: true };
    const { kind, size, mtimeMs } = chunk;
    const total = kind === ContentKind.TEXT ? Math.min(size, TEXT_LIMIT) : kind === ContentKind.IMAGE && size <= IMAGE_LIMIT ? size : 0;
    const parts = [];
    let got = 0, moved = false;
    for (;;) {
      const bytes = fromBase64(chunk.data);
      parts.push(bytes);
      got += bytes.length;
      onProgress(got, total);
      if (chunk.eof || bytes.length === 0) break;
      if (cancelled()) return { cancelled: true };
      chunk = await read(got);
      if (chunk.size !== size || chunk.mtimeMs !== mtimeMs) { moved = true; break; }
    }
    if (moved) continue;
    const all = new Uint8Array(got);
    let at = 0;
    for (const part of parts) { all.set(part, at); at += part.length; }
    const result = { same: false, kind, size, mtimeMs, bytes: all, truncated: kind === ContentKind.TEXT && size > TEXT_LIMIT };
    if (kind === ContentKind.TEXT) {
      result.text = new TextDecoder().decode(all);
      if (result.truncated && result.text.endsWith('�')) result.text = result.text.slice(0, -1); // 1 MiB 处可能切在字符中间
    }
    return result;
  }
  const error = new Error('文件一直在变化，稍后再试');
  throw Object.assign(error, { code: ErrorCode.IO });
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
const formatTime = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false });
export const lineCount = text => (text === '' ? 1 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

const h = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else if (value != null && value !== false) node.setAttribute(key, value);
  }
  node.append(...children.flat().filter(child => child != null));
  return node;
};

// read(path, offset) → Promise<chunk 回答>，会话换了会以 stale 错误拒绝；copy(text) 复制路径。
export function mountPreview(el, { read, copy }) {
  const name = h('div', { class: 'pname truncate' }), meta = h('div', { class: 'pmeta caption secondary truncate' }, ' ');
  const copyButton = h('button', { class: 'link', onclick: () => path !== null && copy(path) }, '复制路径');
  const body = h('div', { class: 'pbody' });
  el.replaceChildren(h('div', { class: 'phead' }, h('div', { class: 'grow' }, name, meta), copyButton), body);

  let path = null, token = 0, shown = null, objectUrl = null; // shown：当前显示的 { size, mtimeMs }
  const revoke = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  const notice = (title, detail, action) => body.replaceChildren(h('div', { class: 'empty' },
    h('p', {}, title), detail ? h('p', { class: 'secondary' }, detail) : null,
    action ? h('button', { class: 'link', onclick: action.run }, action.label) : null));

  function show(result) {
    revoke();
    shown = { size: result.size, mtimeMs: result.mtimeMs };
    const note = result.truncated ? `只显示前 ${formatSize(TEXT_LIMIT)}` : '';
    meta.textContent = [formatSize(result.size), formatTime(result.mtimeMs), note].filter(Boolean).join(' · ');
    if (result.kind === ContentKind.TEXT) {
      const gutter = h('pre', { class: 'gutter', 'aria-hidden': 'true' }, Array.from({ length: lineCount(result.text) }, (_, i) => i + 1).join('\n'));
      body.replaceChildren(h('div', { class: 'code' }, gutter, h('pre', { class: 'text selectable' }, result.text)));
    } else if (result.kind === ContentKind.IMAGE && result.bytes.length > 0) {
      objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: imageType(path) }));
      body.replaceChildren(h('div', { class: 'image' }, h('img', { src: objectUrl, alt: path, draggable: 'false' })));
    } else {
      const big = result.kind === ContentKind.IMAGE ? `图片超过 ${formatSize(IMAGE_LIMIT)}，不预览。` : '二进制文件，不预览。';
      notice(big, `${formatSize(result.size)}，修改于 ${formatTime(result.mtimeMs)}`);
    }
  }

  function failure(error, silent, retry) {
    if (error.stale) return;
    if (error.code === ErrorCode.NOT_FOUND) { shown = null; meta.textContent = ' '; return notice('文件已不存在', path); }
    if (silent && shown) return; // 后台刷新失败，保留已有内容
    notice('读不到这个文件', error.message, { label: '重试', run: retry });
  }

  // silent：刷新。没变化不重画；变了就换内容，并尽量留在原来的滚动位置。
  async function load(scroll, silent) {
    const mine = ++token, mark = () => mine === token;
    if (!silent) { shown = null; meta.textContent = '读取中…'; revoke(); body.replaceChildren(); }
    try {
      const result = await readFile(offset => read(path, offset), {
        prev: silent ? shown : null, cancelled: () => !mark(),
        onProgress: (got, total) => { if (mark() && !silent && total > TEXT_LIMIT / 4) meta.textContent = `读取中 ${formatSize(got)} / ${formatSize(total)}`; },
      });
      if (!mark() || result.cancelled || result.same) return;
      const keep = scroll ?? { top: body.scrollTop, left: body.scrollLeft };
      show(result);
      body.scrollTop = keep.top; body.scrollLeft = keep.left;
    } catch (error) {
      if (mark()) failure(error, silent, () => load(null, false));
    }
  }

  return {
    open(next, scroll = null) { path = next; name.textContent = next.split('/').pop(); name.title = next; return load(scroll, false); },
    refresh() { return path === null ? undefined : load(null, true); },
    close() { token++; path = null; shown = null; revoke(); body.replaceChildren(); },
    scroll: () => ({ top: body.scrollTop, left: body.scrollLeft }),
    onScroll: fn => body.addEventListener('scroll', fn, { passive: true }),
    get path() { return path; },
  };
}
