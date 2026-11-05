// 图标视图的两种行高（单元格和说明行不一样高）和名字的折法。布局映射按行记，高度换算只在 rowTop / rowAt / rowsAbove 一处，
// 总高度、可见窗口、锚点都用它。真实的 grid.mjs，配最小的假 DOM；单元格和说明行的高度靠覆盖 getBoundingClientRect 给。
import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutOf, mountGrid, rowAt, rowTop, rowsAbove } from '../view/grid.mjs';
import { Element, loadApp } from './support/dom.mjs';
import { manual } from './support/page.mjs';

const CELL = 80, NOTE = 30;
const file = name => ({ name, kind: 'file' });
const entry = n => ({ type: 'entry', name: `f${n}` });
const note = { type: 'status', text: '说明' };

test('rowTop / rowAt / rowsAbove：说明行 30、条目行 80，边界上下取整一致', () => {
  const layout = layoutOf([note, entry(0), entry(1), entry(2), note], 2); // 说明、条目两行（2 + 1）、说明：4 行
  assert.equal(layout.rows, 4);
  assert.deepEqual([0, 1, 2, 3, 4].map(row => rowTop(layout, row, CELL, NOTE)), [0, 30, 110, 190, 220], '第 4 行（总行数）是总高度');
  assert.deepEqual([0, 29, 30, 109, 110, 189, 190, 219].map(y => rowAt(layout, y, CELL, NOTE)), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(rowAt(layout, 220, CELL, NOTE), 4, '超出内容：总行数');
  assert.deepEqual([0, 1, 30, 31, 110, 111, 190, 191, 5000].map(y => rowsAbove(layout, y, CELL, NOTE)), [0, 1, 1, 2, 2, 3, 3, 4, 4], '顶边在 y 之上的行数');
  assert.deepEqual(layoutOf([], 3).spans, []);
  assert.equal(rowTop(layoutOf([], 3), 0, CELL, NOTE), 0);
});

test('两种高度相同时和按行算一样：rowAt 是向下取整，rowsAbove 是向上取整', () => {
  const layout = layoutOf(Array.from({ length: 23 }, (_, i) => entry(i)), 4); // 6 行
  for (let y = 0; y <= 6 * 24 + 10; y += 5) {
    assert.equal(rowAt(layout, y, 24, 24), Math.min(6, Math.floor(y / 24)), `rowAt ${y}`);
    assert.equal(rowsAbove(layout, y, 24, 24), Math.min(6, Math.ceil(y / 24)), `rowsAbove ${y}`);
  }
});

async function mount(t, entries, { extra = {}, width = 300, height = 240 } = {}) {
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); } catch { /* 已经启用 */ } // 页面入口起的启动超时用假计时器，不拖住进程
  await loadApp(t, { platform: 'mac', postMessage() {}, on() {}, copy() {}, getState: () => undefined, setState() {} });
  t.mock.method(Element.prototype, 'getBoundingClientRect', function () {
    return this.classList.contains('gnote') ? { left: 0, top: 0, right: width, bottom: NOTE, width, height: NOTE } : { left: 0, top: 0, right: 100, bottom: CELL, width: 100, height: CELL };
  });
  const { model } = manual();
  model.cwd = '';
  model.dirs.set('', { entries, next: null, loaded: true, loading: false, error: null, token: 0, pages: 1, sortFallback: false, ...extra });
  const el = new Element('div');
  const grid = mountGrid(el, model, { open() {}, enter() {}, more() {}, retry() {}, menu() {} });
  const body = el.find(node => node.classList.contains('gbody'))[0];
  Object.assign(body, { clientWidth: width, clientHeight: height });
  grid.remeasure();
  const nodes = () => el.find(node => node.classList.contains('gi'));
  return { el, body, grid, nodes, spacer: body.find(node => node.classList.contains('gspacer'))[0], win: body.find(node => node.classList.contains('gwin'))[0] };
}
const many = n => Array.from({ length: n }, (_, i) => file(`f${String(i).padStart(3, '0')}`));

