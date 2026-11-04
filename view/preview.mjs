// 文件预览：只接收路径和读块的能力，不依赖树的状态。readFile 是纯逻辑；mountPreview 才碰 DOM。
import { icon, iconFor } from './icons.mjs';
import { ContentKind, EntryKind, ErrorCode, IMAGE_LIMIT, TEXT_LIMIT, imageType } from './protocol.mjs';

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
// actions：头部在「复制路径」旁额外加的按钮 [{ label, icon, run(path) }]，预览不知道它们做什么。
// copyInHead：false 时头部不放「复制路径」（iPhone 放在底部工具条），由页面调 copyPath()。
// back：给了就在头部最左边放「返回」（Mac 侧栏预览：原生工具栏项目只能在右侧）；文件页和 iPhone 不传。
export function mountPreview(el, { read, copy, actions = [], copyInHead = true, back = null }) {
  const name = h('div', { class: 'pname truncate' }), meta = h('div', { class: 'pmeta caption secondary truncate' }, ' ');
  const fileIcon = h('span', { class: 'pico', 'aria-hidden': 'true' });
  // 图标按钮：可访问名称和 Mac 的悬停提示都是 label；没有图标的退回文字。
  const action = (label, glyph, run) => h('button', { class: glyph ? 'icon' : 'link', 'aria-label': label, title: label, onclick: run }, glyph ? icon(glyph, 18) : label);
  const copyPath = () => path !== null && copy(path);
  const retryButton = h('button', { class: 'link', onclick: () => load(null, true), hidden: true }, '重试');
  const body = h('div', { class: 'pbody' });
  const extra = actions.map(({ label, icon: glyph, run }) => action(label, glyph, () => path !== null && run(path)));
  el.replaceChildren(h('div', { class: 'phead' }, ...(back ? [action('返回', 'back', back)] : []), fileIcon, h('div', { class: 'grow' }, name, meta), retryButton,
    ...(copyInHead ? [action('复制路径', 'copy', copyPath)] : []), ...extra), body);

  let path = null, token = 0, shown = null, objectUrl = null; // shown：当前显示的 { size, mtimeMs }
  let metaText = ' ', metaTitle = '', stale = null; // stale：后台刷新失败的原因，此时正文还是上次的
  // 更新失败的提示占用元信息那一行，重试按钮在头部，所以正文不会被顶动。
  const paintMeta = () => {
    meta.textContent = stale ? `更新失败：${stale}` : metaText;
    meta.title = stale ?? metaTitle;
    meta.classList.toggle('warn', stale !== null);
    retryButton.hidden = stale === null;
  };
  const setMeta = (text, title = '') => { metaText = text; metaTitle = title; stale = null; paintMeta(); };
  const setStale = reason => { stale = reason; paintMeta(); };
  const revoke = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  const notice = (title, detail, action) => body.replaceChildren(h('div', { class: 'empty' },
    h('p', {}, title), detail ? h('p', { class: 'secondary' }, detail) : null,
    action ? h('button', { class: 'link', onclick: action.run }, action.label) : null));

  function show(result) {
    revoke();
    shown = { size: result.size, mtimeMs: result.mtimeMs };
    // 元信息：目录 · 行数 · 大小；根目录下的文件没有目录，非文本没有行数。修改时间放进 title。
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const lines = result.kind === ContentKind.TEXT ? `${lineCount(result.text)} 行` : '';
    const note = result.truncated ? `只显示前 ${formatSize(TEXT_LIMIT)}` : '';
    setMeta([dir, lines, formatSize(result.size), note].filter(Boolean).join(' · '), `修改于 ${formatTime(result.mtimeMs)}`);
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
    if (error.code === ErrorCode.NOT_FOUND) { shown = null; setMeta(' '); return notice('文件已不存在', path); }
    if (silent && shown) return setStale(error.message); // 后台刷新失败：保留正文，提示原因
    notice('读不到这个文件', error.message, { label: '重试', run: retry });
  }

  // silent：刷新。没变化不重画；变了就换内容，并尽量留在原来的滚动位置。
  async function load(scroll, silent) {
    const mine = ++token, mark = () => mine === token;
    if (!silent) { shown = null; setMeta('读取中…'); revoke(); body.replaceChildren(); }
    try {
      const result = await readFile(offset => read(path, offset), {
        prev: silent ? shown : null, cancelled: () => !mark(),
        onProgress: (got, total) => { if (mark() && !silent && total > TEXT_LIMIT / 4) setMeta(`读取中 ${formatSize(got)} / ${formatSize(total)}`); },
      });
      if (!mark() || result.cancelled) return;
      if (result.same) return setStale(null);
      const keep = scroll ?? { top: body.scrollTop, left: body.scrollLeft };
      show(result);
      body.scrollTop = keep.top; body.scrollLeft = keep.left;
    } catch (error) {
      if (mark()) failure(error, silent, () => load(null, false));
    }
  }

  return {
    open(next, scroll = null) {
      path = next;
      const base = next.split('/').pop();
      name.textContent = base;
      name.title = next;
      fileIcon.replaceChildren(icon(iconFor({ kind: EntryKind.FILE, name: base }), 22));
      return load(scroll, false);
    },
    copyPath,
    refresh() { return path === null ? undefined : load(null, true); },
    // 内容的来源变了（根目录换了位置）：旧正文不能留，也不能按元数据判断「没变」。
    reload() { return path === null ? undefined : load(null, false); },
    close() { token++; path = null; shown = null; setMeta(' '); revoke(); body.replaceChildren(); },
    scroll: () => ({ top: body.scrollTop, left: body.scrollLeft }),
    onScroll: fn => body.addEventListener('scroll', fn, { passive: true }),
    get path() { return path; },
  };
}
