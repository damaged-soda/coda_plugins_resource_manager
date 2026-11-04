// 页面入口 view/app.mjs 的接线：真实的 app.mjs、Link、Model、树和预览，配最小的假 DOM 和一个脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';

const FILE = 'f.txt';
// 每个根目录一份：只有一个文件，大小和 mtimeMs 可以故意取成一样。
const tree = (text, mtimeMs = 100) => ({ [FILE]: { text, mtimeMs } });

// 脚本化的假模块：自动回答 list 和 read；read 可以扣住、可以让它失败。
async function open(t, { roots = {}, coda = {}, timers = true } = {}) {
  if (timers) t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], held = [];
  const host = {
    sent, held, generation: 0, root: null, roots, failRead: null, hold: false,
    reads: () => sent.filter(m => m.type === 'read'),
    state: [],
  };
  const platform = { platform: 'ios', ...coda };
  const page = await loadApp(t, {
    postMessage: message => { sent.push(message); if (message.type === 'list' || message.type === 'read') queueMicrotask(() => answer(message)); },
    on: () => {},
    copy: () => {},
    getState: () => undefined,
    setState: value => host.state.push(value),
    ...platform,
  });
  function answer(request) {
    if (request.generation !== host.generation) return;
    const files = host.roots[host.root?.path] ?? {};
    const base = { generation: request.generation, requestId: request.requestId };
    if (request.type === 'list') {
      const entries = Object.keys(files).map(name => ({ name, kind: 'file' }));
      return page.post({ type: 'listed', ...base, entries, nextCursor: null });
    }
    if (host.hold) return held.push(request);
    if (host.failRead) return page.post({ type: 'chunk', ...base, error: { code: host.failRead.code, message: host.failRead.message } });
    const file = files[request.path];
    const data = Buffer.from(file.text);
    page.post({ type: 'chunk', ...base, data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: file.mtimeMs, kind: 'text', eof: true });
  }
  Object.assign(host, {
    // 换会话：代次加一，先 session 后 root，同真实模块。
    session(id, root = { state: 'ready', path: '/A' }) { host.generation++; host.root = root; page.post({ type: 'session', generation: host.generation, session: id }); page.post({ type: 'root', generation: host.generation, ...root }); },
    setRoot(state, path = host.root?.path) { host.root = { state, path }; page.post({ type: 'root', generation: host.generation, state, path }); },
    changed() { page.post({ type: 'changed', generation: host.generation }); },
    // 迟到的回答：照原请求的代次和请求号给出内容。
    late(request, text) {
      const data = Buffer.from(text);
      page.post({ type: 'chunk', generation: request.generation, requestId: request.requestId, data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 100, kind: 'text', eof: true });
    },
  });
  return { page, host, tick: ms => t.mock.timers.tick(ms) };
}

const row = (page, name) => page.tree.find(node => node.classList.contains('row') && node.textContent.includes(name))[0];
const openFile = async (page, name = FILE) => { row(page, name).dispatch('click'); await flush(); };
const text = page => page.preview.find(node => node.classList.contains('text'))[0]?.textContent;
const meta = page => page.preview.find(node => node.classList.contains('pmeta'))[0];
const button = (root, label) => root.find(node => node.tagName === 'BUTTON' && node.textContent === label)[0];

async function previewing(t, options) {
  const ctx = await open(t, { roots: { '/A': tree('aaaaa'), '/B': tree('bbbbb') }, ...options });
  ctx.host.session('s1');
  await flush();
  await openFile(ctx.page);
  assert.equal(text(ctx.page), 'aaaaa');
  return ctx;
}

test('根目录换了位置（ready → ready）：大小和 mtimeMs 相同也显示新根目录的正文', async t => {
  const { page, host } = await previewing(t);
  host.roots['/B'] = tree('bbbbb');
  host.setRoot('ready', '/B');
  await flush();
  assert.equal(text(page), 'bbbbb');
  assert.ok(visible(page.preview));
});

test('根目录 ready → 其他 → ready：预览收起，恢复后读的是当前根目录', async t => {
  const { page, host } = await previewing(t);
  host.setRoot('gone');
  await flush();
  assert.equal(visible(page.preview), false);
  assert.match(page.notice.textContent, /工作目录已不存在/);
  assert.equal(text(page), undefined);
  host.setRoot('ready', '/B');
  await flush();
  assert.ok(visible(page.preview));
  assert.equal(text(page), 'bbbbb');
});

test('根目录没换位置：普通 root、changed 仍按元数据比较，没变就不重画正文', async t => {
  const { page, host } = await previewing(t);
  const body = page.preview.find(node => node.classList.contains('pbody'))[0].children[0];
  const before = host.reads().length;
  host.setRoot('ready'); // 同一个路径
  await flush();
  host.changed();
  await flush();
  assert.equal(host.reads().length, before + 2, '每次只读第一块来比较');
  assert.equal(page.preview.find(node => node.classList.contains('pbody'))[0].children[0], body, '正文节点没被替换');
});

test('changed：文件变了就重读，预览更新', async t => {
  const { page, host } = await previewing(t);
  host.roots['/A'] = tree('aaaaa, changed', 200);
  host.changed();
  await flush();
  assert.equal(text(page), 'aaaaa, changed');
  assert.match(meta(page).textContent, /14 B/);
});

