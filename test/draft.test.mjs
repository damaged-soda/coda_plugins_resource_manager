// add_text：lib/draft.mjs 直接测，加从 activate 入口走到（假的）coda.api 的整条链路。全部用假接口，不碰真实会话。
// 草稿接口的路径只在 lib/draft.mjs 里写，测试和 harness 从那里取。
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { addText, compose, draftSession } from '../lib/draft.mjs';
import { DRAFT_LIMIT } from '../view/protocol.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';

const caught = promise => promise.then(() => null, error => error);

// 假的草稿接口：每个会话一份草稿，保存要带对版本。照服务端的规矩，正文只能有 text、attachments（ID 字符串）、revision。
// hooks.get / hooks.post 在回答之前执行，可以卡住或动手脚。
function draftApi({ drafts, hooks = {} }) {
  const log = [];
  return {
    log, drafts,
    async api(path, body) {
      const session = draftSession(path);
      const current = drafts[session];
      if (body === undefined) {
        log.push({ method: 'GET', session });
        await hooks.get?.(session);
        return structuredClone(current);
      }
      log.push({ method: 'POST', session, body: structuredClone(body) });
      await hooks.post?.(session, log.filter(entry => entry.method === 'POST').length);
      const keys = Object.keys(body);
      assert.ok(keys.every(key => ['text', 'attachments', 'revision'].includes(key)), `多余字段：${keys}`);
      assert.ok(body.attachments.every(id => typeof id === 'string'), '附件必须是 ID 字符串');
      if (body.revision !== current.revision) return { draft: structuredClone(current), conflict: true };
      Object.assign(current, { text: body.text, attachments: current.attachments.filter(a => body.attachments.includes(a.id)), revision: current.revision + 1 });
      return { draft: structuredClone(current) };
    },
  };
}
const draftOf = (text = '', attachments = [], revision = 1) => ({ text, attachments, revision });
const withDraft = (drafts, hooks) => {
  const fake = draftApi({ drafts, hooks });
  return { ...fake, coda: { api: (path, body) => fake.api(path, body) } };
};

// ---- 拼法 ----

test('compose：文字类的接在后面，前后各一个空格；内容类另起一行，结尾换行', () => {
  const cases = [
    ['', 'src/a.ts', false, 'src/a.ts '],
    ['看看', 'src/a.ts', false, '看看 src/a.ts '],
    ['看看 ', 'src/a.ts', false, '看看 src/a.ts '],
    ['看看\n', 'src/a.ts', false, '看看\nsrc/a.ts '],
    ['看看\t', 'src/a.ts', false, '看看\tsrc/a.ts '],
    ['', 'a\nb', true, 'a\nb\n'],
    ['看看', 'a\nb', true, '看看\na\nb\n'],
    ['看看\n', 'a\nb', true, '看看\na\nb\n'],
    ['看看 ', 'a\nb', true, '看看 \na\nb\n'],
    // 内容本身以换行结尾（三击选行等）：不再多加，免得多出一个空行
    ['', 'a\nb\n', true, 'a\nb\n'],
    ['看看\n', 'a\n', true, '看看\na\n'],
    ['看看', 'a\n\n', true, '看看\na\n\n'],
    ['', '\n', true, '\n'],
  ];
  for (const [current, text, block, expected] of cases) assert.equal(compose(current, text, block), expected, JSON.stringify([current, block]));
});

// ---- addText 本身 ----

test('addText：保存现有附件的 ID，带上读到的版本', async t => {
  const api = withDraft({ A: draftOf('hi', [{ id: 'att-1', name: 'x.png' }, { id: 'att-2' }], 7) });
  assert.equal(await addText(api.coda, 'A', { text: 'p', block: false }), true);
  assert.deepEqual(api.log.map(entry => entry.method), ['GET', 'POST']);
  assert.deepEqual(api.log[1].body, { text: 'hi p ', attachments: ['att-1', 'att-2'], revision: 7 });
  assert.deepEqual(api.drafts.A.attachments.map(a => a.id), ['att-1', 'att-2'], '服务端的附件还在');
  assert.equal(api.drafts.A.text, 'hi p ');
});

