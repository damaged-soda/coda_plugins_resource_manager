// 开发用：无头 Chrome（不是 WKWebView）经 CDP 断言假 DOM 查不出的真实布局，并给 Mac 侧栏和预览、iPhone 竖屏和横屏的深浅色截图。不是产品代码。
// 自己起 harness 服务和临时目录（用完删掉），截图放在系统临时目录里，不进仓库。
// 用法：node test/harness/layout.mjs [Chrome 的路径]；失败时退出码非 0。
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const chromePath = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9334, STARTUP_MS = 60000;
const FILLER = 120; // 根目录里排在最后的一批文件，撑出第二页以后的内容
const LONG_LINES = 300; // notes.txt 的行数：文件页要滚得动，才能看最后一行是否被底部工具条挡住
const LONG_NAME = 'a-very-long-file-name-that-cannot-fit-in-a-narrow-sidebar.md'; // 名字截断时 meta 不缩
const LONG_DIR = 'long-directory-name-that-goes-on-and-on-and-on-forever', LONG_SUB = 'another-quite-long-nested-directory-name-for-the-menu';
const DEEP_FILE = 'a-file-with-a-name-that-is-long-too-so-the-path-wraps-many-lines.txt'; // docs 下的三层：行菜单的路径折很多行
const HIDDEN_NAME = '.DS_Store'; // 页面默认藏起来的名字之一：「显示隐藏文件」打开后它才出现，这就是选完之后该等到的样子
const ROOT_ROWS = 4 + 3 + 1 + 2 + FILLER; // 四个目录、三个文件、一个长名字、两个链接、填充；HIDDEN_NAME 默认被页面藏起来，不算
const wait = ms => new Promise(r => setTimeout(r, ms));

// 先建临时目录，之后所有资源都在 try/finally 里创建，失败时一并清理。
const base = await mkdtemp(join(tmpdir(), 'rm-ui-'));
const fixture = join(base, 'demo-project'), profile = join(base, 'profile'), shots = join(base, 'shots');
const children = [];
let serverUrl, ws, keepShots = false;

// 起子进程：启动失败（路径不存在等）和提前退出都变成 early 的拒绝，等待启动的地方用 race 接住。
function launch(name, command, args, options) {
  const child = spawn(command, args, options);
  children.push(child);
  child.early = new Promise((_, reject) => {
    child.once('error', e => reject(new Error(`${name} 启动失败：${e.message}`)));
    child.once('exit', (code, signal) => reject(new Error(`${name} 提前退出（${signal ?? code}）`)));
  });
  child.early.catch(() => {}); // 正常收尾时的退出不算未处理的拒绝
  return child;
}
const within = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒）`)), ms); })]).finally(() => clearTimeout(timer)); };
// 结束子进程并等它退出；礼貌地结束等不到就强杀。
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  if (await Promise.race([exited.then(() => true), wait(3000).then(() => false)])) return;
  child.kill('SIGKILL');
  await exited;
}
const cleanup = async () => {
  ws?.close();
  await Promise.all(children.map(stop));
  await chmod(join(fixture, 'locked'), 0o755).catch(() => {});
  // 跑完了截图才留下，中途失败时整个临时目录都删掉。
  for (const dir of keepShots ? [fixture, profile] : [base]) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

let id = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
// 等条件成立：按真实时间算截止，不按次数。机器忙的时候目录请求和重绘会慢，固定几秒的等待会假失败；等不到就报出在等什么。
const UNTIL_MS = 30000;
const until = async (expr, what) => {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    if (await evaluate(expr)) return;
    if (Date.now() >= deadline) throw new Error(`等不到：${what}（等了 ${UNTIL_MS / 1000} 秒）`);
    await wait(50);
  }
};
// 页面画完两帧：滚动事件在帧的开头派发、先于 requestAnimationFrame 的回调，所以滚动之后画两帧，滚动引起的重画和关菜单都已经发生。
const frames = () => within(evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`), 10000, '等页面画两帧');

async function start() {
  // ---- 假工作目录 ----
  await mkdir(shots, { recursive: true });
  for (const dir of ['src', 'docs', 'assets', 'locked', join('docs', LONG_DIR, LONG_SUB)]) await mkdir(join(fixture, dir), { recursive: true });
  const touch = (path, text = 'x\n') => writeFile(join(fixture, path), text);
  await Promise.all([
    touch('src/app.js'), touch('src/util.mjs'), touch('src/style.css'), touch('docs/README.md'), touch('docs/guide.txt'), touch('assets/logo.png'), touch(join('docs', LONG_DIR, LONG_SUB, DEEP_FILE)),
    touch('LICENSE'), touch('package.json', '{}\n'), touch('notes.txt', Array.from({ length: LONG_LINES }, (_, i) => `line ${i + 1}`).join('\n') + '\n'),
    touch(LONG_NAME), touch(HIDDEN_NAME), ...Array.from({ length: FILLER }, (_, i) => touch(`zz-${String(i).padStart(3, '0')}.txt`)),
  ]);
  // 修改日期有今年和往年的，今天的是刚建的：三种相对格式都能看到。
  await utimes(join(fixture, 'LICENSE'), new Date(2025, 2, 4), new Date(2025, 2, 4, 10, 0));
  await utimes(join(fixture, 'package.json'), new Date(2026, 0, 15), new Date(2026, 0, 15, 9, 30));
  await symlink('notes.txt', join(fixture, 'latest-notes'));
  await symlink('/nonexistent-target', join(fixture, 'dangling'));
  await chmod(join(fixture, 'locked'), 0);

  const server = launch('harness 服务', process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), fixture, fixture, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  serverUrl = await within(Promise.race([server.early, new Promise(resolve => server.stdout.on('data', data => { const m = /http:\/\/\S+/.exec(String(data)); if (m) resolve(m[0]); }))]), STARTUP_MS, 'harness 服务启动');

  // 端口上已经有调试服务时，连上的会是别人的 Chrome，不是我们起的这个。
  if (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then(() => true, () => false)) throw new Error(`调试端口 ${DEBUG_PORT} 已被占用`);
  const chrome = launch('Chrome', chromePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const connect = async () => {
    for (;;) {
      try { const page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find(x => x.type === 'page'); if (page) return page; } catch { /* 还没起来 */ }
      await wait(200);
    }
  };
  const page = await within(Promise.race([chrome.early, connect()]), STARTUP_MS, 'Chrome 调试端口连接');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await within(new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('CDP 连接失败'))); }), STARTUP_MS, 'CDP 连接');
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id).resolve(m); waiting.delete(m.id); } });
  ws.addEventListener('close', () => { for (const { reject } of waiting.values()) reject(new Error('CDP 连接断开')); waiting.clear(); });
}

// 页面发出的请求（带 requestId 的消息）和它们的回答：记下已发出的个数和还没回答的编号，「请求都有了回答」就是目录请求和重绘都完成的信号。
// 回答的监听在捕获阶段先于页面自己的处理，但页面处理在同一个任务里完成，下一条 evaluate 到达时重绘已经发生。
const trackRequests = `(() => { if (window.__rpc) return; const rpc = window.__rpc = { sent: 0, open: new Set(), adds: [], copies: [] }, post = coda.postMessage;
  coda.postMessage = message => { if (message?.requestId) { rpc.sent++; rpc.open.add(message.requestId); } if (message?.type === 'add_text') rpc.adds.push({ text: message.text, block: message.block }); return post(message); };
  coda.copy = text => { rpc.copies.push(text); };
  addEventListener('message', event => { if (event.data?.requestId) rpc.open.delete(event.data.requestId); }, true); })()`;
