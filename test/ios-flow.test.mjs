// 真实模块（activate）+ 真实 app.mjs、file-app.mjs + 真实临时目录：iPhone 上「打开文件再回来」走一遍。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadApp, loadFileApp } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, tempDir, waitFor } from './support/fake.mjs';

const COUNT = 1500; // 名字取长一点，一页（96 KiB）放不下，需要两页
const name = i => `file-${String(i).padStart(4, '0')}-${'x'.repeat(80)}.txt`;

// 挂一个树页：getState 给上次存下的状态，coda.open 记下参数。
async function mountTree(t, fake, state, opened) {
  const view = fake.open('A');
  const ready = deferred(), saved = [];
  let page;
  view.listen(message => ready.promise.then(() => queueMicrotask(() => page.post(message))));
  page = await loadApp(t, {
    platform: 'ios', postMessage: message => view.send(message), on: () => {}, copy: () => {},
    getState: () => state, setState: value => saved.push(JSON.parse(JSON.stringify(value))),
    open: args => { opened.push(args); }, close: () => {},
  });
  ready.resolve();
  return { page, view, saved };
}

const entryRows = page => page.tree.find(node => node.classList.contains('entry'));
const scrollTo = (page, top) => { page.tree.scrollTop = top; page.tree.dispatch('scroll'); };

test('树 → 文件页 → 回到树：展开、已加载的条数、滚动位置都在，文件页读到的是点的那个文件', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'x.txt'), 'x');
  for (let i = 0; i < COUNT; i++) await writeFile(join(root, name(i)), `body-${i}`);
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);

  // 第一次：展开 sub，加载第二页，滚到深处，点一个文件。
  const opened = [];
  const one = await mountTree(t, fake, undefined, opened);
  await waitFor(() => entryRows(one.page).some(node => node.textContent.includes('sub')), '根目录');
  const rowH = 24; // 假 DOM 量出的行高
  entryRows(one.page).find(node => node.textContent.includes('sub')).dispatch('click');
  await waitFor(() => entryRows(one.page).some(node => node.textContent.includes('x.txt')), '展开 sub');
  const total = () => one.page.tree.children[1].style.height;
  const firstPage = parseInt(total(), 10) / rowH;
  assert.ok(firstPage < COUNT + 2, '第一页放不下全部');
  scrollTo(one.page, (firstPage - 3) * rowH);
  const more = () => one.page.tree.find(node => node.classList.contains('more'))[0];
  await waitFor(() => more(), '再显示');
  more().dispatch('click');
  await waitFor(() => parseInt(total(), 10) / rowH === COUNT + 2, '第二页');
  scrollTo(one.page, (firstPage + 100) * rowH);
  const target = entryRows(one.page).find(node => node.classList.contains('file'));
  const targetName = target.find(node => node.classList.contains('name'))[0].textContent;
  target.dispatch('click');
  await waitFor(() => opened.length === 1, 'coda.open');
  assert.equal(opened[0].view, 'file');
  assert.equal(opened[0].args.session, 'A');
  assert.equal(opened[0].args.path, targetName);

  // 文件页：用同样的 args 打开，读到正文。
  const fileView = fake.open(null, { view: 'file', args: opened[0].args }), ready = deferred();
  let file;
  fileView.listen(message => ready.promise.then(() => queueMicrotask(() => file.post(message))));
  file = await loadFileApp(t, { platform: 'ios', args: opened[0].args, postMessage: message => fileView.send(message), on: () => {}, copy: () => {}, getState: () => undefined, setState: () => {}, close: () => {} });
  ready.resolve();
  const index = Number(targetName.slice(5, 9));
  await waitFor(() => file.preview.find(node => node.classList.contains('text'))[0]?.textContent === `body-${index}`, '文件页正文');

  // 返回：树页重新打开，用存下的状态。
  const state = one.saved.at(-1);
  assert.ok(state.sessions.A.loaded[''] > firstPage - 2, '状态里存的是条数');
  const two = await mountTree(t, fake, state, []);
  await waitFor(() => parseInt(two.page.tree.children[1].style.height, 10) / rowH === COUNT + 2, '取够条数');
  assert.equal(two.page.tree.scrollTop, (firstPage + 100) * rowH);
  scrollTo(two.page, 0);
  assert.ok(entryRows(two.page).some(node => node.textContent.includes('x.txt')), 'sub 仍然展开');
});
