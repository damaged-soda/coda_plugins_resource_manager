// 图标视图的显示（view/grid.mjs）：单元格、布局映射、只画可见的一段、列数变化、事件。真实的 grid.mjs，配最小的假 DOM。
import assert from 'node:assert/strict';
import test from 'node:test';
import { firstOfRow, layoutOf, mountGrid, rowOfCell, visibleCells, windowOf } from '../view/grid.mjs';
import { Element, loadApp } from './support/dom.mjs';
import { manual } from './support/page.mjs';

const file = name => ({ name, kind: 'file' });
const dir = name => ({ name, kind: 'dir' });
const note = (text, extra = {}) => ({ type: 'status', path: '', text, ...extra });

// 模型里放一个已加载的目录：entries 是条目，extra 是 sortFallback、next、error、loading 之类。
function modelWith(entries, extra = {}, cwd = '') {
  const { model } = manual();
  model.cwd = cwd;
  model.dirs.set(cwd, { entries, next: null, loaded: true, loading: false, error: null, token: 0, pages: 1, sortFallback: false, ...extra });
  return model;
}
const texts = cells => cells.map(cell => (cell.type === 'entry' ? cell.name : cell.text));

// ---- visibleCells ----

test('visibleCells：条目带路径、种类、大小、修改时间，隐藏文件按「显示隐藏文件」过滤', () => {
  const model = modelWith([dir('src'), { name: 'a.txt', kind: 'file', size: 5, mtimeMs: 7 }, file('.DS_Store'), file('.git')], {}, 'x');
  assert.deepEqual(visibleCells(model).map(cell => [cell.type, cell.path, cell.kind, cell.size, cell.mtimeMs]), [['entry', 'x/src', 'dir', undefined, undefined], ['entry', 'x/a.txt', 'file', 5, 7]]);
  model.showHidden = true;
  assert.equal(visibleCells(model).length, 4);
});

test('visibleCells：读取中、读取失败（可重试）、更新失败、条目太多、再显示、空目录、只有隐藏项', () => {
  const { model } = manual();
  assert.deepEqual(visibleCells(model), [note('正在读取…')], '没有这个目录');
  model.dirs.set('', { entries: [], loaded: false, loading: true, error: null });
  assert.deepEqual(texts(visibleCells(model)), ['正在读取…']);
  model.dirs.set('', { entries: [], loaded: false, loading: false, error: { message: '坏了' } });
  assert.deepEqual(visibleCells(model), [note('读取失败：坏了', { retry: true })]);
  const state = { entries: [file('a'), file('b')], loaded: true, loading: false, error: { message: '超时' }, sortFallback: true, next: 'c' };
  model.dirs.set('', state);
  assert.deepEqual(texts(visibleCells(model)), ['更新失败：超时', '条目太多，只能按名称排列', 'a', 'b', '再显示'], '前后都有说明项');
  assert.equal(visibleCells(model)[0].retry, true);
  state.loading = true;
  assert.equal(visibleCells(model).at(-1).text, '正在读取…', '正在翻页时「再显示」换成读取中');
  model.dirs.set('', { entries: [], loaded: true, next: null });
  assert.deepEqual(texts(visibleCells(model)), ['空目录']);
  model.dirs.set('', { entries: [file('.git')], loaded: true, next: null });
  assert.deepEqual(texts(visibleCells(model)), ['只有隐藏项']);
  model.dirs.set('', { entries: [file('.git')], loaded: true, next: 'c' });
  assert.deepEqual(texts(visibleCells(model)), ['再显示'], '有「再显示」时不说空');
  model.dirs.set('', { entries: [], loaded: true, next: null, sortFallback: true });
  assert.deepEqual(texts(visibleCells(model)), ['条目太多，只能按名称排列', '空目录'], '说明项不算内容，空目录照说');
});

test('visibleCells：看的是 cwd，不是根目录', () => {
  const model = modelWith([file('inner')], {}, 'a/b');
  model.dirs.set('', { entries: [file('outer')], loaded: true, next: null });
  assert.deepEqual(texts(visibleCells(model)), ['inner']);
});

// ---- 布局映射 ----

const entries = n => Array.from({ length: n }, (_, i) => ({ type: 'entry', name: `n${i}` }));
const nt = { type: 'status', text: 'x' };

