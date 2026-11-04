// 目录刷新失败行：visibleRows 的规则（纯逻辑）和页面里点它重试。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleRows } from '../view/tree.mjs';
import { flush } from './support/fake.mjs';
import { entries, manual } from './support/page.mjs';
import { openTree, rowNamed, rowsOf } from './support/treehost.mjs';

const shape = model => visibleRows(model).map(r => [r.type, r.name ?? r.text, r.depth]);
const FAILED = ['status', '更新失败：读取失败', 0];

// 起会话，回答根目录并展开 dirs（每个目录的内容由 content 给）。
async function loaded(t, root, content = {}) {
  t.session(1, 'A');
  t.root(1);
  t.reply((await t.lists(''))[0], entries(root));
  await flush();
  for (const dir of Object.keys(content)) {
    t.model.toggle(dir);
    t.reply((await t.lists(dir)).at(-1), entries(content[dir]));
    await flush();
  }
}
// 刷新一轮，让 path 的请求失败。
async function failRefresh(t, path) {
  t.model.refresh();
  const request = (await t.lists(path)).at(-1);
  t.fail(request, 'io_error', '读取失败');
  await flush();
}

test('根目录刷新失败：最上方一行「更新失败」，旧条目保留，点它重试，成功后消失', async () => {
  const t = manual();
  await loaded(t, ['a.txt', 'src/']);
  await failRefresh(t, '');
  const rows = visibleRows(t.model);
  assert.deepEqual(shape(t.model), [FAILED, ['entry', 'a.txt', 0], ['entry', 'src', 0]]);
  assert.equal(rows[0].retry, true);
  assert.equal(rows[0].path, '');
  t.model.retry('');
  t.reply((await t.lists('')).at(-1), entries(['a.txt', 'src/']));
  await flush();
  assert.deepEqual(shape(t.model).map(r => r[0]), ['entry', 'entry']);
});

test('子目录刷新失败：行在它的子项最上方，缩进同子项，目录行保留 !', async () => {
  const t = manual();
  await loaded(t, ['src/'], { src: ['x.txt'] });
  await failRefresh(t, 'src');
  assert.deepEqual(shape(t.model), [['entry', 'src', 0], ['status', '更新失败：读取失败', 1], ['entry', 'x.txt', 1]]);
  assert.equal(visibleRows(t.model)[0].failed, '读取失败');
});

test('空目录、只有隐藏项刷新失败：失败行和「空目录」「只有隐藏项」同时在，失败行不算内容', async () => {
  const t = manual();
  await loaded(t, ['empty/', 'hid/'], { empty: [], hid: ['.git'] });
  t.model.refresh();
  for (const path of ['empty', 'hid']) t.fail((await t.lists(path)).at(-1), 'io_error', '读取失败');
  await flush();
  assert.deepEqual(shape(t.model), [
    ['entry', 'empty', 0], ['status', '更新失败：读取失败', 1], ['status', '空目录', 1],
    ['entry', 'hid', 0], ['status', '更新失败：读取失败', 1], ['status', '只有隐藏项', 1],
  ]);
});

test('页面里：根目录和子目录的失败行都能点，点了重新取，成功后消失；Mac 的 title 带全文', async t => {
  const { page, host } = await openTree(t, { platform: 'mac', listing: { '': ['src/'], src: ['x.txt'] } });
  host.session();
  await flush();
  rowNamed(page, 'src').dispatch('click');
  await flush();
  host.failing.add('').add('src');
  host.changed();
  await flush();
  const failed = rowsOf(page).filter(node => node.textContent.startsWith('更新失败'));
  assert.equal(failed.length, 2);
  assert.equal(failed[0].title, '更新失败：读不了这个目录');
  assert.ok(rowNamed(page, 'x.txt'), '旧条目还在');

  host.failing.clear();
  const before = host.lists().length;
  failed[1].dispatch('click'); // 子目录那一行
  await flush();
  assert.deepEqual(host.lists().slice(before).map(m => m.path), ['src']);
  assert.equal(rowsOf(page).filter(node => node.textContent.startsWith('更新失败')).length, 1, '子目录的消失，根目录的还在');
  rowsOf(page).find(node => node.textContent.startsWith('更新失败')).dispatch('click');
  await flush();
  assert.equal(rowsOf(page).filter(node => node.textContent.startsWith('更新失败')).length, 0);
});
