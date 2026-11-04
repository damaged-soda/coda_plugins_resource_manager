// 目录树：visibleRows 把模型压成扁平行（纯逻辑）；mountTree 只画可见的那一段，上万条也不卡。
import { EntryKind } from './protocol.mjs';
import { isHidden, joinPath } from './model.mjs';

const OVERSCAN = 8;

// 行：{ type: 'entry' | 'status' | 'more', path, name, depth, kind, link, open, busy, failed, text }
export function visibleRows(model) {
  const rows = [];
  const walk = (dir, depth) => {
    const state = model.dirs.get(dir);
    if (!state || (!state.loaded && !state.error)) return rows.push({ type: 'status', path: dir, depth, text: '正在读取…' });
    if (!state.loaded) return rows.push({ type: 'status', path: dir, depth, text: `读取失败：${state.error.message}`, retry: true });
    const before = rows.length;
    for (const entry of state.entries) {
      if (!model.showHidden && isHidden(entry.name)) continue;
      const path = joinPath(dir, entry.name), open = entry.kind === EntryKind.DIR && model.expanded.has(path);
      rows.push({
        type: 'entry', path, name: entry.name, depth, kind: entry.kind, link: entry.link === true, open,
        busy: open && model.dirs.get(path)?.loading === true, failed: open ? model.dirs.get(path)?.error?.message : undefined,
      });
      if (open) walk(path, depth + 1);
    }
    if (state.next) rows.push({ type: 'more', path: dir, depth, text: state.loading ? '正在读取…' : '再显示' });
    else if (rows.length === before) rows.push({ type: 'status', path: dir, depth, text: state.entries.length ? '只有隐藏项' : '空目录' });
  };
  walk('', 0);
  return rows;
}

const TITLES = { [EntryKind.LINK]: '指向工作目录外的链接，不能打开', [EntryKind.OTHER]: '不能打开的文件' };

// handlers: { open(path), toggle(path), more(path), retry(path), menu(event, path, kind) }
export function mountTree(el, model, handlers) {
  const spacer = document.createElement('div'), win = document.createElement('div');
  spacer.className = 'spacer'; win.className = 'win';
  spacer.append(win);
  el.replaceChildren(spacer);
  let rows = [], rowH = 24;

  const measure = () => {
    const probe = document.createElement('div');
    probe.className = 'row';
    probe.style.visibility = 'hidden';
    el.append(probe);
    rowH = probe.getBoundingClientRect().height || rowH;
    probe.remove();
  };

  function paint() {
    const first = Math.max(0, Math.floor(el.scrollTop / rowH) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / rowH) + OVERSCAN);
    win.style.transform = `translateY(${first * rowH}px)`;
    win.replaceChildren(...rows.slice(first, last).map((row, i) => rowNode(row, first + i)));
  }

  function rowNode(row, index) {
    const node = document.createElement('div');
    node.className = `row ${row.type}`;
    node.dataset.i = index;
    node.style.paddingLeft = `calc(var(--indent) * ${row.depth} + var(--pad))`;
    if (row.type !== 'entry') {
      node.textContent = row.text;
      if (row.retry) node.classList.add('retry');
      return node;
    }
    const dead = row.kind === EntryKind.LINK || row.kind === EntryKind.OTHER;
    node.classList.add(row.kind);
    if (dead) node.classList.add('dead');
    if (row.path === model.selected) node.classList.add('sel');
    if (row.kind === EntryKind.DIR) node.setAttribute('aria-expanded', row.open);
    if (!dead) node.draggable = true;
    const chevron = document.createElement('span'), label = document.createElement('span'), tail = document.createElement('span');
    chevron.className = 'chev';
    chevron.textContent = row.kind === EntryKind.DIR ? (row.busy ? '…' : row.open ? '▾' : '▸') : '';
    label.className = 'name truncate';
    label.textContent = row.name;
    tail.className = row.failed ? 'tail warn' : 'tail';
    tail.textContent = row.failed ? '!' : row.link ? '↪' : '';
    node.title = row.failed ? `${row.path}\n读取失败：${row.failed}` : TITLES[row.kind] ? `${row.path}\n${TITLES[row.kind]}` : row.path;
    node.append(chevron, label, tail);
    return node;
  }

  const rowOf = event => rows[event.target.closest?.('.row')?.dataset.i];
  el.addEventListener('click', event => {
    const row = rowOf(event);
    if (!row) return;
    if (row.type === 'more') return handlers.more(row.path);
    if (row.type === 'status') return row.retry ? handlers.retry(row.path) : undefined;
    if (row.kind === EntryKind.DIR) handlers.toggle(row.path);
    else if (row.kind === EntryKind.FILE) handlers.open(row.path);
  });
  el.addEventListener('contextmenu', event => {
    const row = rowOf(event);
    if (row?.type === 'entry') { event.preventDefault(); handlers.menu(event, row.path); }
  });
  el.addEventListener('dragstart', event => {
    const row = rowOf(event);
    if (row?.type !== 'entry') return event.preventDefault();
    event.dataTransfer.setData('text/plain', row.path); // 相对路径
    event.dataTransfer.effectAllowed = 'copy';
  });
  el.addEventListener('scroll', paint, { passive: true });
  new ResizeObserver(paint).observe(el);

  return {
    render() { rows = visibleRows(model); spacer.style.height = `${rows.length * rowH}px`; paint(); },
    remeasure() { measure(); this.render(); },
    scroll: () => el.scrollTop,
    scrollTo(top) { el.scrollTop = top; },
  };
}