test('预览中切换会话：旧内容立刻消失，迟到的块不显示', async t => {
  const { page, host } = await previewing(t);
  host.hold = true;
  host.changed(); // 一次后台刷新正在读
  await flush();
  const [late] = host.held.splice(0);
  host.session('s2', { state: 'preparing', path: '/B' }); // 新会话还没有根目录
  assert.equal(page.preview.textContent.includes('aaaaa'), false, '切换的当下就清空');
  await Promise.resolve(); // 渲染按微任务合并
  assert.equal(visible(page.preview), false);
  host.late(late, 'zzzzz');
  await flush();
  assert.equal(text(page), undefined);
  assert.doesNotMatch(page.preview.textContent, /aaaaa|zzzzz/);
  // 新会话 ready 后，正文只来自新会话。
  host.hold = false;
  host.setRoot('ready', '/B');
  await flush();
  assert.equal(page.preview.textContent.includes('aaaaa'), false);
});

test('setState 抛错：界面不受影响，下一次保存照常进行', async t => {
  let fail = 2;
  const saved = [];
  const { page, host, tick } = await open(t, {
    roots: { '/A': tree('aaaaa') },
    coda: { setState: value => { if (fail > 0) { fail--; throw new Error('state too large'); } saved.push(JSON.parse(JSON.stringify(value))); } },
  });
  host.session('s1');
  await flush();
  await openFile(page);
  tick(300); // 触发保存：收紧前后两次都抛
  assert.equal(fail, 0);
  assert.equal(text(page), 'aaaaa');
  assert.equal(saved.length, 0);
  button(page.bar, '返回').dispatch('click'); // 再有一次变化，保存重试
  await flush();
  tick(300);
  assert.equal(saved.at(-1).sessions.s1.selected, null);
  await openFile(page);
  tick(300);
  assert.equal(saved.at(-1).sessions.s1.selected, FILE);
  assert.equal(text(page), 'aaaaa');
});

test('后台刷新失败：保留正文，头部提示原因和重试，不造成正文跳动；成功后提示消失', async t => {
  const { page, host } = await previewing(t);
  const head = page.preview.find(node => node.classList.contains('phead'))[0];
  const body = page.preview.find(node => node.classList.contains('pbody'))[0];
  const shape = () => head.children.length;
  const [bodyNode, headCount, metaNode, normal] = [body.children[0], shape(), meta(page), meta(page).textContent];
  assert.equal(visible(button(page.preview, '重试')), false);

  host.failRead = { code: 'denied', message: '没有读取权限' };
  host.changed();
  await flush();
  assert.equal(text(page), 'aaaaa', '正文还在');
  assert.equal(meta(page).textContent, '更新失败：没有读取权限');
  assert.ok(meta(page).classList.contains('warn'));
  assert.ok(visible(button(page.preview, '重试')));
  assert.equal(body.children[0], bodyNode, '正文节点没被替换');
  assert.equal(shape(), headCount, '头部结构不变，不会挤动正文');
  assert.equal(meta(page), metaNode, '提示占用元信息那一行');

  // 重试仍失败：还是这条提示；恢复后点重试，提示消失、元信息复原。
  button(page.preview, '重试').dispatch('click');
  await flush();
  assert.equal(meta(page).textContent, '更新失败：没有读取权限');
  host.failRead = null;
  host.roots['/A'] = tree('aaaaa', 100);
  button(page.preview, '重试').dispatch('click');
  await flush();
  assert.equal(meta(page).textContent, normal);
  assert.equal(visible(button(page.preview, '重试')), false);
  assert.equal(text(page), 'aaaaa');
});

test('后台刷新超时：提示 30 秒没有回答，下一次刷新（即使没变化）成功后提示消失', async t => {
  const { page, host, tick } = await previewing(t);
  host.hold = true;
  host.changed();
  await flush();
  tick(30_000);
  await flush();
  assert.equal(text(page), 'aaaaa');
  assert.match(meta(page).textContent, /^更新失败：30 秒没有回答/);
  host.hold = false;
  host.changed(); // 文件没变：元数据相同，正文不重画，但提示要撤掉
  await flush();
  assert.doesNotMatch(meta(page).textContent, /更新失败/);
  assert.equal(visible(button(page.preview, '重试')), false);
});

test('hello 一直没有回答：30 秒后给出原因和重试，重试重新发 hello，收到 session 就恢复', async t => {
  const { page, host, tick } = await open(t, { roots: { '/A': tree('aaaaa') } });
  const hellos = () => host.sent.filter(m => m.type === 'hello').length;
  assert.equal(hellos(), 1);
  assert.equal(page.notice.textContent, '正在读取…');
  tick(29_999);
  await flush();
  assert.equal(page.notice.textContent, '正在读取…');
  tick(1);
  await flush();
  assert.match(page.notice.textContent, /没有连上/);
  assert.match(page.notice.textContent, /30 秒没有收到回答/);
  assert.ok(visible(page.notice));

  button(page.notice, '重试').dispatch('click');
  await flush();
  assert.equal(hellos(), 2);
  assert.equal(page.notice.textContent, '正在读取…');
  tick(30_000); // 重试也没回答：再次提示
  await flush();
  assert.match(page.notice.textContent, /没有连上/);

  host.session('s1'); // 迟到的回答：不用重试也恢复
  await flush();
  assert.ok(visible(page.tree));
  assert.equal(visible(page.notice), false);
  assert.ok(row(page, FILE));
  tick(60_000); // 已经回答，不再有超时提示
  await flush();
  assert.equal(visible(page.notice), false);
});

test('hello 发不出去：立刻给出原因，重试可用', async t => {
  let broken = true;
  const { page, host } = await open(t, {
    roots: { '/A': tree('aaaaa') },
    coda: { postMessage: async message => { if (message.type === 'hello' && broken) throw new Error('宿主不可用'); } },
  });
  await flush();
  assert.match(page.notice.textContent, /消息发不出去/);
  broken = false;
  button(page.notice, '重试').dispatch('click');
  await flush();
  assert.equal(page.notice.textContent, '正在读取…');
  assert.ok(host);
});
