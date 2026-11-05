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

// 种类表：种类文字（属性页）和图标（目录树、预览头部）查同一张，不另写一份。
// glyph 是上面 SHAPES 里的图标名；tone 是第 3 步配色用的色调名，现在还没有用。
const KINDS = {
  dir: { glyph: 'folder', tone: 'accent', label: '文件夹' },
  link: { glyph: 'link', tone: 'muted', label: '链接' },
  other: { glyph: 'other', tone: 'muted', label: '特殊文件' },
  file: { glyph: 'doc', tone: 'gray', label: '其他文件' },
  text: { glyph: 'doc', tone: 'gray', label: '文本' },
  markdown: { glyph: 'doc', tone: 'blue', label: 'Markdown 文档' },
  typescript: { glyph: 'code', tone: 'blue', label: 'TypeScript' },
  javascript: { glyph: 'code', tone: 'yellow', label: 'JavaScript' },
  python: { glyph: 'code', tone: 'green', label: 'Python' },
  go: { glyph: 'code', tone: 'teal', label: 'Go' },
  rust: { glyph: 'code', tone: 'orange', label: 'Rust' },
  swift: { glyph: 'code', tone: 'orange', label: 'Swift' },
  c: { glyph: 'code', tone: 'blue', label: 'C / C++' },
  java: { glyph: 'code', tone: 'red', label: 'Java / Kotlin' },
  ruby: { glyph: 'code', tone: 'red', label: 'Ruby' },
  code: { glyph: 'code', tone: 'gray', label: '源代码' },
  json: { glyph: 'code', tone: 'yellow', label: 'JSON' },
  html: { glyph: 'code', tone: 'orange', label: 'HTML / XML' },
  css: { glyph: 'code', tone: 'purple', label: 'CSS' },
  yaml: { glyph: 'code', tone: 'pink', label: 'YAML / TOML' },
  shell: { glyph: 'code', tone: 'green', label: 'Shell 脚本' },
  image: { glyph: 'image', tone: 'purple', label: '图片' },
  video: { glyph: 'doc', tone: 'pink', label: '视频' },
  audio: { glyph: 'doc', tone: 'pink', label: '音频' },
  pdf: { glyph: 'doc', tone: 'red', label: 'PDF 文档' },
  archive: { glyph: 'doc', tone: 'orange', label: '压缩包' },
  sheet: { glyph: 'doc', tone: 'green', label: '表格' },
  database: { glyph: 'doc', tone: 'teal', label: '数据库' },
  font: { glyph: 'doc', tone: 'gray', label: '字体' },
  lock: { glyph: 'doc', tone: 'gray', label: '锁文件' },
  git: { glyph: 'doc', tone: 'orange', label: 'Git 配置' },
  env: { glyph: 'doc', tone: 'yellow', label: '环境变量' },
  manifest: { glyph: 'doc', tone: 'green', label: '包清单' },
  license: { glyph: 'doc', tone: 'gray', label: '许可证' },
};

// 文件名（小写）优先，再按扩展名（小写）；都不在表里的是「其他文件」。
const NAMES = {
  git: ['.gitignore', '.gitattributes', '.gitmodules', '.gitconfig', '.gitkeep', '.mailmap'],
  env: ['.env', '.envrc'],
  manifest: ['package.json', 'cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'gemfile', 'package.swift', 'pom.xml', 'build.gradle', 'composer.json', 'setup.py'],
  lock: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'bun.lockb', 'podfile.lock'],
  license: ['license', 'licence', 'copying', 'unlicense', 'license.md', 'license.txt', 'licence.md', 'licence.txt', 'copying.md', 'copying.txt'],
};
const EXTENSIONS = {
  text: ['txt', 'text', 'log', 'rtf'],
  markdown: ['md', 'markdown', 'mdx'],
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  python: ['py', 'pyw', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  swift: ['swift'],
  c: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'],
  java: ['java', 'kt', 'kts'],
  ruby: ['rb', 'erb'],
  code: ['vue', 'scss', 'sass', 'less', 'cs', 'php', 'lua', 'sql', 'dart', 'scala', 'r', 'pl'],
  json: ['json', 'jsonc', 'json5'],
  html: ['html', 'htm', 'xml', 'xhtml', 'plist'],
  css: ['css'],
  yaml: ['yml', 'yaml', 'toml'],
  shell: ['sh', 'bash', 'zsh', 'fish'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic', 'avif', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff'],
  pdf: ['pdf'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
  sheet: ['csv', 'tsv', 'xls', 'xlsx', 'numbers', 'ods'],
  database: ['db', 'sqlite', 'sqlite3'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
};
const invert = table => new Map(Object.entries(table).flatMap(([id, keys]) => keys.map(key => [key, id])));
const BY_NAME = invert(NAMES), BY_EXT = invert(EXTENSIONS);

// 一个条目的种类：{ glyph, tone, label }。目录、链接、其他按种类；文件先按整个文件名，再按扩展名（点开头的名字没有扩展名）。
// 指向工作目录内的链接按目标的种类显示（条目自己的 kind 已经是目标的）。
export function kindOf({ kind, name }) {
  if (kind === EntryKind.DIR) return KINDS.dir;
  if (kind === EntryKind.LINK) return KINDS.link;
  if (kind === EntryKind.OTHER) return KINDS.other;
  const lower = String(name).toLowerCase(), dot = lower.lastIndexOf('.');
  return KINDS[BY_NAME.get(lower) ?? (lower.startsWith('.env.') ? 'env' : undefined) ?? (dot > 0 ? BY_EXT.get(lower.slice(dot + 1)) : undefined) ?? 'file'];
}

// 图标名：种类表里的 glyph。
export const iconFor = entry => kindOf(entry).glyph;

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