test('布局映射：条目段占 ceil(n / 列数) 行，说明项独占一行；5 列时前置说明加 6 个条目加「再显示」是 4 行', () => {
  const cells = [nt, ...entries(6), { type: 'more', text: '再显示' }];
  const layout = layoutOf(cells, 5);
  assert.equal(layout.rows, 4);
  assert.deepEqual(layout.spans.map(({ from, count, row, rows }) => [from, count, row, rows]), [[0, 1, 0, 1], [1, 6, 1, 2], [7, 1, 3, 1]]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(index => rowOfCell(layout, index)), [0, 1, 1, 1, 1, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map(row => firstOfRow(layout, row)), [0, 1, 6, 7]);
  assert.deepEqual(layoutOf([], 4), { cols: 4, rows: 0, spans: [] });
  assert.equal(layoutOf(entries(5), 5).rows, 1, '正好一行');
  assert.equal(layoutOf(entries(1), 5).rows, 1, '不满一行也占一行');
  assert.equal(layoutOf(entries(7), 0).cols, 1, '列数至少为 1');
  assert.equal(layoutOf(entries(7), 0.4).cols, 1);
  assert.equal(layoutOf(entries(7), NaN).rows, 7);
});

test('布局映射：连续的条目各成一段，中间夹说明项时每段各自向上取整', () => {
  const layout = layoutOf([...entries(3), nt, ...entries(3)], 2);
  assert.equal(layout.rows, 2 + 1 + 2);
  assert.deepEqual([0, 1, 2, 3, 4].map(row => firstOfRow(layout, row)), [0, 2, 3, 4, 6]);
});

test('可见窗口：行范围换成单元格序号范围，不画半行以外的东西', () => {
  const layout = layoutOf([nt, ...entries(11), { type: 'more', text: '再显示' }], 4); // 说明、3 行条目（4+4+3）、再显示：5 行
  assert.equal(layout.rows, 5);
  assert.deepEqual(windowOf(layout, 0, 5), { from: 0, to: 13 });
  assert.deepEqual(windowOf(layout, 1, 3), { from: 1, to: 9 }, '中间两行：条目 0～7');
  assert.deepEqual(windowOf(layout, 3, 4), { from: 9, to: 12 }, '最后一行条目只有 3 个');
  assert.deepEqual(windowOf(layout, 4, 5), { from: 12, to: 13 }, '说明项独占一行');
  assert.deepEqual(windowOf(layout, 2, 2), { from: 0, to: 0 }, '空范围');
  assert.deepEqual(windowOf(layoutOf([], 3), 0, 0), { from: 0, to: 0 });
});

// ---- 挂到假 DOM 上 ----

async function mount(t, model, { width = 300, height = 240, platform = 'mac', ...options } = {}) {
  await loadApp(t, { platform, postMessage() {}, on() {}, copy() {}, getState: () => undefined, setState() {} }); // 装上全局的 document 等
  const el = new Element('div'), calls = { open: [], enter: [], more: [], retry: [], menu: [], back: 0 };
  const handlers = {
    open: path => calls.open.push(path), enter: path => calls.enter.push(path), more: path => calls.more.push(path), retry: path => calls.retry.push(path),
    menu: (event, cell) => calls.menu.push([event, cell]), ...(options.back ? { back: () => calls.back++ } : {}),
  };
  const grid = mountGrid(el, model, handlers, options);
  const body = el.find(node => node.classList.contains('gbody'))[0];
  Object.assign(body, { clientWidth: width, clientHeight: height });
  grid.remeasure(); // 假 DOM 量出来的单元格是 100 × 24
  return { el, body, grid, calls, nodes: () => el.find(node => node.classList.contains('gi')), cell: name => el.find(node => node.classList.contains('cell') && node.textContent === name)[0] };
}
const many = n => Array.from({ length: n }, (_, i) => file(`f${String(i).padStart(5, '0')}`));
const indexes = nodes => nodes.map(node => Number(node.dataset.i));

test('两万条：只画可见的一段，滚到哪画到哪，总高度是 ceil(n / 列数) 行', async t => {
  const model = modelWith(many(20000));
  const { body, grid, nodes, el } = await mount(t, model); // 300 宽、100 一格：3 列；24 高一行，240 高：10 行
  assert.equal(grid.layout.cols, 3);
  assert.equal(grid.layout.rows, Math.ceil(20000 / 3));
  const spacer = body.find(node => node.classList.contains('gspacer'))[0];
  assert.equal(spacer.style.height, `${Math.ceil(20000 / 3) * 24}px`);
  assert.ok(nodes().length <= (10 + 2 * 2) * 3, `只画一段：${nodes().length}`);
  assert.deepEqual(indexes(nodes()).slice(0, 3), [0, 1, 2]);
  body.scrollTop = 24 * 3000;
  body.dispatch('scroll');
  const window = indexes(nodes());
  assert.ok(nodes().length <= (10 + 2 * 2) * 3);
  assert.equal(window[0], (3000 - 2) * 3, '从上面多画的两行开始');
  assert.ok(window.includes(3000 * 3) && window.includes(3009 * 3 + 2), '可见的 10 行都在');
  assert.equal(body.find(node => node.classList.contains('gwin'))[0].style.transform, `translateY(${(3000 - 2) * 24}px)`);
  body.scrollTop = 24 * (Math.ceil(20000 / 3) - 1);
  body.dispatch('scroll');
  assert.equal(indexes(nodes()).at(-1), 19999, '滚到底，最后一个也画了');
  assert.ok(el.find(node => node.classList.contains('cell')).every(node => node.dataset.i !== undefined));
});

test('说明项占满一行：前后都有说明项时，画出来的顺序和行数对得上', async t => {
  const model = modelWith(many(6), { sortFallback: true, next: 'c' });
  const { grid, nodes } = await mount(t, model, { width: 500 }); // 5 列
  assert.equal(grid.layout.rows, 1 + 2 + 1);
  assert.deepEqual(nodes().map(node => node.classList.contains('gnote')), [true, false, false, false, false, false, false, true]);
  assert.equal(nodes().at(-1).textContent, '再显示');
  assert.ok(nodes().at(-1).classList.contains('more'));
});

test('列数变化（拖窄、旋转）：第一个可见的单元格还在顶部，不保持像素', async t => {
  const model = modelWith(many(300));
  const { body, grid, nodes } = await mount(t, model); // 3 列
  body.scrollTop = 24 * 10; // 第 10 行：第一个可见的单元格是 30
  body.dispatch('scroll');
  body.clientWidth = 200; // 2 列
  grid.render();
  assert.equal(grid.layout.cols, 2);
  assert.equal(body.scrollTop, 24 * 15, '30 号在 2 列里是第 15 行');
  assert.ok(indexes(nodes()).includes(30));
  body.clientWidth = 500; // 5 列：30 号是第 6 行
  grid.render();
  assert.equal(grid.layout.cols, 5);
  assert.equal(body.scrollTop, 24 * 6);
});

test('尺寸变化事件（ResizeObserver）：列数变了保持第一个可见的单元格，没变只重画', async t => {
  const model = modelWith(many(300));
  const page = await loadApp(t, { platform: 'mac', postMessage() {}, on() {}, copy() {}, getState: () => undefined, setState() {} });
  const el = new Element('div');
  const grid = mountGrid(el, model, { open() {}, enter() {}, more() {}, retry() {}, menu() {} });
  const body = el.find(node => node.classList.contains('gbody'))[0];
  Object.assign(body, { clientWidth: 300, clientHeight: 240 });
  grid.remeasure();
  body.scrollTop = 24 * 10;
  body.dispatch('scroll');
  body.clientWidth = 200;
  page.resize();
  assert.equal(grid.layout.cols, 2);
  assert.equal(body.scrollTop, 24 * 15);
  body.clientHeight = 480;
  page.resize(); // 只有高度变了：列数不变，位置不动
  assert.equal(body.scrollTop, 24 * 15);
  assert.equal(grid.layout.cols, 2);
});

test('列数变化时在顶部：不动滚动位置；隐藏过的网格显示后宽度变了，重新量再算列数', async t => {
  const model = modelWith(many(30));
  const { body, grid } = await mount(t, model, { width: 0 });
  assert.equal(grid.layout.cols, 1, '宽度 0（还没显示）：至少 1 列');
  body.clientWidth = 300;
  grid.render(); // 显示后第一次画：宽度变了，重量
  assert.equal(grid.layout.cols, 3);
  assert.equal(body.scrollTop, 0);
});

test('单元格：图标加名字，文件夹和文件各有类，选中高亮，title 同目录树；不能打开的条目是 dead，不可拖', async t => {
  const model = modelWith([dir('src'), { name: 'a.txt', kind: 'file', size: 2048, mtimeMs: 0 }, { name: 'gone', kind: 'link' }, { name: 'dev', kind: 'other' }]);
  model.selected = 'a.txt';
  const { cell, nodes } = await mount(t, model);
  assert.equal(nodes().length, 4);
  const [src, txt, gone, dev] = ['src', 'a.txt', 'gone', 'dev'].map(cell);
  assert.ok(src.classList.contains('dir') && !src.classList.contains('dead'));
  assert.equal(src.draggable, true);
  assert.ok(txt.classList.contains('sel'));
  assert.ok(gone.classList.contains('dead') && dev.classList.contains('dead'));
  assert.deepEqual([gone.draggable, dev.draggable], [undefined, undefined]);
  assert.ok(src.find(node => node.classList.contains('gico'))[0].find(node => node.tagName === 'SVG').length === 1, '有图标');
  assert.match(txt.title, /^a\.txt\n2\.0 KiB · /);
  assert.match(gone.title, /指向工作目录外的链接，不能打开/);
  assert.match(dev.title, /不能打开的文件/);
});

test('iPhone 的单元格不可拖（触屏上拖没有用处，还会抢滚动）', async t => {
  const model = modelWith([file('a')]);
  const { cell } = await mount(t, model, { platform: 'ios', draggable: false });
  assert.equal(cell('a').draggable, undefined);
});

test('点击：文件夹进入，文件打开，说明项只有读取失败的可以重试，「再显示」翻页，link 和 other 没反应', async t => {
  const model = modelWith([dir('src'), file('a.txt'), { name: 'gone', kind: 'link' }, { name: 'dev', kind: 'other' }], { next: 'c', error: { message: '超时' } });
  const { calls, cell, nodes } = await mount(t, model);
  for (const name of ['src', 'a.txt', 'gone', 'dev']) cell(name).dispatch('click');
  assert.deepEqual([calls.enter, calls.open], [['src'], ['a.txt']]);
  const [failed, , , , , more] = nodes();
  failed.dispatch('click');
  more.dispatch('click');
  assert.deepEqual([calls.retry, calls.more], [[''], ['']]);
});

test('Mac 右键：条目弹菜单（带整个单元格），说明项不弹；拖动带相对路径，说明项和不能打开的不拖', async t => {
  const model = modelWith([dir('src'), file('a.txt')], { sortFallback: true }, 'x');
  const { calls, cell, nodes } = await mount(t, model);
  const prevented = [];
  cell('a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6, preventDefault: () => prevented.push(1) });
  assert.equal(calls.menu.length, 1);
  assert.deepEqual([calls.menu[0][1].path, calls.menu[0][1].kind, calls.menu[0][0].clientX], ['x/a.txt', 'file', 5]);
  assert.equal(prevented.length, 1);
  nodes()[0].dispatch('contextmenu', { preventDefault: () => prevented.push(1) });
  assert.equal(calls.menu.length, 1, '说明项不弹菜单');
  const data = {};
  const drag = cell('src').dispatch('dragstart', { dataTransfer: { setData: (type, value) => { data[type] = value; }, effectAllowed: '' } });
  assert.deepEqual(data, { 'text/plain': 'x/src' });
  assert.equal(drag.dataTransfer.effectAllowed, 'copy');
  let stopped = false;
  nodes()[0].dispatch('dragstart', { preventDefault: () => { stopped = true; }, dataTransfer: { setData() { throw new Error('不该设置'); } } });
  assert.equal(stopped, true);
});

test('头部：Mac 有返回和当前目录名，根目录没有返回键；没有 back 就没有头部（iPhone 的原生返回）', async t => {
  const model = modelWith([file('a')], {}, 'a/b');
  model.root = { state: 'ready', path: '/work/proj' };
  const mac = await mount(t, model, { back: true });
  const head = mac.el.find(node => node.classList.contains('ghead'))[0];
  assert.equal(head.hidden, false);
  assert.equal(head.children[0].getAttribute('aria-label'), '返回');
  assert.equal(head.find(node => node.classList.contains('gname-head'))[0].textContent, 'b');
  head.children[0].dispatch('click');
  assert.equal(mac.calls.back, 1);
  model.cwd = '';
  model.dirs.set('', { entries: [], loaded: true, next: null });
  mac.grid.render();
  assert.equal(head.children.some(node => node.tagName === 'BUTTON'), false, '根目录没有返回键');
  assert.equal(head.find(node => node.classList.contains('gname-head'))[0].textContent, 'proj', '标题是根目录名');
  const phone = await mount(t, model);
  assert.equal(phone.el.find(node => node.classList.contains('ghead'))[0].hidden, true);
});
