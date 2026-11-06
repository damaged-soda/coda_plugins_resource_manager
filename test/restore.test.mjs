// 滚动位置的两样记录（view/restore.mjs）和事件共用模块（view/gestures.mjs）的单元测试。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountGestures } from '../view/gestures.mjs';
import { createRestore, createTrail, TRAIL_LIMIT } from '../view/restore.mjs';
import { Element } from './support/dom.mjs';
import { entries, manual } from './support/page.mjs';
import { flush } from './support/fake.mjs';

test('上层的位置：按目录存，取出即删，最多 32 层，满了丢最久没用的', () => {
  const trail = createTrail();
  assert.equal(TRAIL_LIMIT, 32);
  for (let i = 0; i < 40; i++) trail.remember(`d${i}`, i * 10);
  assert.equal(trail.size, 32);
  assert.equal(trail.take('d0'), undefined, '最旧的被丢了');
  assert.equal(trail.take('d8'), 80);
  assert.equal(trail.take('d8'), undefined, '取出即删');
  trail.remember('d9', 1); // 再记一次算最新的，不会先被丢
  for (let i = 40; i < 48; i++) trail.remember(`d${i}`, 0);
  assert.equal(trail.take('d9'), 1);
  trail.clear();
  assert.equal(trail.size, 0);
});

// 一个就绪的会话，两个假面板。
async function setup() {
  const t = manual();
  t.model.view = 'icons';
  t.session(1, 'A');
  t.root(1, 'ready', '/r');
  const panes = {};
  for (const key of ['tree', 'grid']) panes[key] = { top: 0, scroll: () => panes[key].top, scrollTo: top => { panes[key].top = top; } };
  const restore = createRestore(t.model, panes);
  return { t, panes, restore, load: async (path = '') => { t.reply((await t.lists(path)).at(-1), entries(['a'])); await flush(); } };
}

test('恢复：目标目录的内容到了才用，之前不动；用过一次就结束', async () => {
  const { panes, restore, load } = await setup();
  restore.plan('grid', 90);
  restore.settle();
  assert.equal(panes.grid.top, 0, '内容还没到');
  await load();
  restore.settle();
  assert.equal(panes.grid.top, 90);
  panes.grid.top = 5;
  restore.settle();
  assert.equal(panes.grid.top, 5, '只用一次');
});

test('恢复：绑定会话、根目录身份、排序和目录，对不上就作废', async () => {
  for (const change of [t => t.session(2, 'B'), t => { t.model.scope++; }, t => { t.model.sort = 'date'; }, t => { t.model.cwd = 'x'; }]) {
    const { t, panes, restore, load } = await setup();
    restore.plan('grid', 90);
    change(t);
    await load();
    t.model.dirs.set('x', { loaded: true, entries: [] });
    restore.settle();
    assert.equal(panes.grid.top, 0);
    assert.equal(restore.top('grid'), null, '作废了');
  }
});

test('恢复：绑定的视图不是正在看的视图时等着，切过去才用；还没用的位置保存时用它，不存成 0', async () => {
  const { t, panes, restore, load } = await setup();
  restore.plan('tree', 40);
  await load();
  restore.settle();
  assert.equal(panes.tree.top, 0, '正在看的是图标视图，列表的等着');
  assert.equal(restore.top('tree'), 40);
  t.model.view = 'list';
  restore.settle();
  assert.equal(panes.tree.top, 40);
  assert.equal(restore.top('tree'), null);
});

test('恢复：列表要等根和展开的目录都到了（失败也算有结果），没发出的不算', async () => {
  const { t, panes, restore, load } = await setup();
  t.model.view = 'list';
  t.model.expanded.add('a');
  restore.plan('tree', 40);
  await load();
  restore.settle();
  assert.equal(panes.tree.top, 0, 'a 还没取');
  t.model.dirs.set('a', { loaded: false, error: { message: '坏了' } });
  restore.settle();
  assert.equal(panes.tree.top, 40);
});

test('恢复：目标目录加载失败结束恢复；用户自己滚了放弃；plan 之后清掉的不再用', async () => {
  const { t, panes, restore } = await setup();
  t.model.cwd = 'x';
  t.model.dirs.set('x', { loaded: false, error: { message: '坏了' } });
  restore.plan('grid', 90);
  restore.settle();
  assert.equal(panes.grid.top, 0);
  assert.equal(restore.top('grid'), null, '失败，结束');

  t.model.dirs.set('x', { loaded: false, loading: true });
  restore.plan('grid', 90);
  panes.grid.top = 7; // 用户滚了
  restore.scrolled('grid');
  t.model.dirs.set('x', { loaded: true, entries: [] });
  restore.settle();
  assert.equal(panes.grid.top, 7, '放弃，不再跳');

  restore.plan('grid', 90);
  restore.clear();
  restore.settle();
  assert.equal(panes.grid.top, 7);
});

test('内容变少：目标位置比内容还大时用能到的最大值（面板夹住），照样结束，之后不再设置', async () => {
  const { t, panes, restore, load } = await setup();
  const max = 30; // 内容只够滚到 30，和浏览器一样把设置的值夹住
  panes.grid.scrollTo = top => { panes.grid.top = Math.min(top, max); };
  restore.plan('grid', 900);
  await load();
  restore.settle();
  assert.equal(panes.grid.top, 30);
  assert.equal(restore.top('grid'), null, '结束了');
  panes.grid.top = 12; // 之后用户滚到别处
  t.model.dirs.set('', { loaded: true, entries: [] });
  restore.settle();
  assert.equal(panes.grid.top, 12, '不再跳');
});

test('恢复：滚动事件的位置就是基准时（内容变化、自己滚到顶部引起的）不算用户滚的', async () => {
  const { panes, restore, load } = await setup();
  restore.plan('grid', 90);
  restore.scrolled('grid');
  await load();
  restore.settle();
  assert.equal(panes.grid.top, 90);
});

// ---- 事件共用 ----

test('事件共用：dispose 摘掉全部监听，之后点击、右键、拖动、长按都不再调用注入的动作', () => {
  const el = new Element('div'), scroller = new Element('div'), seen = [];
  const item = { id: 1 };
  const target = new Element('div');
  target.parent = el;
  const gestures = mountGestures(el, {
    hit: () => item, pressable: () => true, activate: it => seen.push(['activate', it]), menu: () => seen.push('menu'), dragText: () => 'x', longPress: true, scroller,
  });
  target.dispatch('click');
  target.dispatch('contextmenu', { clientX: 0, clientY: 0 });
  assert.equal(seen.length, 2);
  gestures.dispose();
  target.dispatch('click');
  target.dispatch('contextmenu', { clientX: 0, clientY: 0 });
  target.dispatch('pointerdown', { pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
  assert.equal(seen.length, 2);
});
