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
  // 默认 Mac：iPhone 上点文件不进预览，既有的预览用例都是 Mac 行为；iPhone 的用例显式传 platform: 'ios'。
  const platform = { platform: 'mac', open: () => {}, close: () => {}, ...coda };
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
      // 文件名里带 / 的在子目录里：列出 request.path 这一层的文件和目录。
      const dir = request.path ? `${request.path}/` : '', kinds = new Map();
      for (const name of Object.keys(files)) if (name.startsWith(dir)) { const [head, rest] = name.slice(dir.length).split('/'); kinds.set(head, rest === undefined ? 'file' : 'dir'); }
      const entries = [...kinds].map(([name, kind]) => ({ name, kind }));
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
// Mac：双击打开；单击只选中。
const openFile = async (page, name = FILE) => { row(page, name).dispatch('click'); row(page, name).dispatch('dblclick'); await flush(); };
const text = page => page.preview.find(node => node.classList.contains('text'))[0]?.textContent;
const meta = page => page.preview.find(node => node.classList.contains('pmeta'))[0];
// 按可访问名称找：图标按钮靠 aria-label，文字按钮就是它的文字。
const button = (root, label) => root.find(node => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? node.textContent) === label)[0];

async function previewing(t, options) {
  const ctx = await open(t, { roots: { '/A': tree('aaaaa'), '/B': tree('bbbbb') }, ...options });
  ctx.host.session('s1');
  await flush();
  await openFile(ctx.page);
  assert.equal(text(ctx.page), 'aaaaa');
  return ctx;
}

test('根目录换了位置（ready → ready）：旧根目录下的选中和预览清掉，回到目录树，不读新根目录里同名的文件', async t => {
  const { page, host } = await previewing(t);
  host.roots['/B'] = tree('bbbbb');
  const reads = host.reads().length;
  host.setRoot('ready', '/B');
  await flush();
  assert.equal(visible(page.preview), false);
  assert.equal(visible(page.tree), true);
  assert.equal(text(page), undefined);
  assert.equal(row(page, FILE).classList.contains('sel'), false, '选中清空');
  assert.equal(host.reads().length, reads, '预览不再读');
});