test('只有说明行（空目录）：总高度是一行说明的高度，不是一行单元格', async t => {
  const { spacer, nodes } = await mount(t, []);
  assert.equal(spacer.style.height, `${NOTE}px`);
  assert.deepEqual(nodes().map(node => node.textContent), ['空目录']);
});

test('前后都有说明行：总高度、窗口位置用两种高度算', async t => {
  // 条目太多（说明）+ 12 个条目（3 列 4 行）+ 再显示：6 行，30 + 4 × 80 + 30 = 380
  const { body, spacer, win, nodes, grid } = await mount(t, many(12), { extra: { sortFallback: true, next: 'c' } });
  assert.equal(grid.layout.rows, 6);
  assert.equal(spacer.style.height, '380px');
  body.scrollTop = 190; // 全局第 3 行（条目的第 3 行）的顶边（假 DOM 里 gspacer 的 offsetTop 是 0）
  body.dispatch('scroll');
  assert.equal(win.style.transform, `translateY(${NOTE}px)`, '窗口从第 1 行起（第 3 行减去上面多画的两行），它的顶边是 30');
  assert.equal(Number(nodes()[0].dataset.i), 1, '第 1 行是条目 f000，序号 1（0 是说明）');
});

test('任意滚动位置：视口里每一行的单元格都画了', async t => {
  const { body, grid, nodes } = await mount(t, many(300), { extra: { sortFallback: true, next: 'c' }, height: 240 });
  const total = rowTop(grid.layout, grid.layout.rows, CELL, NOTE);
  for (let top = 0; top <= total - 240; top += 37) {
    body.scrollTop = top;
    body.dispatch('scroll');
    const drawn = new Set(nodes().map(node => Number(node.dataset.i)));
    const first = rowAt(grid.layout, top, CELL, NOTE), last = rowsAbove(grid.layout, top + 240, CELL, NOTE);
    for (let row = first; row < last; row++) {
      const span = grid.layout.spans.find(item => row >= item.row && row < item.row + item.rows);
      const index = span.note ? span.from : span.from + (row - span.row) * grid.layout.cols;
      assert.ok(drawn.has(index), `滚到 ${top}：第 ${row} 行的第一个单元格（序号 ${index}）没画`);
    }
  }
});

test('列数变化时保持第一个可见的单元格：锚点按两种高度回滚', async t => {
  const { body, grid, nodes } = await mount(t, many(60), { extra: { sortFallback: true } });
  assert.equal(grid.layout.cols, 3);
  body.scrollTop = NOTE + CELL * 5; // 条目第 5 行（序号 1 + 15 起）在顶部
  body.dispatch('scroll');
  body.clientWidth = 500; // 5 列
  grid.render();
  assert.equal(grid.layout.cols, 5);
  assert.equal(body.scrollTop, NOTE + CELL * 3, '序号 16 在 5 列下是条目第 3 行（15 号条目 = 第 3 行第 0 列），顶边 30 + 3 × 80');
  assert.ok(nodes().some(node => Number(node.dataset.i) === 16));
});

// ---- 名字的折法 ----

test('名字在最后一个点之前有优先断点：package.json 折成 package / .json；没有点或点在最前面不加', async t => {
  const names = ['package.json', 'a.tar.gz', '.gitignore', 'README', 'dot.'];
  const { nodes } = await mount(t, names.map(file));
  const parts = name => nodes().find(node => node.textContent === name).find(child => child.classList.contains('gname'))[0].children.map(child => child.tagName ?? child.data);
  assert.deepEqual(parts('package.json'), ['package', 'WBR', '.json']);
  assert.deepEqual(parts('a.tar.gz'), ['a.tar', 'WBR', '.gz'], '只在最后一个点之前');
  assert.deepEqual(parts('.gitignore'), ['.gitignore'], '点在最前面：隐藏文件，不断');
  assert.deepEqual(parts('README'), ['README']);
  assert.deepEqual(parts('dot.'), ['dot', 'WBR', '.']);
  for (const name of names) assert.equal(nodes().find(node => node.textContent === name).find(child => child.classList.contains('gname'))[0].textContent, name, '文字不变，选中、点击、查找都照旧');
});
