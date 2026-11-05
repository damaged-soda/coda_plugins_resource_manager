// 目录树：visibleRows 把模型压成扁平行（纯逻辑）；mountTree 只画可见的那一段，上万条也不卡。
import { EntryKind, SortKey } from './protocol.mjs';
import { dateText, infoText, sizeText } from './format.mjs';
import { icon, iconFor } from './icons.mjs';
import { isHidden, joinPath } from './model.mjs';

const OVERSCAN = 8;
// 长按：按住这么久、移动不超过这个距离才算。
export const HOLD_MS = 500;
export const HOLD_SLOP = 10;

// 行：{ type: 'entry' | 'status' | 'more', path, name, depth, kind, link, size, mtimeMs, open, busy, failed, text }；size、mtimeMs 读不到时没有
export function visibleRows(model) {
  const rows = [];
  const walk = (dir, depth) => {
    const state = model.dirs.get(dir);
    if (!state || (!state.loaded && !state.error)) return rows.push({ type: 'status', path: dir, depth, text: '正在读取…' });
    if (!state.loaded) return rows.push({ type: 'status', path: dir, depth, text: `读取失败：${state.error.message}`, retry: true });
    // 刷新失败：旧条目保留，最上方加一行原因，点它重试。这一行不算内容，空目录的判断在它之后。
    if (state.error) rows.push({ type: 'status', path: dir, depth, text: `更新失败：${state.error.message}`, retry: true });
    // 条目太多按名称排了：说明行固定行高，不算内容，不影响「空目录」的判断。
    if (state.sortFallback) rows.push({ type: 'status', path: dir, depth, text: '条目太多，只能按名称排列' });
    const before = rows.length;
    for (const entry of state.entries) {
      if (!model.showHidden && isHidden(entry.name)) continue;
      const path = joinPath(dir, entry.name), open = entry.kind === EntryKind.DIR && model.expanded.has(path);
      rows.push({
        type: 'entry', path, name: entry.name, depth, kind: entry.kind, link: entry.link === true, size: entry.size, mtimeMs: entry.mtimeMs, open,
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

// 根目录的名字：路径的最后一段，分区标题和 iPhone 的页内工具条共用。
export const rootName = path => path.split('/').filter(Boolean).pop() ?? path;

const TITLES = { [EntryKind.LINK]: '指向工作目录外的链接，不能打开', [EntryKind.OTHER]: '不能打开的文件' };

// handlers: { open(path), toggle(path), more(path), retry(path), menu(event, row) }
// menu 收到整行（路径、种类、大小、修改时间）。
// draggable：触屏上拖行没有用处，还会抢滚动，关掉。now：当前时间，日期的相对格式用，测试可注入。
// longPress：触屏上按住一行打开 handlers.menu（Mac 用右键）。不设 touch-action，滚动照旧，滚动接管时收到 pointercancel 作废。
export function mountTree(el, model, handlers, { draggable = true, longPress = false, now = Date.now } = {}) {
  const title = document.createElement('div'), spacer = document.createElement('div'), win = document.createElement('div');
  title.className = 'section truncate'; spacer.className = 'spacer'; win.className = 'win';
  title.hidden = true;
  spacer.append(win);
  el.replaceChildren(title, spacer);
  let rows = [], rowH = 24;

  // 探针放在 spacer 里：量到的是行在真实结构里的高度。
  const measure = () => {
    const probe = document.createElement('div');
    probe.className = 'row';
    probe.style.visibility = 'hidden';
    spacer.append(probe);
    rowH = probe.getBoundingClientRect().height || rowH;
    probe.remove();
  };

  // 分区标题：根目录的名字（root.path 的最后一段），不是 ready 时不显示。iPhone 上由 CSS 隐藏。
  const paintTitle = () => {
    const text = model.ready ? rootName(model.root.path) : '';
    if (title.textContent !== text) title.textContent = text;
    title.hidden = text === '';
  };

  // 标题在滚动容器里，把 spacer 推下去 offsetTop：行的位置按 spacer 内部算，滚动值（保存和恢复的）仍是容器的。
  function paint() {
    const top = el.scrollTop - (spacer.offsetTop || 0);
    const first = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((top + el.clientHeight) / rowH) + OVERSCAN);
    win.style.transform = `translateY(${first * rowH}px)`;
    const time = now();
    win.replaceChildren(...rows.slice(first, last).map((row, i) => rowNode(row, first + i, time)));
  }

  function rowNode(row, index, time) {
    const node = document.createElement('div');
    node.className = `row ${row.type}`;
    node.dataset.i = index;
    node.style.cssText = `--d: ${row.depth}`; // 缩进由 CSS 按 --d 算，分隔线的起点也用它
    if (row.type !== 'entry') {
      node.textContent = row.text;
      if (row.retry) { node.classList.add('retry'); node.title = row.text; } // 长原因在行里被截断，Mac 悬停看全
      return node;
    }
    const dead = row.kind === EntryKind.LINK || row.kind === EntryKind.OTHER;
    node.classList.add(row.kind);
    if (dead) node.classList.add('dead');
    if (row.path === model.selected) node.classList.add('sel');
    if (row.kind === EntryKind.DIR) node.setAttribute('aria-expanded', row.open);
    if (!dead && draggable) node.draggable = true;
    // 一份 DOM：箭头、图标、名字（iPhone 下面跟日期 · 大小）、Mac 的 meta、尾标；iPhone 的箭头用 CSS order 排到最后，两端各用 CSS 藏起另一端的那段。
    const chevron = document.createElement('span'), glyph = document.createElement('span'), main = document.createElement('span'), label = document.createElement('span'), tail = document.createElement('span');
    chevron.className = 'chev';
    if (row.busy) chevron.textContent = '…';
    else if (!dead) chevron.append(icon('chevron', 12)); // 文件的箭头 Mac 上由 CSS 藏起来，只占位
    if (row.open) node.classList.add('open');
    glyph.className = 'ico';
    glyph.append(icon(iconFor(row)));
    main.className = 'main';
    label.className = 'name truncate';
    label.textContent = row.name;
    main.append(label);
    const parts = [chevron, glyph, main];
    if (!dead) {
      // 能打开的条目带信息；link、other 没有，iPhone 上名字垂直居中。
      const sub = document.createElement('span'), meta = document.createElement('span');
      sub.className = 'sub caption secondary truncate';
      sub.textContent = `${dateText(row, time)} · ${sizeText(row)}`;
      meta.className = 'meta caption secondary';
      meta.textContent = model.sort === SortKey.DATE ? dateText(row, time) : sizeText(row);
      main.append(sub);
      parts.push(meta);
    }
    tail.className = row.failed ? 'tail warn' : 'tail';
    if (row.failed) tail.append(icon('warning', 14));
    else if (row.link) tail.append(icon('turn', 14));
    node.title = row.failed ? `${row.path}\n读取失败：${row.failed}` : TITLES[row.kind] ? `${row.path}\n${TITLES[row.kind]}` : `${row.path}\n${infoText(row)}`;
    node.append(...parts, tail);
    return node;
  }

  const rowOf = event => rows[event.target.closest?.('.row')?.dataset.i];

  // 长按：按下只记一个等待；移动超限、抬起、取消、滚动、第二根手指都作废。
  // 触发后吞掉紧接着的那次点击；没有点击跟来时，下一次按下清掉，不会误吞后面真正的点击。
  let hold = null, swallow = false;
  const cancelHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
  if (longPress) {
    el.addEventListener('pointerdown', event => {
      cancelHold();
      swallow = false;
      const row = rowOf(event);
      if (event.isPrimary === false || row?.type !== 'entry') return;
      const { clientX: x, clientY: y, pointerId: id } = event;
      hold = { id, x, y, timer: setTimeout(() => {
        hold = null;
        swallow = true;
        handlers.menu({ clientX: x, clientY: y }, row);
      }, HOLD_MS) };
    });
    el.addEventListener('pointermove', event => {
      if (hold && event.pointerId === hold.id && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLOP) cancelHold();
    });
    for (const type of ['pointerup', 'pointercancel']) el.addEventListener(type, cancelHold);
    el.addEventListener('scroll', cancelHold, { passive: true });
  }

  el.addEventListener('click', event => {
    if (swallow) { swallow = false; return; }
    const row = rowOf(event);
    if (!row) return;
    if (row.type === 'more') return handlers.more(row.path);
    if (row.type === 'status') return row.retry ? handlers.retry(row.path) : undefined;
    if (row.kind === EntryKind.DIR) handlers.toggle(row.path);
    else if (row.kind === EntryKind.FILE) handlers.open(row.path);
  });
  el.addEventListener('contextmenu', event => {
    const row = rowOf(event);
    if (row?.type === 'entry') { event.preventDefault(); handlers.menu(event, row); }
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
    render() { rows = visibleRows(model); spacer.style.height = `${rows.length * rowH}px`; paintTitle(); paint(); },
    remeasure() { measure(); this.render(); },
    scroll: () => el.scrollTop,
    scrollTo(top) { el.scrollTop = top; },
    // 切会话时调用：长按的等待和吞点击的标记都属于上一个会话。
    reset() { cancelHold(); swallow = false; },
  };
}
