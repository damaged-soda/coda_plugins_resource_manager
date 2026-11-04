// 目录树和菜单里的文字格式：大小、修改日期。纯函数，不依赖运行环境的语言设置；now 由调用方给。
import { EntryKind, SortKey } from './protocol.mjs';

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const two = n => String(n).padStart(2, '0');

// 相对格式，按本地时间：今天 14:05，今年 11月4日，往年 2025年3月。
export function formatDate(ms, now) {
  const date = new Date(ms), current = new Date(now);
  if (date.getFullYear() !== current.getFullYear()) return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  if (date.getMonth() !== current.getMonth() || date.getDate() !== current.getDate()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

// 完整的修改时间：2025-03-04 14:05:09。
export function formatFullDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const MISSING = '—';
// 条目的大小和日期，读不到的部分是 —；文件夹没有大小。
export const sizeText = entry => (entry.kind !== EntryKind.DIR && Number.isInteger(entry.size) ? formatSize(entry.size) : MISSING);
export const dateText = (entry, now) => (Number.isInteger(entry.mtimeMs) ? formatDate(entry.mtimeMs, now) : MISSING);
// 菜单信息行和 Mac 的 title：大小 · 完整修改时间。
export const infoText = entry => `${sizeText(entry)} · ${Number.isInteger(entry.mtimeMs) ? formatFullDate(entry.mtimeMs) : MISSING}`;

const NAMES = { [SortKey.NAME]: '名称', [SortKey.KIND]: '种类', [SortKey.DATE]: '日期', [SortKey.SIZE]: '大小' };
export const sortName = key => NAMES[key];
export const sortOrder = desc => (desc ? '降序' : '升序');
export const sortArrow = desc => (desc ? '↓' : '↑');
// 可访问名称：排序：日期，降序。
export const sortAria = ({ key, desc }) => `排序：${NAMES[key]}，${sortOrder(desc)}`;

// 选一个排序键后的排序：选当前项是反向，选别的项用它的默认方向（名称、种类升序，日期、大小降序）。
export const nextSort = (current, key) => ({
  key, desc: key === current.key ? !current.desc : key === SortKey.DATE || key === SortKey.SIZE,
});