test('addText：会话 ID 要编码，只写传进来的会话', async () => {
  const api = withDraft({ 'a/b': draftOf() });
  await addText(api.coda, 'a/b', { text: 'x', block: true });
  assert.deepEqual(api.log.map(entry => entry.session), ['a/b', 'a/b']);
});

test('addText：版本不符，用服务端回来的内容重拼并成功；附件也取新的', async () => {
  const drafts = { A: draftOf('旧', [{ id: 'a1' }], 1) };
  const api = withDraft(drafts, { post: async (session, n) => {
    if (n === 1) Object.assign(drafts.A, { text: '旧，别人又打了', attachments: [{ id: 'a1' }, { id: 'a2' }], revision: 2 });
  } });
  assert.equal(await addText(api.coda, 'A', { text: 'p', block: false }), true);
  const posts = api.log.filter(entry => entry.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, { text: '旧，别人又打了 p ', attachments: ['a1', 'a2'], revision: 2 });
  assert.equal(api.log.filter(entry => entry.method === 'GET').length, 1, '重试用回答里的草稿，不重新读');
});

test('addText：连续版本不符，共试 3 次后 draft_failed', async () => {
  const drafts = { A: draftOf('x', [], 1) };
  const api = withDraft(drafts, { post: async () => { drafts.A.revision++; } });
  const error = await caught(addText(api.coda, 'A', { text: 'p', block: false }));
  assert.equal(error.code, 'draft_failed');
  assert.equal(api.log.filter(entry => entry.method === 'POST').length, 3);
});

test('addText：超过上限回 draft_too_long，不截断、不保存；重试时服务端内容变长也重查', async () => {
  const near = withDraft({ A: draftOf('x'.repeat(DRAFT_LIMIT - 5), [], 1) });
  assert.equal((await caught(addText(near.coda, 'A', { text: 'abcd', block: false }))).code, 'draft_too_long');
  assert.deepEqual(near.log.map(entry => entry.method), ['GET']);
  assert.equal(await addText(near.coda, 'A', { text: 'abc', block: false }), true, '前后各一个空格加 3 个字，正好 5 个单元，放得下');

  const drafts = { A: draftOf('', [], 1) };
  const api = withDraft(drafts, { post: async () => { Object.assign(drafts.A, { text: 'y'.repeat(DRAFT_LIMIT), revision: 2 }); } });
  assert.equal((await caught(addText(api.coda, 'A', { text: 'p', block: false }))).code, 'draft_too_long');
  assert.equal(api.log.filter(entry => entry.method === 'POST').length, 1, '第二次不保存');
});

test('addText：接口抛错、回答形状不对、文字无效都是 draft_failed', async () => {
  const boom = { api: async () => { throw new Error('网络'); } };
  assert.equal((await caught(addText(boom, 'A', { text: 'p', block: false }))).code, 'draft_failed');
  for (const reply of [undefined, {}, { text: 1, attachments: [] }, { text: '', attachments: [{ id: 1 }] }, { text: '', attachments: {} }]) {
    assert.equal((await caught(addText({ api: async () => reply }, 'A', { text: 'p', block: false }))).code, 'draft_failed', JSON.stringify(reply));
  }
  const api = withDraft({ A: draftOf() });
  for (const bad of [{ text: 7, block: false }, { text: 'a\0b', block: false }, { text: 'a', block: 'yes' }, { block: true }]) {
    assert.equal((await caught(addText(api.coda, 'A', bad))).code, 'draft_failed', JSON.stringify(bad));
  }
  assert.equal(api.log.length, 0, '无效的文字不碰接口');
  const saveFails = { api: async (path, body) => { if (body) throw new Error('x'); return draftOf(); } };
  assert.equal((await caught(addText(saveFails, 'A', { text: 'p', block: false }))).code, 'draft_failed');
});

test('addText：内容和服务端相同时接口直接回 { draft }，算成功', async () => {
  const api = { api: async (path, body) => (body ? { draft: { text: body.text, attachments: [], revision: 1 } } : draftOf('p ')) };
  assert.equal(await addText(api, 'A', { text: 'p', block: false }), true);
});

