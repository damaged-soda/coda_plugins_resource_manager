// 图标视图：一次看一层（model.cwd）。visibleCells 把模型压成扁平的单元格（纯逻辑），layoutOf 生成布局映射，mountGrid 只画可见的一段，上万条也不卡。
// 设计见 docs/design/phase-3.md 第 14 节。进入、返回、恢复滚动在页面（app.mjs）。
import { h } from './dom.mjs';
import { infoText } from './format.mjs';
import { mountGestures } from './gestures.mjs';
import { icon, iconFor } from './icons.mjs';
import { isHidden, joinPath } from './model.mjs';
import { EntryKind } from './protocol.mjs';
import { TITLES, rootName } from './tree.mjs';

const OVERSCAN = 2; // 上下多画几行

// 单元格：{ type: 'entry', path, name, kind, link, size, mtimeMs } 是条目；{ type: 'status' | 'more', path, text, retry? } 是说明项，独占一行。
// 说明的文字和 tree.mjs 的 visibleRows 一致，只是没有层级。
export function visibleCells(model) {
  const dir = model.cwd, state = model.dirs.get(dir), cells = [];
  const note = (text, retry) => ({ type: 'status', path: dir, text, ...(retry ? { retry } : {}) });
  if (!state || (!state.loaded && !state.error)) return [note('正在读取…')];
  if (!state.loaded) return [note(`读取失败：${state.error.message}`, true)];
  if (state.error) cells.push(note(`更新失败：${state.error.message}`, true)); // 刷新失败：旧条目保留，点它重试
  if (state.sortFallback) cells.push(note('条目太多，只能按名称排列'));
  const before = cells.length;
  for (const entry of state.entries) {
    if (!model.showHidden && isHidden(entry.name)) continue;
    cells.push({ type: 'entry', path: joinPath(dir, entry.name), name: entry.name, kind: entry.kind, link: entry.link === true, size: entry.size, mtimeMs: entry.mtimeMs });
  }
  if (state.next) cells.push({ type: 'more', path: dir, text: state.loading ? '正在读取…' : '再显示' });
  else if (cells.length === before) cells.push(note(state.entries.length ? '只有隐藏项' : '空目录'));
  return cells;
}

// 布局映射：一次生成，总高度、可见窗口、点击都用它。连续的条目各段占 ceil(n / 列数) 行，每个说明项独占一行；列数至少为 1。
// spans：{ from, count, row, rows, note } 按行从上到下。
export function layoutOf(cells, columns) {
  const cols = Math.max(1, Math.floor(columns) || 1), spans = [];
  let rows = 0;
  for (let at = 0; at < cells.length;) {
    if (cells[at].type !== 'entry') { spans.push({ from: at, count: 1, row: rows, rows: 1, note: true }); rows++; at++; continue; }
    let end = at;
    while (end < cells.length && cells[end].type === 'entry') end++;
    const span = { from: at, count: end - at, row: rows, rows: Math.ceil((end - at) / cols), note: false };
    spans.push(span);
    rows += span.rows;
    at = end;
  }
  return { cols, rows, spans };
}

const spanAt = (layout, row) => layout.spans.find(span => row >= span.row && row < span.row + span.rows);
// 这一行第一个单元格的序号。
export const firstOfRow = (layout, row) => { const span = spanAt(layout, row); return span.note ? span.from : span.from + (row - span.row) * layout.cols; };
// 这个序号的单元格在第几行。
export function rowOfCell(layout, index) {
  const span = layout.spans.find(item => index >= item.from && index < item.from + item.count);
  return span.note ? span.row : span.row + Math.floor((index - span.from) / layout.cols);
}
// 第 first 行（含）到第 last 行（不含）的单元格序号范围 [from, to)。
export function windowOf(layout, first, last) {
  if (first >= last) return { from: 0, to: 0 };
  const from = firstOfRow(layout, first), tail = spanAt(layout, last - 1);
  return { from, to: Math.min(tail.from + tail.count, tail.note ? tail.from + 1 : firstOfRow(layout, last - 1) + layout.cols) };
}

