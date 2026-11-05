// 文件页（独立窗口）里选中文字的右键菜单：Mac 接，iPhone 不接。真实的 file-app.mjs 和预览，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { fakeSelection } from './support/selection.mjs';

const TEXT = 'one\ntwo\nthree\nfour\n'; // 偏移：one 0-3，two 4-7，three 8-13，four 14-18
const PATH = 'src/app.ts';
const b64 = text => Buffer.from(text).toString('base64');

async function open(t, platform) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], copied = [], events = {};
  const page = await loadFileApp(t, {
    platform, args: { session: 's1', path: PATH },
    postMessage: message => { sent.push(message); },
    on: (name, fn) => { events[name] = fn; },
    copy: text => copied.push(text), getState: () => undefined, setState: () => {},
  });
  page.post({ type: 'session', generation: 1, session: 's1' });
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/work' });
  await flush();
  const read = sent.find(message => message.type === 'read');
  page.post({ type: 'chunk', generation: 1, requestId: read.requestId, data: b64(TEXT), offset: 0, size: TEXT.length, mtimeMs: 1, kind: 'text', eof: true });
  await flush();
  const el = page.preview.find(node => node.classList.contains('text'))[0];
  const sel = fakeSelection(t, page.preview.find(node => node.classList.contains('code'))[0]);
  const adds = async () => { await flush(); return sent.filter(message => message.type === 'add_text').map(({ text, block }) => ({ text, block })); };
  const rightClick = (from, to) => {
    sel.select(el, from, to);
    let taken = false;
    el.dispatch('contextmenu', { clientX: 8, clientY: 9, preventDefault() { taken = true; } });
    return taken;
  };
  const buttons = () => page.menu.find(node => node.tagName === 'BUTTON');
  const choose = label => buttons().find(node => node.textContent === label).dispatch('click');
  return { page, sent, copied, events, el, sel, adds, rightClick, buttons, choose };
}

test('Mac 的独立窗口：选中文字右键有内容、位置、复制三项；位置带这个文件的路径和行号', async t => {
  const { page, adds, copied, rightClick, buttons, choose } = await open(t, 'mac');
  assert.equal(rightClick(4, 13), true);
  assert.ok(visible(page.menu));
  assert.deepEqual(buttons().map(node => node.textContent), ['添加到聊天（内容）', '添加到聊天（位置）', '复制']);
  choose('添加到聊天（位置）');
  assert.deepEqual(await adds(), [{ text: 'src/app.ts:2-3', block: false }]);
  rightClick(4, 7);
  choose('添加到聊天（内容）');
  assert.deepEqual((await adds()).at(-1), { text: 'two', block: true });
  rightClick(4, 8); // 三击选行
  choose('添加到聊天（位置）');
  assert.deepEqual((await adds()).at(-1), { text: 'src/app.ts:2', block: false });
  rightClick(4, 7);
  choose('复制');
  assert.deepEqual(copied, ['two']);
});

test('独立窗口：成功提示、失败改复制并提示；会话是这个窗口自己的（请求带自己的代次）', async t => {
  const { page, sent, copied, adds, rightClick, choose } = await open(t, 'mac');
  rightClick(4, 7);
  choose('添加到聊天（内容）');
  await flush();
  const request = sent.find(message => message.type === 'add_text');
  assert.equal(request.generation, 1);
  page.post({ type: 'added', generation: 1, requestId: request.requestId });
  await flush();
  assert.equal(page.hint.textContent, '已添加到输入框');
  assert.equal(page.hint.classList.contains('warn'), false);
  t.mock.timers.tick(2000);
  assert.equal(visible(page.hint), false);

  rightClick(4, 7);
  choose('添加到聊天（位置）');
  await flush();
  const second = sent.filter(message => message.type === 'add_text')[1];
  page.post({ type: 'added', generation: 1, requestId: second.requestId, error: { code: 'draft_failed', message: '读写草稿失败' } });
  await flush();
  assert.deepEqual(copied, ['src/app.ts:2']);
  assert.equal(page.hint.textContent, '没能写入输入框，已复制');
  assert.ok(page.hint.classList.contains('warn'));
  assert.equal((await adds()).length, 2);
});

test('独立窗口：选区为空或裁剪后为空时不接管；预览滚动、换会话、换文件时菜单关闭', async t => {
  const { page, el, sel, events, rightClick } = await open(t, 'mac');
  assert.equal(rightClick(3, 3), false);
  assert.equal(rightClick(-5, 0), false);
  sel.clear();
  let taken = false;
  el.dispatch('contextmenu', { preventDefault() { taken = true; } });
  assert.equal(taken, false);
  assert.equal(visible(page.menu), false);

  rightClick(4, 7);
  page.preview.find(node => node.classList.contains('pbody'))[0].emit({ type: 'scroll' });
  assert.equal(visible(page.menu), false, '预览滚动');
  rightClick(4, 7);
  events.context({ args: { session: 's1', path: 'other.ts' } });
  assert.equal(visible(page.menu), false, '换文件');
  await flush();
});

test('独立窗口：换会话时菜单和提示一起清掉', async t => {
  const { page, rightClick } = await open(t, 'mac');
  rightClick(4, 7);
  page.hint.hidden = false;
  page.post({ type: 'session', generation: 2, session: 's2' });
  await flush();
  assert.equal(visible(page.menu), false);
  assert.equal(visible(page.hint), false);
});

test('iPhone 的文件页不接：右键（系统选区菜单）不被接管，没有自己的菜单', async t => {
  const { page, rightClick } = await open(t, 'ios');
  assert.equal(rightClick(4, 13), false);
  assert.equal(visible(page.menu), false);
});
