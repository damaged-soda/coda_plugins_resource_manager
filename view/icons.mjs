// 图标：页面里自己画的 SVG，形状近似 SF Symbol，不打包 Apple 的符号。颜色都是 currentColor，由 CSS 定。
import { EntryKind } from './protocol.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

// 描边图标的 24×24 画法；folder 是填充的，单独标。
const SHAPES = {
  folder: { fill: true, shapes: [['path', { d: 'M3 7.2C3 5.98 3.98 5 5.2 5h4.05c.6 0 1.17.24 1.59.66L12 6.8h6.8C20.02 6.8 21 7.78 21 9v8.8c0 1.22-.98 2.2-2.2 2.2H5.2C3.98 20 3 19.02 3 17.8V7.2z' }]] },
  doc: { shapes: [['path', { d: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }], ['path', { d: 'M14 3v5h5' }], ['path', { d: 'M9 13h6M9 17h4' }]] },
  code: { shapes: [['path', { d: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }], ['path', { d: 'M14 3v5h5' }], ['path', { d: 'M10.5 12.5 8.5 15l2 2.5M13.5 12.5l2 2.5-2 2.5' }]] },
  image: { shapes: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }], ['circle', { cx: 9, cy: 10, r: 1.6 }], ['path', { d: 'm4 17 4.5-4.5 3.5 3.5 3-3 5 5' }]] },
  link: { shapes: [['path', { d: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1' }], ['path', { d: 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1' }]] },
  other: { shapes: [['path', { d: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }], ['path', { d: 'M14 3v5h5' }], ['path', { d: 'M9.5 14.5h5' }]] },
  chevron: { shapes: [['path', { d: 'm9 5 7 7-7 7' }]] },
  warning: { shapes: [['path', { d: 'M12 4 2.8 19.5h18.4L12 4z' }], ['path', { d: 'M12 10v4.5M12 17.2v.1' }]] },
  back: { shapes: [['path', { d: 'm15 5-7 7 7 7' }]] },
  check: { shapes: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]] },
  ellipsis: { fill: true, shapes: [['circle', { cx: 5.5, cy: 12, r: 1.7 }], ['circle', { cx: 12, cy: 12, r: 1.7 }], ['circle', { cx: 18.5, cy: 12, r: 1.7 }]] },
  refresh: { shapes: [['path', { d: 'M19 12a7 7 0 1 1-2.05-4.95' }], ['path', { d: 'M19 4.5v3.8h-3.8' }]] },
  copy: { shapes: [['rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2.2 }], ['path', { d: 'M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8' }]] },
  window: { shapes: [['rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2.5 }], ['path', { d: 'M3.5 9.5h17' }]] },
  turn: { shapes: [['path', { d: 'M5 18v-4a4 4 0 0 1 4-4h10' }], ['path', { d: 'm15 6 4 4-4 4' }]] },
};

// 扩展名表：不在表里的文件都是文档。
const BY_EXT = {
  code: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'yml', 'yaml', 'toml', 'html', 'css', 'scss', 'vue', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
    'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'sql', 'xml'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic', 'avif'],
};
const EXT_ICON = new Map(Object.entries(BY_EXT).flatMap(([name, exts]) => exts.map(ext => [ext, name])));

// 图标名：目录、链接、其他按种类；文件按扩展名（不分大小写；.gitignore 这类点开头的没有扩展名），没有匹配的是文档。
export function iconFor({ kind, name }) {
  if (kind === EntryKind.DIR) return 'folder';
  if (kind === EntryKind.LINK) return 'link';
  if (kind === EntryKind.OTHER) return 'other';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && EXT_ICON.get(name.slice(dot + 1).toLowerCase())) || 'doc';
}

// 造一个 SVG 元素；size 是点数，CSS 可以按平台覆盖。
export function icon(name, size = 16) {
  const { fill = false, shapes } = SHAPES[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', ...(fill
    ? { fill: 'currentColor' }
    : { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  for (const [tag, shape] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(shape)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}