// handlers: { open(path), enter(path), more(path), retry(path), menu(event, cell), back? }
// back 给了就在头部最左边放「返回」（Mac，和没有原生返回的环境）；不给就没有头部，iPhone 用原生返回，标题在工具条上。
// draggable、longPress 同 mountTree。
export function mountGrid(el, model, handlers, { draggable = true, longPress = false } = {}) {
  const head = h('div', { class: 'ghead' }), body = h('div', { class: 'gbody' }), spacer = h('div', { class: 'gspacer' }), win = h('div', { class: 'gwin' });
  head.hidden = true;
  spacer.append(win);
  body.append(spacer);
  el.replaceChildren(head, body);
  let cells = [], layout = layoutOf([], 1), cellW = 72, cellH = 84, measuredWidth = -1, headKey = null;

  // 探针放在 win 里：量到的是单元格在真实结构里的宽和高。
  const measure = () => {
    const probe = h('div', { class: 'gi cell' });
    probe.style.visibility = 'hidden';
    win.append(probe);
    const box = probe.getBoundingClientRect();
    cellW = box.width || cellW;
    cellH = box.height || cellH;
    probe.remove();
  };
  const columns = () => Math.max(1, Math.floor(body.clientWidth / cellW));

  // 头部：返回、当前目录名。在根目录时没有返回键，标题是根目录名。
  function paintHead() {
    const name = model.cwd === '' ? (model.ready ? rootName(model.root.path) : '') : model.cwd.slice(model.cwd.lastIndexOf('/') + 1);
    const key = `${model.cwd}\n${name}`;
    head.hidden = !handlers.back || name === '';
    if (key === headKey) return;
    headKey = key;
    head.replaceChildren(...(handlers.back && model.cwd !== '' ? [h('button', { class: 'icon', 'aria-label': '返回', title: '返回', onclick: handlers.back }, icon('back', 18))] : []),
      h('span', { class: 'ghico', 'aria-hidden': 'true' }, icon('folder', 22)),
      h('div', { class: 'grow' }, h('div', { class: 'gname-head truncate', title: model.cwd || name }, name)));
  }

  function paint() {
    const top = body.scrollTop - (spacer.offsetTop || 0);
    const first = Math.max(0, Math.floor(top / cellH) - OVERSCAN);
    const last = Math.min(layout.rows, Math.ceil((top + body.clientHeight) / cellH) + OVERSCAN);
    const { from, to } = windowOf(layout, first, last);
    win.style.transform = `translateY(${(from === to ? 0 : rowOfCell(layout, from)) * cellH}px)`;
    win.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
    win.replaceChildren(...cells.slice(from, to).map((cell, i) => cellNode(cell, from + i)));
  }

  function cellNode(cell, index) {
    const node = h('div', { class: 'gi' });
    node.dataset.i = index;
    if (cell.type !== 'entry') {
      node.className = `gi gnote ${cell.type}`;
      node.textContent = cell.text;
      if (cell.retry) { node.classList.add('retry'); node.title = cell.text; } // 长原因在行里被截断，Mac 悬停看全
      return node;
    }
    const dead = cell.kind === EntryKind.LINK || cell.kind === EntryKind.OTHER;
    node.className = `gi cell ${cell.kind}${dead ? ' dead' : ''}${cell.path === model.selected ? ' sel' : ''}`;
    if (!dead && draggable) node.draggable = true;
    const glyph = h('span', { class: 'gico' }, icon(iconFor(cell), 32)), name = h('span', { class: 'gname' }, cell.name);
    const info = TITLES[cell.kind] ? '' : infoText(cell);
    node.title = TITLES[cell.kind] ? `${cell.path}\n${TITLES[cell.kind]}` : info ? `${cell.path}\n${info}` : cell.path;
    node.append(glyph, name);
    return node;
  }

  // 按现在的单元格和列数重新生成布局映射。列数变了（拖窄、旋转）：保持第一个可见的单元格还在顶部，不保持像素。
  function rebuild() {
    const cols = columns(), top = Math.max(0, body.scrollTop - (spacer.offsetTop || 0));
    const anchor = cols !== layout.cols && layout.rows && top > 0 ? firstOfRow(layout, Math.min(layout.rows - 1, Math.floor(top / cellH))) : null;
    layout = layoutOf(cells, cols);
    spacer.style.height = `${layout.rows * cellH}px`;
    if (anchor !== null && anchor < cells.length) body.scrollTop = (spacer.offsetTop || 0) + rowOfCell(layout, anchor) * cellH;
  }
  function relayout() {
    if (columns() !== layout.cols) rebuild();
    paint();
  }

  const gestures = mountGestures(el, {
    hit: event => cells[event.target.closest?.('.gi')?.dataset.i],
    pressable: cell => cell.type === 'entry',
    activate: cell => {
      if (cell.type === 'more') return handlers.more(cell.path);
      if (cell.type === 'status') return cell.retry ? handlers.retry(cell.path) : undefined;
      if (cell.kind === EntryKind.DIR) handlers.enter(cell.path);
      else if (cell.kind === EntryKind.FILE) handlers.open(cell.path);
    },
    menu: (event, cell) => handlers.menu(event, cell),
    dragText: cell => cell.path,
    longPress,
    scroller: body,
  });
  body.addEventListener('scroll', paint, { passive: true });
  new ResizeObserver(relayout).observe(body);

  return {
    // 隐藏过的网格显示后宽度变了：重量单元格，再算列数。
    render() {
      if (body.clientWidth !== measuredWidth) { measuredWidth = body.clientWidth; measure(); }
      cells = visibleCells(model);
      rebuild();
      paintHead();
      paint();
    },
    remeasure() { measuredWidth = body.clientWidth; measure(); this.render(); },
    scroll: () => body.scrollTop,
    scrollTo(top) { body.scrollTop = top; paint(); }, // 浏览器的滚动事件随后还会画一次；这里先画，位置才马上对
    onScroll(fn) { body.addEventListener('scroll', fn, { passive: true }); },
    get layout() { return layout; },
    // 切会话时调用：长按的等待和吞点击的标记都属于上一个会话。
    reset() { gestures.reset(); },
    dispose() { gestures.dispose(); },
  };
}