test('根目录 ready → 其他 → ready（换了位置）：预览收起，回来后是目录树，选中和预览都清空', async t => {
  const { page, host } = await previewing(t);
  host.setRoot('gone');
  await flush();
  assert.equal(visible(page.preview), false);
  assert.match(page.notice.textContent, /工作目录已不存在/);
  assert.equal(text(page), undefined);
  host.setRoot('ready', '/B');
  await flush();
  assert.equal(visible(page.preview), false);
  assert.equal(visible(page.tree), true);
  assert.equal(text(page), undefined);
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
  button(page.preview, '返回').dispatch('click'); // 再有一次变化，保存重试
  await flush();
  tick(300);
  assert.equal(saved.at(-1).sessions.s1.opened, null, '返回清掉 opened');
  assert.equal(saved.at(-1).sessions.s1.selected, FILE, '选中留着');
  await openFile(page);
  tick(300);
  assert.equal(saved.at(-1).sessions.s1.opened, FILE);
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

test('只收到 session、没有 root：30 秒后也提示，之后 root 到达就恢复；已有 root 不再提示', async t => {
  const { page, host, tick } = await open(t, { roots: { '/A': tree('aaaaa') } });
  host.generation++;
  host.root = { state: 'ready', path: '/A' };
  page.post({ type: 'session', generation: host.generation, session: 's1' });
  tick(29_999);
  await flush();
  assert.equal(page.notice.textContent, '正在读取…');
  tick(1);
  await flush();
  assert.match(page.notice.textContent, /没有连上.*30 秒没有收到回答/);
  assert.ok(visible(page.notice));
  page.post({ type: 'root', generation: host.generation, ...host.root });
  await flush();
  assert.ok(visible(page.tree));
  assert.equal(visible(page.notice), false);
  assert.ok(row(page, FILE));
  tick(60_000);
  await flush();
  assert.equal(visible(page.notice), false, '已收到 root，不再提示');
});

test('说明区重画后焦点不丢到页面外：重试按钮聚焦时点它，焦点留在说明区，再失败时落在新按钮上；没聚焦时不抢', async t => {
  const { page, tick } = await open(t, { roots: { '/A': tree('aaaaa') } });
  tick(30_000);
  await flush();
  assert.equal(document.activeElement ?? null, null, '没有聚焦就不抢焦点');
  const retry = button(page.notice, '重试');
  retry.focus();
  retry.dispatch('click'); // 重试：说明区换成「正在读取…」，聚焦的按钮被摘掉
  await flush();
  assert.equal(page.notice.textContent, '正在读取…');
  assert.ok(page.notice.contains(document.activeElement), '焦点在说明区里');
  tick(30_000);
  await flush();
  assert.equal(document.activeElement, button(page.notice, '重试'), '再次失败，焦点落在新的重试按钮上');
});

test('Mac 预览头部最左边有「返回」图标按钮，点了回到目录树：滚动位置在，选中的文件还在，焦点落在目录树', async t => {
  const { page } = await previewing(t);
  const head = page.preview.find(node => node.classList.contains('phead'))[0];
  const back = button(page.preview, '返回');
  assert.equal(head.children[0], back, '在最左边');
  assert.equal(back.title, '返回');
  assert.ok(back.classList.contains('icon'), '和头部其他图标按钮一样');
  assert.equal(back.textContent, '');
  page.tree.scrollTop = 321;
  back.focus();
  back.dispatch('click');
  await flush();
  assert.equal(visible(page.tree), true);
  assert.equal(page.preview.inert, true);
  assert.equal(page.tree.scrollTop, 321);
  assert.equal(page.tree.inert, false);
  assert.equal(globalThis.document.activeElement, page.tree, '焦点不丢到页面外');
  page.tree.scrollTop = 0;
  page.tree.dispatch('scroll');
  assert.ok(row(page, FILE).classList.contains('sel'), '返回后那个文件仍是选中的');
  assert.equal(page.tree.tabIndex, 0, '返回不改容器的 tabIndex，Tab 顺序还在');
});

test('Mac 点返回时按钮没拿到焦点（Safari 点按钮不聚焦）：页面持有焦点，照样交给目录树', async t => {
  const { page } = await previewing(t);
  globalThis.document.activeElement = null;
  button(page.preview, '返回').dispatch('click');
  await flush();
  assert.equal(globalThis.document.activeElement, page.tree);
});

test('Mac 点返回但页面没有焦点（document.hasFocus() 为假）：不动目录树的焦点', async t => {
  const { page } = await previewing(t);
  const back = button(page.preview, '返回');
  back.focus();
  globalThis.document.windowBlurred = true;
  let focused = 0;
  page.tree.focus = () => { focused++; };
  back.dispatch('click');
  await flush();
  assert.equal(visible(page.tree), true, '照样回到目录树');
  assert.equal(focused, 0);
});

for (const blurred of [true, false]) test(`不是点返回造成的切回目录树（切会话、root 变化、后台刷新）：不动焦点（页面失焦：${blurred}）`, async t => {
  {
    const { page, host } = await previewing(t);
    globalThis.document.windowBlurred = blurred;
    let focused = 0;
    page.tree.focus = () => { focused++; };
    globalThis.document.activeElement = button(page.preview, '返回'); // 焦点仍在预览里
    host.session('s2', { state: 'ready', path: '/B' });
    await flush();
    assert.equal(visible(page.preview), false, '切会话后预览已关');
    assert.equal(focused, 0, `切会话 blurred=${blurred}`);
    await openFile(page);
    globalThis.document.activeElement = button(page.preview, '返回');
    host.setRoot('gone');
    await flush();
    host.setRoot('ready');
    host.changed();
    await flush();
    assert.equal(focused, 0, `root 变化 blurred=${blurred}`);
  }
});

test('Mac 返回后展开的目录、它的子项和滚动位置都在：先展开、滚动、打开文件、再返回', async t => {
  const { page, host } = await open(t, { roots: { '/A': { 'dir/inner.txt': { text: 'i' }, [FILE]: { text: 'aaaaa' } } } });
  host.session('s1');
  await flush();
  row(page, 'dir').dispatch('dblclick');
  await flush();
  assert.ok(row(page, 'inner.txt'), '展开后子项出现');
  page.tree.scrollTop = 10; // 假 DOM 不量高：滚得太远目录行会掉出窗口，取不到一行高的非零值
  await openFile(page);
  assert.equal(visible(page.preview), true);
  button(page.preview, '返回').dispatch('click');
  await flush();
  assert.equal(visible(page.tree), true);
  assert.equal(row(page, 'dir').getAttribute('aria-expanded'), 'true', '目录仍是展开的');
  assert.ok(row(page, 'inner.txt'), '子项还在');
  assert.equal(page.tree.scrollTop, 10, '滚动位置保留');
});

test('iPhone 点文件不进预览，预览头部没有「返回」', async t => {
  const { page } = await open(t, { roots: { '/A': tree('aaaaa') }, coda: { platform: 'ios' } });
  await Promise.resolve();
  assert.equal(button(page.preview, '返回'), undefined);
});