const SIZES = { mac: [280, 700, '0,0,0,0'], narrow: [200, 700, '0,0,0,0'], portrait: [420, 790, '0,0,34,0'], landscape: [844, 390, '0,59,21,59'], short: [420, 220, '0,0,21,0'] };
// state：载入前写进页面的保存状态（假装上次退出时的样子，例如选中的文件）。
// extra：附在页面地址后的参数，如 '&back=0'（模拟没有 coda.back 的旧客户端）。
async function open(size, platform, theme, { keep = false, state = null, extra = '' } = {}) {
  const [w, h, safe] = SIZES[size];
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: platform === 'ios' });
  const stamp = Date.now(), url = `${serverUrl}view/index.html?platform=${platform}&theme=${theme}&safe=${safe}&t=${stamp}${extra}`;
  if (!keep) {
    await send('Page.navigate', { url: `${serverUrl}view/index.html` });
    // 等空白页（没有查询参数）载入：还停在上一页时，下面的清理会落在旧页上，新页离开时的保存又把状态写回来。
    await until(`location.pathname === '/view/index.html' && location.search === '' && document.readyState !== 'loading' && typeof coda !== 'undefined'`, '空白页载入');
    await evaluate('coda.setState = () => {}; sessionStorage.clear()');
  }
  if (state) await evaluate(`sessionStorage.setItem('harness-state:files', ${JSON.stringify(JSON.stringify(state))})`); // 空白页离开时的 pagehide 不能再把状态存回去
  await send('Page.navigate', { url });
  // navigate 返回时新页还没接手：只查行会被上一页（它的行还在）骗过去，要先等地址里的时间戳是新页的。
  await until(`new URLSearchParams(location.search).get('t') === '${stamp}'`, '新页载入');
  await until(`document.querySelectorAll('.row.entry').length > 0`, '目录树出现');
  await evaluate(trackRequests);
}
// 文件页：query 是额外的参数；等正文或说明区出现。
async function openFile(size, theme, query = 'session=A&path=notes.txt') {
  const [w, h, safe] = SIZES[size];
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  const stamp = Date.now();
  await send('Page.navigate', { url: `${serverUrl}view/file.html?platform=ios&theme=${theme}&safe=${safe}&${query}&t=${stamp}` });
  await until(`new URLSearchParams(location.search).get('t') === '${stamp}'`, '新页载入'); // 同 open：不能让上一页的正文骗过下面的等待
  await until(`document.querySelector('.text') || document.querySelector('#notice:not(.off) p')`, '文件页出现');
}
// ⋯ 菜单：iPhone 点页内的 ⋯（同步），Mac 照控制页的方式发 { harness: 'toolbar', id: 'more' }（页面收到消息才处理）。
// 返回时消息已经处理完，菜单已经开了（或再按一次关了）。
const openMore = platform => evaluate(platform === 'ios' ? `document.querySelector('[aria-label="更多"]').click()`
  : `new Promise(resolve => { const seen = event => { if (event.data?.harness !== 'toolbar') return; removeEventListener('message', seen); resolve(); }; addEventListener('message', seen); postMessage({ harness: 'toolbar', id: 'more' }, '*'); })`);
