// 真实模块（activate）+ 真实 connect()、app.mjs、grid.mjs + 真实临时目录：图标视图里进入目录、列出、回上一层、目录被删，一路走通。
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadApp } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, tempDir, waitFor } from './support/fake.mjs';

const body = page => page.grid.find(node => node.classList.contains('gbody'))[0];
const names = page => page.grid.find(node => node.classList.contains('gi')).map(node => node.textContent);
const cell = (page, name) => page.grid.find(node => node.classList.contains('cell') && node.textContent === name)[0];
// Mac：一次完整的双击（浏览器的事件顺序：两次 click，再 dblclick）。
const dbl = node => { node.dispatch('click'); node.dispatch('click'); node.dispatch('dblclick'); };
const head = page => page.grid.find(node => node.classList.contains('ghead'))[0];

async function mountGrid(t, fake, { platform = 'mac', state, saved = [], back } = {}) {
  const view = fake.open('A'), ready = deferred();
  let page;
  view.listen(message => ready.promise.then(() => queueMicrotask(() => page.post(message))));
  const calls = { back: [] };
  page = await loadApp(t, {
    platform, postMessage: message => view.send(message), on: () => {}, copy: () => {},
    ...(back ? { back: titles => calls.back.push(titles) } : {}),
    getState: () => state, setState: value => saved.push(JSON.parse(JSON.stringify(value))), open: () => {}, close: () => {},
  });
  Object.assign(body(page), { clientWidth: 300, clientHeight: 240 });
  ready.resolve();
  return { page, calls, saved };
}
const iconsState = { v: 1, seq: 1, hidden: false, view: 'icons', sessions: {} };

test('真实模块：单击文件夹列出它的内容，Mac 头部返回回到根目录；每一步都是真实的 list 请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'sub', 'deeper'), { recursive: true });
  await writeFile(join(root, 'sub', 'inner.txt'), 'x');
  await writeFile(join(root, 'sub', 'deeper', 'deep.txt'), 'y');
  await writeFile(join(root, 'top.txt'), 'z');
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const { page } = await mountGrid(t, fake, { state: iconsState });
  await waitFor(() => names(page).includes('top.txt'), '根目录的图标');
  assert.deepEqual(names(page), ['sub', 'top.txt']);
  dbl(cell(page, 'sub'));
  await waitFor(() => names(page).includes('inner.txt'), '进入 sub');
  assert.deepEqual(names(page), ['deeper', 'inner.txt']);
  dbl(cell(page, 'deeper'));
  await waitFor(() => names(page).includes('deep.txt'), '进入 sub/deeper');
  assert.equal(head(page).find(node => node.classList.contains('gname-head'))[0].textContent, 'deeper');
  head(page).children[0].dispatch('click');
  await waitFor(() => names(page).includes('inner.txt'), '回到 sub');
  head(page).children[0].dispatch('click');
  await waitFor(() => names(page).includes('top.txt'), '回到根目录');
  assert.equal(head(page).children.some(node => node.tagName === 'BUTTON'), false);
});

test('真实模块：目录被删之后刷新，模块回答 not_found，回到最近还在的上一层并提示', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'sub', 'deeper'), { recursive: true });
  await writeFile(join(root, 'sub', 'keep.txt'), 'x');
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const { page } = await mountGrid(t, fake, { state: iconsState });
  await waitFor(() => names(page).includes('sub'), '根目录');
  dbl(cell(page, 'sub'));
  await waitFor(() => names(page).includes('deeper'), 'sub');
  dbl(cell(page, 'deeper'));
  await waitFor(() => names(page).includes('空目录'), 'sub/deeper');
  await rm(join(root, 'sub', 'deeper'), { recursive: true });
  page.bar.find(node => node.tagName === 'BUTTON' && node.textContent === '刷新')[0].dispatch('click');
  await waitFor(() => page.hint.textContent === '文件夹已不存在' && names(page).join() === 'keep.txt', '退到 sub，内容是刷新后的');
  assert.equal(page.hint.textContent, '文件夹已不存在');
});

test('真实模块：iPhone 单击文件走 coda.open，重建页面后用保存的状态回到同一层，原生返回的路径立刻重新声明', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'inner.txt'), 'x');
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const saved = [];
  const first = await mountGrid(t, fake, { platform: 'ios', state: iconsState, saved, back: true });
  await waitFor(() => names(first.page).includes('sub'), '根目录');
  dbl(cell(first.page, 'sub'));
  await waitFor(() => names(first.page).includes('inner.txt'), 'sub');
  assert.deepEqual(first.calls.back.at(-1), ['repo']);
  dbl(cell(first.page, 'inner.txt'));
  await waitFor(() => saved.length > 0, '打开文件前保存');
  const second = await mountGrid(t, fake, { platform: 'ios', state: saved.at(-1), back: true });
  await waitFor(() => names(second.page).includes('inner.txt'), '重建后回到 sub');
  assert.deepEqual(second.calls.back, [['repo']]);
});