// ---- 换会话：用 valid 直接测，三个时机 ----

test('addText：读完草稿后会话换了 → 不写、不报', async () => {
  const get = deferred();
  const api = withDraft({ A: draftOf() }, { get: () => get.promise });
  let live = true;
  const run = addText(api.coda, 'A', { text: 'p', block: false }, { valid: () => live });
  await waitFor(() => api.log.length === 1, 'GET');
  live = false;
  get.resolve();
  assert.equal(await run, false);
  assert.deepEqual(api.log.map(entry => entry.method), ['GET']);
});

test('addText：版本不符回来之前会话换了 → 不重试、不报', async () => {
  const drafts = { A: draftOf('x', [], 1) };
  const post = deferred();
  const api = withDraft(drafts, { post: async () => { drafts.A.revision = 5; await post.promise; } });
  let live = true;
  const run = addText(api.coda, 'A', { text: 'p', block: false }, { valid: () => live });
  await waitFor(() => api.log.length === 2, 'POST');
  live = false;
  post.resolve();
  assert.equal(await run, false);
  assert.equal(api.log.filter(entry => entry.method === 'POST').length, 1);
});

test('addText：第二次保存之前会话换了 → 不写、不报；重试始终写最初的会话', async () => {
  const drafts = { A: draftOf('x', [], 1), B: draftOf('', [], 1) };
  let checks = 0;
  const api = withDraft(drafts, { post: async () => { drafts.A.revision = 9; } });
  // 读完草稿、第一次保存回来的两次核对放行，第二次保存之前的不放行
  const valid = () => ++checks <= 2;
  assert.equal(await addText(api.coda, 'A', { text: 'p', block: false }, { valid }), false);
  assert.equal(api.log.filter(entry => entry.method === 'POST').length, 1);

  const retry = withDraft({ A: draftOf('x', [], 1), B: draftOf('', [], 1) }, { post: async (session, n) => { if (n === 1) retry.drafts.A.revision = 9; } });
  assert.equal(await addText(retry.coda, 'A', { text: 'p', block: false }), true);
  assert.deepEqual([...new Set(retry.log.map(entry => entry.session))], ['A']);
});

// ---- 经 activate ----

async function repo(t) {
  const root = join(await tempDir(t), 'repo');
  await mkdir(root);
  return root;
}

// 假 coda：会话查询照旧，草稿接口换成上面的假接口。
function appFor(root, drafts, hooks, threads = { A: checkoutOf(root), B: checkoutOf(root) }) {
  const fake = fakeCoda(threads);
  const base = fake.coda.api, api = withDraft(drafts, hooks);
  fake.coda.api = (path, body) => (draftSession(path) !== null ? api.api(path, body) : base(path));
  activate(fake.coda);
  return { fake, draft: api };
}
async function opened(fake, session, options) {
  const view = fake.open(session, options);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return view;
}
const add = (view, requestId, body, generation = 1) => view.send({ type: 'add_text', generation, requestId, ...body });

test('经 activate：add_text 写进当前会话的草稿，成功回只有信封的 added；两种拼法', async t => {
  const root = await repo(t);
  const { fake, draft } = appFor(root, { A: draftOf('看看', [{ id: 'f1' }], 3) });
  const view = await opened(fake, 'A');
  add(view, 'r1', { text: 'src/a.ts', block: false });
  assert.deepEqual(await view.answer('r1'), { type: 'added', generation: 1, requestId: 'r1' });
  add(view, 'r2', { text: 'const a = 1;', block: true });
  assert.deepEqual(await view.answer('r2'), { type: 'added', generation: 1, requestId: 'r2' });
  assert.equal(draft.drafts.A.text, '看看 src/a.ts \nconst a = 1;\n');
  assert.deepEqual(draft.drafts.A.attachments, [{ id: 'f1' }]);
  assert.ok(draft.log.every(entry => entry.session === 'A'));
});

test('经 activate：文件视图的会话取 args.session', async t => {
  const root = await repo(t);
  const { fake, draft } = appFor(root, { A: draftOf() });
  const view = await opened(fake, null, { view: 'file', args: { session: 'A', path: 'x' } });
  add(view, 'r', { text: 'p', block: false });
  assert.equal((await view.answer('r')).error, undefined);
  assert.equal(draft.drafts.A.text, 'p ');
});

