// 写不进输入框时改成复制：等复制的结果再提示。剪贴板同步抛错、异步拒绝都提示「没能写入，也没能复制」；
// 等待期间会话换过（含 A→B→A）就不提示。真实的 app.mjs 和 chat.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { deferred, flush } from './support/fake.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const listing = { '': ['a.txt'] };
const FAILED = '没能写入输入框，已复制', NEITHER = '没能写入，也没能复制';

// 起一个 Mac 会话 s1；copy 由用例给。选「添加到聊天」并让写草稿失败，返回之后页面进入「复制」。
async function start(t, copy) {
  const ctx = await openTree(t, { platform: 'mac', listing, coda: { copy } });
  ctx.host.session('s1', '/work');
  await flush();
  return ctx;
}
async function addAndFail({ page, host }) {
  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  page.menu.find(node => node.tagName === 'BUTTON').find(node => node.textContent === '添加到聊天').dispatch('click');
  host.answer((await host.requests('add_text'))[0], { error: { code: 'draft_failed', message: '不行' } });
  await flush();
}

test('复制成功：提示「没能写入输入框，已复制」，警告样式', async t => {
  const copies = [];
  const ctx = await start(t, text => { copies.push(text); });
  await addAndFail(ctx);
  assert.deepEqual(copies, ['a.txt']);
  assert.equal(ctx.page.hint.textContent, FAILED);
  assert.ok(ctx.page.hint.classList.contains('warn'));
});

test('复制同步抛错：提示「没能写入，也没能复制」，不说已复制', async t => {
  const ctx = await start(t, () => { throw new Error('剪贴板不可用'); });
  await addAndFail(ctx);
  assert.ok(visible(ctx.page.hint));
  assert.equal(ctx.page.hint.textContent, NEITHER);
  assert.ok(ctx.page.hint.classList.contains('warn'));
});

test('复制异步拒绝：同样提示「没能写入，也没能复制」', async t => {
  const ctx = await start(t, () => Promise.reject(new Error('被拒绝')));
  await addAndFail(ctx);
  assert.equal(ctx.page.hint.textContent, NEITHER);
});

test('等复制的结果：还没回答时不提示，回答成功才提示已复制', async t => {
  const pending = deferred();
  const ctx = await start(t, () => pending.promise);
  await addAndFail(ctx);
  assert.equal(visible(ctx.page.hint), false, '复制还没有结果');
  pending.resolve();
  await flush();
  assert.equal(ctx.page.hint.textContent, FAILED);
});

for (const [name, settle] of [['成功', pending => pending.resolve()], ['拒绝', pending => pending.reject(new Error('x'))]]) {
  test(`等复制时换了会话（A→B）：${name}之后不提示`, async t => {
    const pending = deferred();
    const ctx = await start(t, () => pending.promise);
    await addAndFail(ctx);
    ctx.host.session('s2', '/other');
    await flush();
    settle(pending);
    await flush();
    assert.equal(visible(ctx.page.hint), false);
  });

  test(`等复制时 A→B→A：会话 ID 一样，但已经不是原来那一次，${name}之后不提示旧提示`, async t => {
    const pending = deferred();
    const ctx = await start(t, () => pending.promise);
    await addAndFail(ctx);
    ctx.host.session('s2', '/other');
    ctx.host.session('s1', '/work');
    await flush();
    settle(pending);
    await flush();
    assert.equal(visible(ctx.page.hint), false);
  });
}