const menuClosed = `document.getElementById('menu').hidden`;
// 页面发出的请求都有了回答。
const settled = what => until(`window.__rpc.open.size === 0`, `${what}：页面发出的请求都有了回答`);
// 在 ⋯ 菜单里选一项，等到它真正做完：菜单关闭，done 成立（选完之后该看到的样子），请求都有了回答。不靠固定睡眠。
const pick = async (label, platform = 'mac', { done = null, what = '' } = {}) => {
  await openMore(platform);
  const found = await evaluate(`(() => { const item = [...document.querySelectorAll('#menu button')].find(x => x.textContent === ${JSON.stringify(label)}); item?.click(); return item !== undefined; })()`);
  if (!found) throw new Error(`菜单里没有「${label}」这一项`);
  await until(menuClosed, `选「${label}」后菜单关闭`);
  if (done) await until(done, what);
  await settled(`选「${label}」后`);
};
// 前 12 个文件的顺序：换排序之后，目录树画完新顺序它就变了。
const fileOrder = `[...document.querySelectorAll('.row.file .name')].slice(0, 12).map(x => x.textContent).join('|')`;
// 换排序：等到文件的顺序和选之前不同（要求新排序的顺序不同于旧的）。
const pickSort = async (label, platform = 'mac') => {
  const before = await evaluate(fileOrder);
  await pick(label, platform, { done: `${fileOrder} !== ${JSON.stringify(before)}`, what: `目录树按「${label}」重画（文件的顺序变了）` });
};
// 选「显示隐藏文件」：等到隐藏文件出现在目录树里。
const pickHidden = platform => pick('显示隐藏文件', platform, { done: `[...document.querySelectorAll('.row.file .name')].some(x => x.textContent === '${HIDDEN_NAME}')`, what: `隐藏文件 ${HIDDEN_NAME} 出现在目录树里` });
const shoot = async name => { await wait(300); await writeFile(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };

const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`); if (!ok) failures.push(name); };

// 视口里每隔一段取一个点：每一点都该落在某一行上（空白说明虚拟滚动画少了）。
const covered = `(() => { const pane = document.getElementById('tree'), r = pane.getBoundingClientRect(), miss = [];
  const head = document.querySelector('.section'), from = head && head.getClientRects().length ? Math.max(r.top, head.getBoundingClientRect().bottom) : r.top; // 标题行随内容滚走：还在视口里的那一段不算
  for (let y = from + 4; y < r.bottom - 4; y += 8) { const e = document.elementFromPoint(r.left + r.width / 2, y); if (!e?.closest('.row')) miss.push(Math.round(y)); }
  return miss; })()`;

let exitCode = 1;
try {
  await start();
  // ---- 断言 ----
  // 有标题（Mac）时：滚到第二页深处，状态存下来，重新载入后恢复到同一个位置，视口里没有空白。
  await open('mac', 'mac', 'light');
  check('Mac：有分区标题', await evaluate(`document.querySelector('.section')?.textContent === 'demo-project' && document.querySelector('.section').getClientRects().length > 0`));
  const target = await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = p.clientHeight * 1.5 + 13; p.dispatchEvent(new Event('scroll')); return p.scrollTop; })()`);
  // 滚动之后 300 毫秒的定时器才存状态：等到存下的位置就是这个值，再重新载入。
  await until(`Object.values(JSON.parse(sessionStorage.getItem('harness-state:files') || '{"sessions":{}}').sessions).some(x => x.scroll?.tree === ${target})`, '滚动位置存进保存的状态');
  await open('mac', 'mac', 'light', { keep: true });
  await until(`document.getElementById('tree').scrollTop > 0`, '恢复滚动位置');
  await frames();
  check('Mac：有标题时恢复到第二页深处', (await evaluate(`document.getElementById('tree').scrollTop`)) === target, `存了 ${target}`);
  check('Mac：恢复后视口里每一点都有行', (await evaluate(covered)).length === 0, JSON.stringify(await evaluate(covered)));

  // 标题把列表推下去 offsetTop：画出的第一行就是 floor((滚动值 − offsetTop) / 行高) − 预渲染的 8 行，位置也对得上。
  const geometry = await evaluate(`(() => { const p = document.getElementById('tree'), sp = document.querySelector('.spacer'), sec = document.querySelector('.section'),
    rows = [...document.querySelectorAll('.row')], rowH = parseFloat(sp.style.height) / ${ROOT_ROWS}, i0 = Number(rows[0].dataset.i);
    return { offset: sp.offsetTop, title: sec.offsetHeight, first: i0, expected: Math.max(0, Math.floor((p.scrollTop - sp.offsetTop) / rowH) - 8),
      placed: rows.every(r => Math.abs(r.getBoundingClientRect().top - sp.getBoundingClientRect().top - Number(r.dataset.i) * rowH) < 0.01) }; })()`);
  check('Mac：spacer 的 offsetTop 就是标题高度', geometry.offset === geometry.title && geometry.title > 0, JSON.stringify(geometry));
  check('Mac：有标题时画出的第一行按扣掉标题的滚动值算，位置对得上', geometry.first === geometry.expected && geometry.placed, JSON.stringify(geometry));


  // 标题行随内容滚走（不吸顶）：当前在第二页深处，标题已经在容器顶之上，容器顶那一点落在的真实行，序号对得上；
  // 滚回顶部以及滚过几个点时，标题的位置恰好是 −滚动值。
  const scrolled = await evaluate(`(() => { const p = document.getElementById('tree'), sp = document.querySelector('.spacer'), sec = document.querySelector('.section'),
    rowH = parseFloat(sp.style.height) / ${ROOT_ROWS}, pr = p.getBoundingClientRect(), sr = sec.getBoundingClientRect();
    const hit = document.elementFromPoint(pr.left + pr.width / 2, pr.top + 2)?.closest('.row');
    const at = n => { p.scrollTop = n; p.dispatchEvent(new Event('scroll')); return Math.round((sec.getBoundingClientRect().top - p.getBoundingClientRect().top) * 100) / 100; };
    const result = { scroll: p.scrollTop, gone: sr.bottom <= pr.top + 0.01, position: getComputedStyle(sec).position, hit: hit ? Number(hit.dataset.i) : null,
      expected: Math.floor((p.scrollTop - sp.offsetTop + 2) / rowH), buttons: sec.querySelectorAll('button').length };
    const keep = p.scrollTop;
    result.top0 = at(0); result.top7 = at(7); result.top13 = at(13);
    p.scrollTop = keep; p.dispatchEvent(new Event('scroll'));
    return result; })()`);
  check('Mac：标题行随内容滚走（不吸顶），容器顶那一点的真实行序号对得上，标题里没有按钮', scrolled.scroll > 0 && scrolled.gone && scrolled.position === 'static' && scrolled.hit === scrolled.expected
    && scrolled.top0 === 0 && scrolled.top7 === -7 && scrolled.top13 === -13 && scrolled.buttons === 0, JSON.stringify(scrolled));
  // 滚到最底：最后一行完整可见，没有空白。
  const bottom = await evaluate(`(async () => { const p = document.getElementById('tree'); p.scrollTop = p.scrollHeight; p.dispatchEvent(new Event('scroll')); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const last = [...document.querySelectorAll('.row')].at(-1).getBoundingClientRect(), pr = p.getBoundingClientRect(); return { lastBottom: last.bottom, paneBottom: pr.bottom, text: [...document.querySelectorAll('.row')].at(-1).textContent }; })()`);
  check('Mac：滚到底，最后一行完整在容器里', bottom.text.includes('zz-119') && bottom.lastBottom <= bottom.paneBottom + 0.5, JSON.stringify(bottom));

  // 主题或字号变了之后探针重新量：spacer 的高度 = 行数 × 实际行高。
  const rowCheck = async label => {
    const { actual, per } = await evaluate(`(() => { const row = document.querySelector('.row.entry').getBoundingClientRect().height;
      return { actual: row, per: parseFloat(document.querySelector('.spacer').style.height) / ${ROOT_ROWS} }; })()`);
    check(`${label}：探针量到的行高等于实际行高`, Math.abs(actual - per) < 0.01, `实际 ${actual}，探针 ${per}`);
  };
  const rowHeight = () => evaluate(`document.querySelector('.row.entry').getBoundingClientRect().height`);
  await open('mac', 'mac', 'light');
  await rowCheck('Mac 浅色');
  check('Mac：滚动位置为 0 时第一行紧挨标题，没被遮挡', await evaluate(`(() => { const sec = document.querySelector('.section').getBoundingClientRect(), row = document.querySelector('.row').getBoundingClientRect(); return row.top >= sec.bottom - 0.01 && row.top - sec.bottom < 1; })()`));
  check('Mac：13px 时实际行高 26', (await rowHeight()) === 26, String(await rowHeight()));
  await evaluate(`postMessage({ harness: 'theme', kind: 'dark', fontSize: '20px' }, '*')`);
  await until(`document.documentElement.style.getPropertyValue('--coda-font-size') === '20px'`, '字号 20px 生效'); // 主题消息处理时同步重新量行高
  check('Mac：字号改 20px 后实际行高 40（字号真的生效了）', (await rowHeight()) === 40, String(await rowHeight()));
  await rowCheck('Mac 换深色并改字号后');
  await open('portrait', 'ios', 'light');
  await rowCheck('iPhone 竖屏');
  check('iPhone：行高 58', (await evaluate(`document.querySelector('.row.entry').getBoundingClientRect().height`)) === 58);
  check('iPhone：不显示分区标题', await evaluate(`getComputedStyle(document.querySelector('.section')).display === 'none'`));
  await evaluate(`postMessage({ harness: 'theme', kind: 'dark' }, '*')`);
  await until(`document.documentElement.classList.contains('coda-dark')`, '换成深色');
  await rowCheck('iPhone 换深色后');


  // iPhone 的两行列表：58 点行高由 CSS 定、探针量得到；第二行是 日期 · 大小；不能打开的条目只有名字、垂直居中；分隔线从图标之后开始。
  await open('portrait', 'ios', 'light');
  await rowCheck('iPhone 58 点');
  const two = await evaluate(`(() => { const rows = [...document.querySelectorAll('.row.entry')], q = (row, cls) => row.querySelector(cls), box = n => n.getBoundingClientRect();
    const normal = rows.find(r => r.textContent.includes('LICENSE')), dead = rows.find(r => r.classList.contains('dead')), rb = box(normal);
    const sub = q(normal, '.sub'), name = q(normal, '.name'), d = box(q(dead, '.name')), db = box(dead), dir = rows.find(r => r.classList.contains('dir'));
    const second = rows[1], third = rows[2], before = getComputedStyle(second, '::before'), first = getComputedStyle(rows[0], '::before');
    return { normalH: rb.height, sub: sub.textContent, subShown: getComputedStyle(sub).display !== 'none', subInside: box(sub).top >= box(name).bottom - 1 && box(sub).bottom <= rb.bottom && box(name).top >= rb.top,
      metaHidden: getComputedStyle(q(normal, '.meta')).display === 'none', deadSub: q(dead, '.sub') === null, deadH: db.height, deadCentered: Math.abs((d.top + d.bottom) / 2 - (db.top + db.bottom) / 2) < 0.6,
      dirSub: q(dir, '.sub').textContent, sepLeft: before.left, sepHeight: before.height, sepTop: before.top, firstSep: first.content, thirdSep: getComputedStyle(third, '::before').left,
      stepOk: Math.abs(box(third).top - box(second).top - 58) < 0.01 }; })()`);
  check('iPhone：两行列表，名字下面是 日期 · 大小（往年/今年/今天的格式），文件夹只有日期，Mac 的 meta 隐藏', two.normalH === 58 && /^2025年3月 · \d+ B$/.test(two.sub) && two.subShown && two.subInside && two.metaHidden && /^\d\d:\d\d$/.test(two.dirSub), JSON.stringify(two));
  check('iPhone：不能打开的条目只有名字，行高 58，名字垂直居中', two.deadSub && two.deadH === 58 && two.deadCentered, JSON.stringify(two));
  check('iPhone：分隔线 1 点，从图标之后开始（首行没有），行距 58', two.sepHeight === '1px' && two.sepLeft === '46px' && two.sepTop === '0px' && two.firstSep === 'none' && two.thirdSep === '46px' && two.stepOk, JSON.stringify(two));

  // 状态行和「再显示」也是 58 点：展开 locked（读取失败的目录有一行状态）。
  await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('locked')).click()`);
  await until(`[...document.querySelectorAll('.row.status')].length > 0`, '状态行出现');
  check('iPhone：状态行也是 58 点', await evaluate(`[...document.querySelectorAll('.row.status')].every(r => r.getBoundingClientRect().height === 58)`));

  // 卡片末行：滚到底，最后一行完整在卡片里，卡片没有裁掉内容。
  for (const size of ['portrait', 'landscape']) {
    await open(size, 'ios', 'light');
    const end = await evaluate(`(async () => { const p = document.getElementById('tree'); p.scrollTop = p.scrollHeight; p.dispatchEvent(new Event('scroll'));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rows = [...document.querySelectorAll('.row')], last = rows.at(-1).getBoundingClientRect(), card = document.querySelector('.spacer'), c = card.getBoundingClientRect(), pane = p.getBoundingClientRect();
      return { lastText: rows.at(-1).textContent, lastH: last.height, inCard: last.bottom <= c.bottom + 0.01, cardFits: card.scrollHeight <= card.clientHeight, inPane: last.bottom <= pane.bottom + 0.01, cardBottom: c.bottom, paneBottom: pane.bottom }; })()`);
    check(`iPhone ${size}：卡片末行完整可见`, end.lastText.includes('zz-119') && end.lastH === 58 && end.inCard && end.cardFits && end.inPane, JSON.stringify(end));
  }

  // iPhone 文件页的底部工具条：完整在视口里，操作区至少 44 点，安全区另加；代码区最后一行能滚到工具条上方。
  const SAFE_BOTTOM = { portrait: 34, landscape: 21 };
  for (const size of ['portrait', 'landscape']) {
    await openFile(size, 'light');
    const land = size === 'landscape';
    const bar = await evaluate(`(() => { const b = document.getElementById('bar'), r = b.getBoundingClientRect();
      const buttons = [...b.querySelectorAll('button')].filter(x => x.getClientRects().length > 0);
      return { bottom: r.bottom, height: r.height, top: r.top, inner: innerHeight, names: buttons.map(x => x.textContent), heights: buttons.map(x => x.getBoundingClientRect().height),
        widths: buttons.map(x => x.getBoundingClientRect().width), inside: buttons.every(x => { const q = x.getBoundingClientRect(); return q.left >= 0 && q.right <= innerWidth && q.top >= r.top && q.bottom <= r.bottom; }),
        previewPad: getComputedStyle(document.getElementById('preview')).paddingBottom, order: b.previousElementSibling.id }; })()`);
    check(`iPhone ${size}：文件页底部工具条贴着视口底边，高度 = 操作区 44 点 + 安全区 + 1 点分隔线`, bar.bottom === bar.inner && bar.height === 44 + SAFE_BOTTOM[size] + 1 && bar.order === 'stage', JSON.stringify(bar));
    check(`iPhone ${size}：${land ? '返回、刷新、复制路径' : '刷新、复制路径（返回只在横屏）'}都可见，各至少 44 点，完整在工具条里`,
      JSON.stringify(bar.names) === JSON.stringify(land ? ['返回', '刷新', '复制路径'] : ['刷新', '复制路径']) && bar.heights.every(x => x >= 44) && bar.widths.every(x => x >= 44) && bar.inside, JSON.stringify(bar));
    check(`iPhone ${size}：预览面板不重复留安全区`, bar.previewPad === '0px', bar.previewPad);
    const end = await evaluate(`(async () => { const body = document.querySelector('.pbody'); body.scrollTop = body.scrollHeight; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const text = document.querySelector('.text').getBoundingClientRect(), pane = body.getBoundingClientRect(), bar = document.getElementById('bar').getBoundingClientRect();
      return { textBottom: text.bottom, paneBottom: pane.bottom, barTop: bar.top, lines: document.querySelector('.text').textContent.trim().split('\\n').length }; })()`);
    check(`iPhone ${size}：代码区滚到底，最后一行在工具条上方`, end.lines === LONG_LINES && end.textBottom <= end.barTop + 0.5 && end.paneBottom <= end.barTop + 0.5, JSON.stringify(end));
    check(`iPhone ${size}：头部元信息是 行数 · 大小，没有复制按钮`, (await evaluate(`document.querySelector('.pmeta').textContent`)).startsWith(`${LONG_LINES} 行 · `)
      && (await evaluate(`document.querySelectorAll('.phead button[aria-label="复制路径"]').length`)) === 0);

    // 说明区状态（没有可浏览的目录）：工具条不被盖住、不在 inert 里，复制的是启动值里的路径。
    await openFile(size, 'light', 'session=ZZ&path=notes.txt');
    const usable = await evaluate(`(() => { window.__copied = null; coda.copy = text => { window.__copied = text; };
      const buttons = [...document.querySelectorAll('#bar button')].filter(x => x.getClientRects().length > 0);
      const reach = buttons.map(x => { const r = x.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit?.closest('button') === x && !x.closest('[inert]'); });
      buttons.find(x => x.textContent === '复制路径').click();
      return { reach, copied: window.__copied, notice: document.getElementById('notice').textContent, noticeShown: !document.getElementById('notice').classList.contains('off') }; })()`);
    check(`iPhone ${size}：说明区下工具条的按钮都点得到，复制路径可用`, usable.reach.length === (land ? 3 : 2) && usable.reach.every(Boolean) && usable.copied === 'notes.txt' && usable.noticeShown, JSON.stringify(usable));
  }

  // ⋯ 菜单：刷新、显示隐藏文件，分隔线，小标题「排序」，名称 / 种类 / 日期 / 大小。两端共用一份内容，宽度随内容，完整在页面内。
  // 0.4.0 的菜单最小宽 150 点；iPhone 上 ⋯ 菜单本来就由「显示隐藏文件」撑到 158 点。
  const MORE_NAMES = ['刷新', '显示隐藏文件', '名称', '种类', '日期', '大小'], MORE_SHAPE = ['BUTTON', 'BUTTON', 'HR', 'P', 'BUTTON', 'BUTTON', 'BUTTON', 'BUTTON'];
  const OLD_WIDTH = { mac: 150, ios: 158 };
  const menuBox = `(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(), items = [...m.querySelectorAll('button')];
    return { shown: !m.hidden, shape: [...m.children].map(x => x.tagName), names: items.map(x => x.textContent), roles: items.map(x => x.getAttribute('role')), checked: items.map(x => x.getAttribute('aria-checked')),
      marks: items.map(x => x.querySelector('svg') !== null), heads: [...m.querySelectorAll('.menu-head')].map(x => x.textContent), heights: items.map(x => x.getBoundingClientRect().height),
      textLefts: items.map(x => Math.round(x.lastElementChild.getBoundingClientRect().left * 10) / 10), left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight,
      width: Math.round((r.right - r.left) * 10) / 10 }; })()`;
  // 内容对、两端对齐、完整在安全区内。hidden：显示隐藏文件现在是不是开着。
  const moreOk = (menu, { sl = 0, sr = 0, hidden = false, sort = '名称' } = {}) => menu.shown && JSON.stringify(menu.shape) === JSON.stringify(MORE_SHAPE) && JSON.stringify(menu.names) === JSON.stringify(MORE_NAMES)
    && JSON.stringify(menu.heads) === JSON.stringify(['排序']) && menu.roles.join() === 'menuitem,menuitemcheckbox,menuitemradio,menuitemradio,menuitemradio,menuitemradio'
    && JSON.stringify(menu.checked) === JSON.stringify([null, String(hidden), ...['名称', '种类', '日期', '大小'].map(x => String(x === sort))])
    && JSON.stringify(menu.marks) === JSON.stringify([false, hidden, ...['名称', '种类', '日期', '大小'].map(x => x === sort)]) && new Set(menu.textLefts).size === 1
    && menu.left >= sl && menu.right <= menu.w - sr && menu.top >= 0 && menu.bottom <= menu.h;

  // iPhone 树页顶部：返回（仅横屏）、根目录名、⋯，没有独立的排序按钮；⋯ 菜单完整在安全区内，项至少 44 点，再次激活只关闭。
  for (const [size, theme] of [['portrait', 'light'], ['landscape', 'light'], ['portrait', 'dark'], ['landscape', 'dark']]) {
    await open(size, 'ios', theme);
    const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
    const top = await evaluate(`(() => { const b = document.getElementById('bar'), more = b.querySelector('[aria-label="更多"]'), r = more.getBoundingClientRect(), exit = b.querySelector('.exit');
      return { title: b.querySelector('.bar-title').textContent, w: r.width, h: r.height, inside: r.right <= innerWidth - ${sr}, exitShown: exit.getClientRects().length > 0,
        children: [...b.children].map(x => x.getAttribute('aria-label') ?? x.className.split(' ')[0]), sortButtons: b.querySelectorAll('[aria-label^="排序"]').length }; })()`);
    check(`iPhone ${size} ${theme}：顶部工具条只有返回、根目录名和 44 点的 ⋯，没有排序按钮，返回${size === 'landscape' ? '显示' : '隐藏'}`,
      top.title === 'demo-project' && top.w >= 44 && top.h >= 44 && top.inside && top.exitShown === (size === 'landscape') && JSON.stringify(top.children) === JSON.stringify(['exit', 'bar-title', '更多']) && top.sortButtons === 0, JSON.stringify(top));
    await openMore('ios');
    const menu = await evaluate(menuBox);
    const expanded = await evaluate(`document.querySelector('[aria-label="更多"]').getAttribute('aria-expanded')`);
    check(`iPhone ${size} ${theme}：⋯ 菜单 刷新、显示隐藏文件、分隔线、小标题、四个排序项，项至少 44 点，文字对齐，完整在安全区内，宽 ${menu.width}（0.4.0 是 ${OLD_WIDTH.ios}）`,
      moreOk(menu, { sl, sr }) && menu.heights.every(x => x >= 44) && expanded === 'true' && menu.width <= OLD_WIDTH.ios, JSON.stringify(menu));
    await openMore('ios'); // 没有 pointerdown 的再次激活，同键盘
    check(`iPhone ${size} ${theme}：再次激活 ⋯ 只关闭`, await evaluate(`document.getElementById('menu').hidden && document.querySelector('[aria-label="更多"]').getAttribute('aria-expanded') === 'false'`));
    await pickHidden('ios');
    await openMore('ios');
    const hiddenOn = await evaluate(menuBox);
    check(`iPhone ${size} ${theme}：选「显示隐藏文件」后菜单关闭，再打开时对勾在，其余各项仍对齐`, moreOk(hiddenOn, { sl, sr, hidden: true }), JSON.stringify(hiddenOn));
    if (size === 'portrait') await shoot(`ios-portrait-${theme}-menu-hidden-on`);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    check(`iPhone ${size} ${theme}：按 Escape 关闭菜单`, await evaluate(`document.getElementById('menu').hidden`));
  }

  // Mac 的「更多」：控制页只把项目的 id 发回，这里照它的方式往页面发 { harness: 'toolbar', id }。内容和 iPhone 相同，完整在页面内，贴右上角，宽度比 150 窄，再按一次关闭。
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    await openMore('mac');
    const mac = await evaluate(menuBox);
    check(`Mac ${theme}：「更多」菜单内容和 iPhone 相同，完整在页面内，贴右上角，宽 ${mac.width}（0.4.0 是 ${OLD_WIDTH.mac}）`,
      moreOk(mac) && mac.w - mac.right <= 8 && mac.top <= 8 && mac.width < OLD_WIDTH.mac, JSON.stringify(mac));
    await shoot(`mac-sidebar-${theme}-menu`);
    await openMore('mac');
    check(`Mac ${theme}：再按一次「更多」只关闭`, await evaluate(`document.getElementById('menu').hidden`));
    await pickHidden('mac');
    await openMore('mac');
    const on = await evaluate(menuBox);
    check(`Mac ${theme}：选「显示隐藏文件」后菜单关闭，再打开时对勾在，其余各项仍对齐`, moreOk(on, { hidden: true }), JSON.stringify(on));
    if (theme === 'dark') await shoot('mac-sidebar-dark-menu-hidden-on');
    await evaluate(`document.getElementById('tree').scrollTop = 30`);
    await frames(); // 原生的滚动事件在下一帧派发
    check(`Mac ${theme}：菜单开着时滚动目录树，菜单关闭`, await evaluate(`document.getElementById('menu').hidden`));
    await openMore('mac');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    check(`Mac ${theme}：按 Escape 关闭菜单`, await evaluate(`document.getElementById('menu').hidden`));
    await openMore('mac');
    await evaluate(`document.querySelector('.row.entry').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1 }))`);
    check(`Mac ${theme}：点菜单外关闭菜单`, await evaluate(`document.getElementById('menu').hidden`));
  }

  // Mac 的 meta：容器查询指定了查询祖先（#tree）。宽度够时显示（名字截断、meta 不缩），窄于约 220 点时隐藏。
  await open('mac', 'mac', 'light');
  const wide = await evaluate(`(() => { const rows = [...document.querySelectorAll('.row.entry')], box = n => n.getBoundingClientRect();
    const long = rows.find(r => r.textContent.includes('${LONG_NAME.slice(0, 12)}')), plain = rows.find(r => r.textContent.includes('LICENSE')), name = long.querySelector('.name'), meta = long.querySelector('.meta');
    return { shown: getComputedStyle(meta).display !== 'none', truncated: name.scrollWidth > name.clientWidth, metaW: box(meta).width, plainW: box(plain.querySelector('.meta')).width,
      inRow: box(meta).right <= box(long).right + 0.01, text: plain.querySelector('.meta').textContent, tree: document.getElementById('tree').clientWidth,
      container: getComputedStyle(document.getElementById('tree')).containerType, subHidden: getComputedStyle(long.querySelector('.sub')).display === 'none' }; })()`);
  check('Mac 宽度够：meta 显示（大小），长名字被截断而 meta 不缩，meta 在行内；iPhone 的第二行隐藏', wide.shown && wide.truncated && wide.metaW > 0 && wide.metaW === wide.plainW && wide.inRow && wide.text === '2 B' && wide.container === 'inline-size' && wide.subHidden, JSON.stringify(wide));
  // 文件夹行：名字排序时右侧没有 meta 元素，名字可以占满；文字里没有 — 和 ·。
  const dirRow = await evaluate(`(() => { const row = document.querySelector('.row.dir'), name = row.querySelector('.name'), r = row.getBoundingClientRect(), n = name.getBoundingClientRect(), tail = row.querySelector('.tail');
    return { meta: row.querySelector('.meta'), sub: row.querySelector('.sub') !== null, text: row.textContent, gap: r.right - n.right, tailShown: getComputedStyle(tail).display !== 'none' }; })()`);
  check('Mac 文件夹行：右侧没有 meta，文字里没有 — 和 ·，名字右边只剩行内边距', dirRow.meta === null && !/[—·]/.test(dirRow.text) && dirRow.gap <= 12 && !dirRow.tailShown, JSON.stringify(dirRow));
  await open('narrow', 'mac', 'light');
  const narrow = await evaluate(`(() => ({ tree: document.getElementById('tree').clientWidth, shown: [...document.querySelectorAll('.meta')].filter(m => m.getClientRects().length > 0).length, total: document.querySelectorAll('.meta').length }))()`);
  check('Mac 窄于 220 点：meta 全部隐藏', narrow.tree < 220 && narrow.total > 0 && narrow.shown === 0, JSON.stringify(narrow));

  // 换排序：选「大小」后回到顶部、按新顺序（最大的文件在前）重画；选当前项什么都不做，不滚动。
  await open('mac', 'mac', 'light');
  await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = 300; p.dispatchEvent(new Event('scroll')); })()`);
  // 「什么都没发生」没有完成信号可等，所以不靠睡一会儿碰运气：选之后的同步效果（滚动、请求个数、顺序）立刻看；
  // 再做一个有明确完成信号的操作（刷新，等它发出请求并全部有了回答），确认这一整段里的变化都已落地之后，位置和顺序仍然没变。
  const stateNow = `({ scroll: document.getElementById('tree').scrollTop, order: ${fileOrder}, sent: window.__rpc.sent })`;
  const before = await evaluate(stateNow);
  await pick('名称');
  const afterPick = await evaluate(stateNow);
  await pick('刷新', 'mac', { done: `window.__rpc.sent > ${afterPick.sent}`, what: '刷新发出了请求' });
  const afterRefresh = await evaluate(stateNow);
  check('Mac：选当前排序项什么都不做，滚动位置不变', before.scroll === 300 && afterPick.scroll === 300 && afterPick.sent === before.sent && afterPick.order === before.order
    && afterRefresh.scroll === 300 && afterRefresh.order === before.order, JSON.stringify({ before, afterPick, afterRefresh }));
  await pickSort('大小');
  const bySize = await evaluate(`({ top: document.getElementById('tree').scrollTop, firstFile: document.querySelector('.row.file .name')?.textContent, firstDir: document.querySelector('.row.dir .name')?.textContent })`);
  // latest-notes 是指向 notes.txt 的链接，大小相同，平手按名字，所以它在前。
  check('Mac：选「大小」回到顶部，文件夹在前，最大的文件排在文件的最前', bySize.top === 0 && bySize.firstDir === 'assets' && bySize.firstFile === 'latest-notes', JSON.stringify(bySize));

  // 根目录名很长：iPhone 截断名字，⋯ 完整。
  await open('portrait', 'ios', 'light');
  const longName = await evaluate(`(() => { const b = document.getElementById('bar'), title = b.querySelector('.bar-title'); title.textContent = 'a-project-folder-with-an-extremely-long-name-that-cannot-fit-in-the-bar-at-all';
    const more = b.querySelector('[aria-label="更多"]').getBoundingClientRect(), tr = title.getBoundingClientRect();
    return { truncated: title.scrollWidth > title.clientWidth, moreW: more.width, moreInside: more.right <= innerWidth && more.left >= tr.right - 0.5, titleInside: tr.left >= 0 }; })()`);
  check('iPhone：根目录名长时截断名字，⋯ 完整', longName.truncated && longName.moreInside && longName.titleInside && longName.moreW >= 44, JSON.stringify(longName));
  // Mac 的标题行：根目录名很长时截断，不换行。
  await open('narrow', 'mac', 'light');
  const macTitle = await evaluate(`(() => { const sec = document.querySelector('.section'); sec.textContent = 'a-project-folder-with-an-extremely-long-name-that-cannot-fit-in-a-narrow-sidebar';
    return { truncated: sec.scrollWidth > sec.clientWidth, oneLine: sec.getBoundingClientRect().height < 40, inside: sec.getBoundingClientRect().right <= innerWidth }; })()`);
  check('Mac：标题行根目录名很长时截断，一行', macTitle.truncated && macTitle.oneLine && macTitle.inside, JSON.stringify(macTitle));

  // 行菜单：路径可以折行，不超出页面；大小 · 完整修改时间不折行。Mac 在窄侧栏里右键，iPhone 长按。
  const rowMenu = `(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(), path = m.querySelector('.menu-path'), info = m.querySelector('.menu-info'), line = parseFloat(getComputedStyle(info).lineHeight);
    return { shown: !m.hidden, path: path.textContent, pathLines: Math.round(path.getBoundingClientRect().height / parseFloat(getComputedStyle(path).lineHeight)), infoLines: Math.round(info.getBoundingClientRect().height / line),
      infoFits: info.scrollWidth <= info.clientWidth + 0.5, info: info.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, width: Math.round(r.width) }; })()`;
  await open('narrow', 'mac', 'light');
  await evaluate(`(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes('${LONG_NAME.slice(0, 12)}')); const b = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 10 })); })()`);
  const macRow = await evaluate(rowMenu);
  check('Mac 窄侧栏：行菜单路径折行，大小 · 完整修改时间不折行，菜单完整在页面内', macRow.shown && macRow.path === LONG_NAME && macRow.pathLines >= 2 && macRow.infoLines === 1 && macRow.infoFits
    && macRow.left >= 0 && macRow.right <= macRow.w && macRow.top >= 0 && macRow.bottom <= macRow.h, JSON.stringify(macRow));

  // Mac 预览头部：图标按钮 28 点，有 aria-label 和 title，元信息是 行数 · 大小。
  await open('mac', 'mac', 'light');
  // 先展开 src、把目录树滚到非零位置：返回之后这两样都要在。
  await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')).click()`);
  await until(`[...document.querySelectorAll('.row')].some(r => r.textContent.includes('app.js'))`, 'src 展开');
  const kept = await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = 40; p.dispatchEvent(new Event('scroll')); return p.scrollTop; })()`);
  await evaluate(`[...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')).click()`);
  await until(`document.querySelector('.text')`, 'Mac 预览出现');
  const mac = await evaluate(`(() => { const buttons = [...document.querySelectorAll('.phead button.icon:not([aria-label="返回"])')];
    return { labels: buttons.map(x => x.getAttribute('aria-label') + '/' + x.title), sizes: buttons.map(x => x.getBoundingClientRect().width), meta: document.querySelector('.pmeta').textContent,
      headIcon: document.querySelector('.pico svg') !== null, inside: buttons.every(x => x.getBoundingClientRect().right <= innerWidth) }; })()`);
  check('Mac：预览头部有文件图标、复制路径和窗口两个图标按钮（28 点，有 aria-label 和 title）', JSON.stringify(mac.labels) === JSON.stringify(['复制路径/复制路径', '窗口/窗口']) && mac.sizes.every(x => x === 28) && mac.headIcon && mac.inside, JSON.stringify(mac));
  check('Mac：元信息是 行数 · 大小', /^300 行 · \d/.test(mac.meta), mac.meta);

  // 预览头部最左边的返回：和其他图标按钮同样 28 点，点了回到目录树，滚动位置和展开状态不变。
  const back = await evaluate(`(() => { const head = document.querySelector('.phead'), b = head.firstElementChild, r = b.getBoundingClientRect(), o = head.querySelector('button.icon:not([aria-label="返回"])').getBoundingClientRect();
    return { label: b.getAttribute('aria-label') + '/' + b.title, icon: b.classList.contains('icon') && b.querySelector('svg') !== null, w: r.width, h: r.height, ow: o.width, oh: o.height, leftmost: r.left < head.querySelector('.pico').getBoundingClientRect().left && r.left >= 0 }; })()`);
  check('Mac：预览头部最左边是「返回」图标按钮，尺寸和其他图标按钮一致', back.label === '返回/返回' && back.icon && back.leftmost && back.w === back.ow && back.h === back.oh && back.w === 28, JSON.stringify(back));
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // 无头 Chrome 的页面默认没有焦点，document.hasFocus() 为假
  await evaluate(`(() => { const b = document.querySelector('.phead').firstElementChild; b.focus(); b.click(); })()`); // 键盘激活时焦点在按钮上
  await until(`!document.getElementById('preview').matches(':not(.off)') && !document.getElementById('tree').classList.contains('off')`, '回到目录树');
  check('Mac：点返回回到目录树，焦点在目录树', await evaluate(`document.querySelectorAll('.row.entry').length > 0 && document.activeElement === document.getElementById('tree')`));
  const after = await evaluate(`({ src: document.querySelector('.row.dir[aria-expanded="true"]')?.textContent, child: [...document.querySelectorAll('.row')].some(r => r.textContent.includes('app.js')), top: document.getElementById('tree').scrollTop })`);
  check('Mac：返回后展开的目录、它的子项和滚动位置都在', kept > 0 && after.src?.includes('src') && after.child && after.top === kept, `${JSON.stringify(after)}，滚动值 ${kept}`);

  // ---- 0.5.0：行菜单、属性页、选中文字的菜单 ----
  const menuInfo = `(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(), items = [...m.querySelectorAll('button')], last = items.at(-1)?.getBoundingClientRect();
    return { shown: !m.hidden, shape: [...m.children].map(x => x.tagName), names: items.map(x => x.textContent), heights: items.map(x => x.getBoundingClientRect().height),
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, scrolls: m.scrollHeight > m.clientHeight + 1, scrollTop: m.scrollTop, lastBottom: last?.bottom, lastTop: last?.top }; })()`;
  // 打开某一行的菜单：Mac 右键，iPhone 长按（等菜单出现）。
  const showRowMenu = async (platform, text) => {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    const at = `(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes(${JSON.stringify(text)})), r = row.getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2, row]; })()`;
    if (platform === 'ios') await evaluate(`(() => { const [x, y, row] = ${at}; row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, clientX: x, clientY: y })); })()`);
    else await evaluate(`(() => { const [x, y, row] = ${at}; row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })); })()`);
    await until(`!document.getElementById('menu').hidden`, `「${text}」的行菜单出现`);
  };
  const ROW_ITEMS = ['添加到聊天', '复制相对路径', '复制绝对路径', '属性'], ROW_SHAPE = ['BUTTON', 'BUTTON', 'BUTTON', 'HR', 'BUTTON'];
  for (const [size, platform, theme] of [['mac', 'mac', 'light'], ['mac', 'mac', 'dark'], ['portrait', 'ios', 'light'], ['landscape', 'ios', 'dark']]) {
    await open(size, platform, theme);
    const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
    await showRowMenu(platform, 'notes.txt');
    const file = await evaluate(menuInfo);
    const body = file.shape.slice(file.shape.indexOf('BUTTON'));
    check(`${platform} ${size} ${theme}：行菜单 添加到聊天、复制相对路径、复制绝对路径、分隔线、属性${platform === 'ios' ? '，项至少 44 点' : ''}，完整在安全区内`,
      JSON.stringify(file.names) === JSON.stringify(ROW_ITEMS) && JSON.stringify(body) === JSON.stringify(ROW_SHAPE) && (platform !== 'ios' || file.heights.every(x => x >= 44))
      && file.left >= sl && file.right <= file.w - sr && file.top >= 0 && file.bottom <= file.h, JSON.stringify(file));
    await showRowMenu(platform, 'dangling');
    const dead = await evaluate(menuInfo);
    check(`${platform} ${size} ${theme}：指向外面或失效的链接没有「添加到聊天」，有复制和属性`, JSON.stringify(dead.names) === JSON.stringify(ROW_ITEMS.slice(1)), JSON.stringify(dead));
    await showRowMenu(platform, 'latest-notes');
    check(`${platform} ${size} ${theme}：指向工作目录内的链接按目标显示，有「添加到聊天」`, JSON.stringify((await evaluate(menuInfo)).names) === JSON.stringify(ROW_ITEMS));
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  }

  // 右键添加：点「添加到聊天」，写进内存草稿，底部出现「已添加到输入框」（普通样式）；失败改复制（这里没有第二个会话可失败，用换会话后的过期代替不了，失败由单元测试覆盖）。
  await open('mac', 'mac', 'light');
  await showRowMenu('mac', 'notes.txt');
  await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '添加到聊天').click()`);
  await until(`!document.getElementById('hint').hidden`, '添加成功的提示');
  const added = await evaluate(`({ text: document.getElementById('hint').textContent, warn: document.getElementById('hint').classList.contains('warn'), adds: window.__rpc.adds, copies: window.__rpc.copies,
    color: getComputedStyle(document.getElementById('hint')).color, fg: getComputedStyle(document.documentElement).color, menu: document.getElementById('menu').hidden })`);
  check('Mac：添加到聊天成功：提示「已添加到输入框」、普通样式、不复制，发的是相对路径（接在后面）', added.text === '已添加到输入框' && !added.warn && added.color === added.fg && added.menu
    && JSON.stringify(added.adds) === JSON.stringify([{ text: 'notes.txt', block: false }]) && added.copies.length === 0, JSON.stringify(added));
  await shoot('mac-hint-added');

  // 长路径的行菜单：路径折很多行，菜单有高度上限，在菜单里滚动；iPhone 横屏滚到底，最后一项（属性）能点到。
  const expandDeep = async () => {
    for (const name of ['docs', LONG_DIR, LONG_SUB]) {
      const row = `[...document.querySelectorAll('.row.dir')].find(r => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
      await until(`${row} !== undefined`, `目录树里有 ${name}`); // 上一层的子项读回来才有这一行
      await evaluate(`${row}.click()`);
      await until(`${row}?.getAttribute('aria-expanded') === 'true'`, `展开 ${name}`);
    }
    await until(`[...document.querySelectorAll('.row')].some(r => r.textContent.includes(${JSON.stringify(DEEP_FILE)}))`, '最深的文件出现');
  };
  for (const [size, theme] of [['landscape', 'light'], ['portrait', 'dark']]) {
    await open(size, 'ios', theme);
    await expandDeep();
    await showRowMenu('ios', DEEP_FILE);
    const long = await evaluate(menuInfo);
    const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
    const safeBottom = size === 'landscape' ? 21 : 34;
    check(`iPhone ${size} ${theme}：长路径的行菜单完整在安全区内，高度有上限${size === 'landscape' ? '（内容放不下，在菜单里滚动）' : ''}`,
      long.left >= sl && long.right <= long.w - sr && long.top >= 0 && long.bottom <= long.h - safeBottom + 0.5 && (size !== 'landscape' || long.scrolls), JSON.stringify(long));
    // 滚到最底：最后一项完整在菜单里，点它的中心点就落在它上面，点下去是「属性」。
    const reach = await evaluate(`(() => { const m = document.getElementById('menu'); m.scrollTop = m.scrollHeight; const b = [...m.querySelectorAll('button')].at(-1), r = b.getBoundingClientRect(), mr = m.getBoundingClientRect(),
      hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { name: b.textContent, inMenu: r.top >= mr.top && r.bottom <= mr.bottom + 0.5, onScreen: r.bottom <= innerHeight - ${safeBottom} + 0.5, hit: hit?.closest('button') === b }; })()`);
    check(`iPhone ${size} ${theme}：长路径的行菜单滚到底能点到最后一项「属性」`, reach.name === '属性' && reach.inMenu && reach.onScreen && reach.hit, JSON.stringify(reach));
    await evaluate(`[...document.querySelectorAll('#menu button')].at(-1).click()`);
    await until(`!document.getElementById('info').classList.contains('off')`, '点最后一项后属性页出现');
    check(`iPhone ${size} ${theme}：点到的是「属性」：属性页打开，路径很长的完整路径折行不撑出页面`, await evaluate(`(() => { const p = document.getElementById('info'), b = p.querySelector('.pbody'); return b.scrollWidth <= b.clientWidth && getComputedStyle(document.getElementById('tree')).visibility === 'hidden'; })()`));
  }
  // 高度上限单测：视口只有 220 点高，⋯ 菜单放不下，在菜单里滚动，不超出安全区。
  await open('short', 'ios', 'light');
  await openMore('ios');
  const shortMenu = await evaluate(menuInfo);
  check('iPhone 视口只有 220 点高：⋯ 菜单有高度上限，内容放不下就在菜单里滚动，不超出安全区', shortMenu.scrolls && shortMenu.top >= 0 && shortMenu.bottom <= shortMenu.h - 21 + 0.5, JSON.stringify(shortMenu));

  // 属性页：两端两种外观。文件、文件夹（真实统计）、内链接、外链接；原生返回；没有 coda.back 时页内返回；横屏的返回先关属性页。
  const infoRows = `(() => Object.fromEntries([...document.querySelectorAll('#info .irow')].map(r => [r.children[0].textContent, r.children[1].textContent])))()`;
  const openInfo = async (platform, text, wait) => {
    await showRowMenu(platform, text);
    await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '属性').click()`);
    await until(wait, `${text} 的属性出现`);
  };
  const infoState = `(() => { const p = document.getElementById('info'), t = document.getElementById('tree'), b = p.querySelector('.pbody'), r = p.getBoundingClientRect();
    return { infoShown: getComputedStyle(p).visibility === 'visible', treeHidden: getComputedStyle(t).visibility === 'hidden', treeInert: t.inert, infoInert: p.inert, noOverflow: b.scrollWidth <= b.clientWidth,
      fits: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, name: p.querySelector('.pname')?.textContent, icon: p.querySelector('.pico svg') !== null, rows: Object.keys(${infoRows}) }; })()`;
  for (const [size, platform, theme] of [['mac', 'mac', 'light'], ['mac', 'mac', 'dark'], ['portrait', 'ios', 'light'], ['landscape', 'ios', 'dark']]) {
    await open(size, platform, theme);
    await openInfo(platform, 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
    const file = await evaluate(infoState), rows = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：文件的属性页盖住目录树（隐藏的面板 inert），内容、名字、图标都在，不撑出页面`, file.infoShown && file.treeHidden && file.treeInert && !file.infoInert && file.noOverflow && file.fits && file.name === 'notes.txt' && file.icon
      && rows.种类 === '文本' && /^\d+(\.\d)? KiB（[\d,]+ 字节）$/.test(rows.大小) && rows.位置 === '工作目录' && rows.完整路径.endsWith('/demo-project/notes.txt') && /^rw/.test(rows.权限), JSON.stringify({ file, rows }));
    check(`${platform} ${size} ${theme}：进入属性页声明了原生返回一层`, JSON.stringify(await evaluate(`window.__backs`)) === JSON.stringify([['资源管理器']]));
    await shoot(`${platform}-${size}-${theme}-info-file`);
    await evaluate(`postMessage({ harness: 'back' }, '*')`);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden' && getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '原生返回后回到目录树');
    check(`${platform} ${size} ${theme}：原生返回回到目录树，重新声明根层；目录树不重画行（行还在）`, JSON.stringify(await evaluate(`window.__backs`)) === JSON.stringify([['资源管理器'], []]) && await evaluate(`document.querySelectorAll('.row.entry').length > 0 && document.getElementById('info').inert`));

    await openInfo(platform, 'src', `(${infoRows}).大小 !== undefined && (${infoRows}).大小 !== '计算中…'`);
    const dir = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：文件夹的属性：种类、真实统计出的大小和项数`, dir.种类 === '文件夹' && dir.大小 === '6 B（3 项）', JSON.stringify(dir));
    await shoot(`${platform}-${size}-${theme}-info-dir`);
    await evaluate(`postMessage({ harness: 'back' }, '*')`);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden'`, '返回');
    await openInfo(platform, 'latest-notes', `(${infoRows}).链接到 !== undefined`);
    const inner = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：内链接按目标显示：种类带「链接」，有「链接到」`, inner.种类 === '文本（链接）' && inner.链接到 === 'notes.txt', JSON.stringify(inner));
    await evaluate(`postMessage({ harness: 'back' }, '*')`);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden'`, '返回');
    await openInfo(platform, 'dangling', `(${infoRows}).种类 !== undefined`);
    const outer = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：外链接和失效的链接只有自己的元数据：没有「链接到」和大小`, outer.种类 === '链接（指向工作目录外或已失效）' && !('链接到' in outer) && !('大小' in outer), JSON.stringify(outer));
    if (theme === 'light') await shoot(`${platform}-${size}-${theme}-info-link`);
    await evaluate(`postMessage({ harness: 'back' }, '*')`);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden'`, '返回');
  }
  // 没有 coda.back：头部放页内返回；iPhone 横屏：工具条的「返回」先关属性页。
  await open('mac', 'mac', 'light', { extra: '&back=0' });
  await openInfo('mac', 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
  check('Mac 没有 coda.back：属性页头部最左边有页内返回（28 点），没有声明', await evaluate(`(() => { const b = document.querySelector('#info .phead button'); const r = b?.getBoundingClientRect();
    return b?.getAttribute('aria-label') === '返回' && r.width === 28 && !window.__backs; })()`));
  await evaluate(`document.querySelector('#info .phead button').click()`);
  await until(`getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '页内返回后回到目录树');
  await open('landscape', 'ios', 'light');
  await openInfo('ios', 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
  check('iPhone 横屏：属性页里工具条的「返回」显示', await evaluate(`getComputedStyle(document.querySelector('#bar .exit')).display !== 'none'`));
  await evaluate(`document.querySelector('#bar .exit').click()`);
  await until(`getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '横屏返回关属性页');
  check('iPhone 横屏：「返回」在属性页里关属性页，没有离开视图，并重新声明根层', await evaluate(`location.pathname === '/view/index.html' && JSON.stringify(window.__backs) === '[["资源管理器"],[]]'`));

  // 选中文字的右键（Mac）：用真实的选区和 Range。三击选行（Chrome 的选区结尾落在下一行行首），拖选多行，从行号列拖进正文，裁剪后为空。
  await open('mac', 'mac', 'light');
  await evaluate(`[...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')).click()`);
  await until(`document.querySelector('.text')`, 'Mac 预览出现');
  const lineBox = line => `(() => { const el = document.querySelector('.text'), node = el.firstChild, at = node.data.indexOf('line ${line}\\n'), range = document.createRange();
    range.setStart(node, at + 2); range.setEnd(node, at + 3); const r = range.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const selectedAfter = async () => evaluate(`getSelection().toString()`);
  const { x, y } = await evaluate(lineBox(5));
  for (const clickCount of [1, 2, 3]) { await mouse('mousePressed', x, y, { clickCount, buttons: 1 }); await mouse('mouseReleased', x, y, { clickCount }); }
  const triple = await selectedAfter();
  check('三击选行：真实选区是「line 5」（可能带换行）', triple === 'line 5' || triple === 'line 5\n', JSON.stringify(triple));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  const via = await evaluate(`!document.getElementById('menu').hidden`);
  if (!via) { await evaluate(`document.querySelector('.text').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))`); }
  const selMenu = await evaluate(menuInfo);
  check(`三击选行后右键（${via ? '真实右键' : '合成 contextmenu 事件，无头 Chrome 没有触发'}）：三项菜单，没有路径标题`, JSON.stringify(selMenu.names) === JSON.stringify(['添加到聊天（内容）', '添加到聊天（位置）', '复制']) && await evaluate(`document.querySelector('#menu .menu-path') === null`), JSON.stringify(selMenu));
  await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '添加到聊天（位置）').click()`);
  await until(`window.__rpc.adds.length === 1`, '位置发出');
  check('三击选行：位置是 notes.txt:5（不是 5-6），block 为 false', JSON.stringify(await evaluate(`window.__rpc.adds`)) === JSON.stringify([{ text: 'notes.txt:5', block: false }]));
  // 程序里造的选区：偏移从 .text 的文字开头数起；from 为负数时起点在行号列里。
  const select = (from, to) => evaluate(`(() => { const el = document.querySelector('.text'), node = el.firstChild, gutter = document.querySelector('.gutter').firstChild, base = ${from} < 0 ? [gutter, 0] : [node, ${from}];
    getSelection().setBaseAndExtent(base[0], base[1], node, ${to}); return getSelection().toString().length; })()`);
  const choosePosition = async label => {
    await evaluate(`document.querySelector('.text').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }))`);
    const shown = await evaluate(`!document.getElementById('menu').hidden`);
    if (shown) await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === ${JSON.stringify(label)}).click()`);
    return shown;
  };
  const added1 = async () => (await evaluate(`window.__rpc.adds`)).at(-1);
  // line 1\nline 2\n...：偏移 7 是第二行行首；line N 的行首是 (N-1)*7（前 9 行每行 7 个字符）。
  await select(7 + 2, 7 + 5); await choosePosition('添加到聊天（位置）'); await until(`window.__rpc.adds.length === 2`, '单行');
  check('选区行号：同一行里选几个字是 notes.txt:2', (await added1()).text === 'notes.txt:2');
  await select(7 + 2, 14 + 5); await choosePosition('添加到聊天（位置）'); await until(`window.__rpc.adds.length === 3`, '多行');
  check('选区行号：跨两行（2-3）', (await added1()).text === 'notes.txt:2-3');
  await select(7, 14); await choosePosition('添加到聊天（内容）'); await until(`window.__rpc.adds.length === 4`, '整行含换行');
  check('选区行号：整行带换行（结尾在下一行行首）不算下一行；内容类的文字原样（以换行结尾）', JSON.stringify(await added1()) === JSON.stringify({ text: 'line 2\n', block: true }));
  await select(-1, 12); await choosePosition('添加到聊天（内容）'); await until(`window.__rpc.adds.length === 5`, '从行号列拖进来');
  check('从行号列拖进正文：裁掉行号列，内容从正文开头起', (await added1()).text === 'line 1\nline 2'.slice(0, 12) || (await added1()).text.startsWith('line 1\nline'), JSON.stringify(await added1()));
  // 裁剪后为空：选区只在行号列里，或擦着正文的开头——不接管，走系统默认（菜单不出现）。
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await evaluate(`(() => { const gutter = document.querySelector('.gutter').firstChild; getSelection().setBaseAndExtent(gutter, 0, gutter, 3); })()`);
  check('选区只在行号列：不接管（没有自己的菜单）', !(await choosePosition('添加到聊天（位置）')) && await evaluate(`document.getElementById('menu').hidden`));
  await evaluate(`getSelection().removeAllRanges()`);
  check('没有选区：不接管', !(await choosePosition('添加到聊天（位置）')));
  await shoot('mac-selection-menu');

  // ---- 截图 ----
  const picked = { v: 1, seq: 1, hidden: false, sessions: { A: { at: 1, expanded: [], selected: 'notes.txt', scroll: { tree: 0, top: 0, left: 0 } } } }; // iPhone 上刚打开过 notes.txt，回到树页时它是选中行
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    for (const name of ['src', 'locked']) await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('${name}')).click()`);
    await shoot(`mac-sidebar-${theme}`);
    await evaluate(`[...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')).click()`);
    await until(`document.querySelector('.text')`, 'Mac 预览出现');
    await shoot(`mac-preview-${theme}`);
    // 按日期、按大小排序，⋯ 菜单打开的样子（Mac）。
    await open('mac', 'mac', theme);
    await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')).click()`);
    await pickSort('日期');
    await shoot(`mac-sidebar-date-${theme}`);
    await pickSort('大小');
    await shoot(`mac-sidebar-size-${theme}`);
    await openMore('mac');
    await shoot(`mac-sidebar-size-${theme}-menu`);
    for (const size of ['portrait', 'landscape']) {
      await open(size, 'ios', theme, { state: picked });
      await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')).click()`);
      await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('locked')).click()`);
      await shoot(`ios-${size}-${theme}`);
      await evaluate(`document.querySelector('[aria-label="更多"]').click()`);
      await shoot(`ios-${size}-${theme}-menu`);
      // 长按一行：菜单里路径下面有 大小 · 完整修改时间。
      await evaluate(`document.getElementById('menu').hidden = true`);
      await evaluate(`(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes('LICENSE')), r = row.getBoundingClientRect();
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, clientX: r.left + 80, clientY: r.top + 20 })); })()`);
      await until(`!document.getElementById('menu').hidden`, '长按后行菜单出现');
      const held = await evaluate(`(() => { const m = document.getElementById('menu').getBoundingClientRect(); return { shown: !document.getElementById('menu').hidden, path: document.querySelector('.menu-path')?.textContent, info: document.querySelector('.menu-info')?.textContent,
          inside: m.left >= 0 && m.right <= innerWidth && m.top >= 0 && m.bottom <= innerHeight }; })()`);
      check(`iPhone ${size} ${theme}：长按菜单有信息行，完整在页面内`, held.shown && held.path === 'LICENSE' && /^2 B · 2025-03-04 10:00:00$/.test(held.info) && held.inside, JSON.stringify(held));
      await shoot(`ios-${size}-${theme}-longpress`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      // 长名字：路径折行，大小 · 完整修改时间不折行，菜单不超出页面。
      await evaluate(`(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes('${LONG_NAME.slice(0, 12)}')), r = row.getBoundingClientRect();
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, clientX: r.left + 80, clientY: r.top + 20 })); })()`);
      await until(`!document.getElementById('menu').hidden`, '长按长名字后行菜单出现');
      const longRow = await evaluate(rowMenu);
      const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
      check(`iPhone ${size} ${theme}：长名字的行菜单路径折行，大小 · 完整修改时间不折行，完整在安全区内`, longRow.shown && longRow.path === LONG_NAME && longRow.pathLines >= 2 && longRow.infoLines === 1 && longRow.infoFits
        && longRow.left >= sl && longRow.right <= longRow.w - sr && longRow.top >= 0 && longRow.bottom <= longRow.h, JSON.stringify(longRow));
      await shoot(`ios-${size}-${theme}-longpress-long`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await pickSort('日期', 'ios');
      await shoot(`ios-${size}-${theme}-date`);
      await openFile(size, theme);
      await shoot(`ios-${size}-${theme}-file`);
    }
  }
  exitCode = failures.length ? 1 : 0;
  keepShots = true;
  console.log(`截图：${shots}`);
  console.log(failures.length ? `失败 ${failures.length} 项` : '全部通过');
} catch (error) {
  console.error(`错误：${error.message}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