test('经 activate：草稿失败、太长、文字无效都回对应的错误码', async t => {
  const root = await repo(t);
  const { fake, draft } = appFor(root, { A: draftOf('x'.repeat(DRAFT_LIMIT)) });
  const view = await opened(fake, 'A');
  add(view, 'long', { text: 'p', block: false });
  const long = await view.answer('long');
  assert.deepEqual([long.type, long.error.code], ['added', 'draft_too_long']);
  add(view, 'bad', { text: 5, block: false });
  assert.equal((await view.answer('bad')).error.code, 'draft_failed');
  draft.drafts.A = null; // 接口回答不了
  add(view, 'broken', { text: 'p', block: false });
  assert.equal((await view.answer('broken')).error.code, 'draft_failed');
});

test('经 activate：读完草稿后换会话 → 不写、不回答、不报错', async t => {
  const root = await repo(t);
  const get = deferred();
  const { fake, draft } = appFor(root, { A: draftOf(), B: draftOf() }, { get: session => (session === 'A' ? get.promise : undefined) });
  const view = await opened(fake, 'A');
  add(view, 'r', { text: 'p', block: false });
  await waitFor(() => draft.log.length === 1, 'GET');
  view.switchTo('B');
  get.resolve();
  await flush();
  assert.deepEqual(draft.log.map(entry => entry.method), ['GET']);
  assert.equal(view.posted.some(message => message.requestId === 'r'), false);
  assert.equal(draft.drafts.B.text, '', '新会话的草稿没被动');
});

test('经 activate：版本不符回来之前换会话 → 不重试、不回答；重试期间始终是最初的会话', async t => {
  const root = await repo(t);
  const post = deferred(), drafts = { A: draftOf('x', [], 1), B: draftOf('', [], 1) };
  const { fake, draft } = appFor(root, drafts, { post: async () => { drafts.A.revision = 4; await post.promise; } });
  const view = await opened(fake, 'A');
  add(view, 'r', { text: 'p', block: false });
  await waitFor(() => draft.log.length === 2, 'POST');
  view.switchTo('B');
  post.resolve();
  await flush();
  assert.equal(draft.log.filter(entry => entry.method === 'POST').length, 1);
  assert.equal(view.posted.some(message => message.requestId === 'r'), false);
  assert.ok(draft.log.every(entry => entry.session === 'A'), '没有写到 B');
});

test('经 activate：视图关闭后不再保存、不回答', async t => {
  const root = await repo(t);
  const get = deferred();
  const { fake, draft } = appFor(root, { A: draftOf() }, { get: () => get.promise });
  const view = await opened(fake, 'A');
  add(view, 'r', { text: 'p', block: false });
  await waitFor(() => draft.log.length === 1, 'GET');
  view.close();
  get.resolve();
  await flush();
  assert.deepEqual(draft.log.map(entry => entry.method), ['GET']);
});

test('经 activate：旧代次的 add_text 不处理', async t => {
  const root = await repo(t);
  const { fake, draft } = appFor(root, { A: draftOf(), B: draftOf() });
  const view = await opened(fake, 'A');
  add(view, 'old', { text: 'p', block: false }, 99);
  await flush();
  assert.equal(draft.log.length, 0);
});

// ---- 公开边界 ----

test('草稿接口的路径只出现在 lib/draft.mjs，公开文件（含 test/）里都没有', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const hits = [];
  const endpoint = /threads\/[^`'"\s]*\/draft/; // 比对前去掉反斜杠：转义写法的正则字面量也算
  const scan = async dir => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!['.git', 'node_modules'].includes(entry.name)) await scan(rel); continue; }
      if (!entry.isFile() || !/\.(mjs|js|html|css|md|json)$/.test(entry.name)) continue;
      if (endpoint.test((await readFile(join(root, rel), 'utf8')).replaceAll('\\', ''))) hits.push(rel);
    }
  };
  await scan('');
  assert.deepEqual(hits, ['lib/draft.mjs']);
});
