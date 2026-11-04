// 开发用：无头 Chrome（不是 WKWebView）经 CDP 断言假 DOM 查不出的真实布局，并给 Mac 侧栏和预览、iPhone 竖屏和横屏的深浅色截图。不是产品代码。
// 自己起 harness 服务和临时目录（用完删掉），截图放在系统临时目录里，不进仓库。
// 用法：node test/harness/layout.mjs [Chrome 的路径]；失败时退出码非 0。
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const chromePath = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9334, STARTUP_MS = 60000;
const FILLER = 120; // 根目录里排在最后的一批文件，撑出第二页以后的内容
const LONG_LINES = 300; // notes.txt 的行数：文件页要滚得动，才能看最后一行是否被底部工具条挡住
const ROOT_ROWS = 4 + 3 + 2 + FILLER; // 四个目录、三个文件、两个链接、填充
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
const until = async (expr, what) => { for (let i = 0; i < 50; i++) { if (await evaluate(expr)) return; await wait(100); } throw new Error(`等不到：${what}`); };

async function start() {
  // ---- 假工作目录 ----
  await mkdir(shots, { recursive: true });
  for (const dir of ['src', 'docs', 'assets', 'locked']) await mkdir(join(fixture, dir), { recursive: true });
  const touch = (path, text = 'x\n') => writeFile(join(fixture, path), text);
  await Promise.all([
    touch('src/app.js'), touch('src/util.mjs'), touch('src/style.css'), touch('docs/README.md'), touch('docs/guide.txt'), touch('assets/logo.png'),
    touch('LICENSE'), touch('package.json', '{}\n'), touch('notes.txt', Array.from({ length: LONG_LINES }, (_, i) => `line ${i + 1}`).join('\n') + '\n'),
    ...Array.from({ length: FILLER }, (_, i) => touch(`zz-${String(i).padStart(3, '0')}.txt`)),
  ]);
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

const SIZES = { mac: [280, 700, '0,0,0,0'], portrait: [420, 790, '0,0,34,0'], landscape: [844, 390, '0,59,21,59'] };
// state：载入前写进页面的保存状态（假装上次退出时的样子，例如选中的文件）。
async function open(size, platform, theme, { keep = false, state = null } = {}) {
  const [w, h, safe] = SIZES[size];
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: platform === 'ios' });
  const url = `${serverUrl}view/index.html?platform=${platform}&theme=${theme}&safe=${safe}&t=${Date.now()}`;
  if (!keep) { await send('Page.navigate', { url: `${serverUrl}view/index.html` }); await wait(300); await evaluate('coda.setState = () => {}; sessionStorage.clear()'); }
  if (state) await evaluate(`sessionStorage.setItem('harness-state:files', ${JSON.stringify(JSON.stringify(state))})`); // 空白页离开时的 pagehide 不能再把状态存回去
  await send('Page.navigate', { url });
  await until(`document.querySelectorAll('.row.entry').length > 0`, '目录树出现');
}
// 文件页：query 是额外的参数；等正文或说明区出现。
async function openFile(size, theme, query = 'session=A&path=notes.txt') {
  const [w, h, safe] = SIZES[size];
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${serverUrl}view/file.html?platform=ios&theme=${theme}&safe=${safe}&${query}&t=${Date.now()}` });
  await until(`document.querySelector('.text') || document.querySelector('#notice:not(.off) p')`, '文件页出现');
}
const shoot = async name => { await wait(300); await writeFile(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };

const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`); if (!ok) failures.push(name); };

// 视口里每隔一段取一个点：每一点都该落在某一行上（空白说明虚拟滚动画少了）。
const covered = `(() => { const pane = document.getElementById('tree'), r = pane.getBoundingClientRect(), miss = [];
  for (let y = r.top + 4; y < r.bottom - 4; y += 8) { const e = document.elementFromPoint(r.left + r.width / 2, y); if (!e?.closest('.row')) miss.push(Math.round(y)); }
  return miss; })()`;

let exitCode = 1;
try {
  await start();
  // ---- 断言 ----
  // 有标题（Mac）时：滚到第二页深处，状态存下来，重新载入后恢复到同一个位置，视口里没有空白。
  await open('mac', 'mac', 'light');
  check('Mac：有分区标题', await evaluate(`document.querySelector('.section')?.textContent === 'demo-project' && document.querySelector('.section').getClientRects().length > 0`));
  const target = await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = p.clientHeight * 1.5 + 13; p.dispatchEvent(new Event('scroll')); return p.scrollTop; })()`);
  await wait(700); // 保存的定时器 300 毫秒
  await open('mac', 'mac', 'light', { keep: true });
  await until(`document.getElementById('tree').scrollTop > 0`, '恢复滚动位置');
  await wait(300);
  check('Mac：有标题时恢复到第二页深处', (await evaluate(`document.getElementById('tree').scrollTop`)) === target, `存了 ${target}`);
  check('Mac：恢复后视口里每一点都有行', (await evaluate(covered)).length === 0, JSON.stringify(await evaluate(covered)));

  // 标题把列表推下去 offsetTop：画出的第一行就是 floor((滚动值 − offsetTop) / 行高) − 预渲染的 8 行，位置也对得上。
  const geometry = await evaluate(`(() => { const p = document.getElementById('tree'), sp = document.querySelector('.spacer'), sec = document.querySelector('.section'),
    rows = [...document.querySelectorAll('.row')], rowH = parseFloat(sp.style.height) / ${ROOT_ROWS}, i0 = Number(rows[0].dataset.i);
    return { offset: sp.offsetTop, title: sec.offsetHeight, first: i0, expected: Math.max(0, Math.floor((p.scrollTop - sp.offsetTop) / rowH) - 8),
      placed: rows.every(r => Math.abs(r.getBoundingClientRect().top - sp.getBoundingClientRect().top - Number(r.dataset.i) * rowH) < 0.01) }; })()`);
  check('Mac：spacer 的 offsetTop 就是标题高度', geometry.offset === geometry.title && geometry.title > 0, JSON.stringify(geometry));
  check('Mac：有标题时画出的第一行按扣掉标题的滚动值算，位置对得上', geometry.first === geometry.expected && geometry.placed, JSON.stringify(geometry));

  // 主题或字号变了之后探针重新量：spacer 的高度 = 行数 × 实际行高。
  const rowCheck = async label => {
    const { actual, per } = await evaluate(`(() => { const row = document.querySelector('.row.entry').getBoundingClientRect().height;
      return { actual: row, per: parseFloat(document.querySelector('.spacer').style.height) / ${ROOT_ROWS} }; })()`);
    check(`${label}：探针量到的行高等于实际行高`, Math.abs(actual - per) < 0.01, `实际 ${actual}，探针 ${per}`);
  };
  const rowHeight = () => evaluate(`document.querySelector('.row.entry').getBoundingClientRect().height`);
  await open('mac', 'mac', 'light');
  await rowCheck('Mac 浅色');
  check('Mac：13px 时实际行高 26', (await rowHeight()) === 26, String(await rowHeight()));
  await evaluate(`postMessage({ harness: 'theme', kind: 'dark', fontSize: '20px' }, '*')`);
  await wait(300);
  check('Mac：字号改 20px 后实际行高 40（字号真的生效了）', (await rowHeight()) === 40, String(await rowHeight()));
  await rowCheck('Mac 换深色并改字号后');
  await open('portrait', 'ios', 'light');
  await rowCheck('iPhone 竖屏');
  check('iPhone：行高 44', (await evaluate(`document.querySelector('.row.entry').getBoundingClientRect().height`)) === 44);
  check('iPhone：不显示分区标题', await evaluate(`getComputedStyle(document.querySelector('.section')).display === 'none'`));
  await evaluate(`postMessage({ harness: 'theme', kind: 'dark' }, '*')`);
  await wait(300);
  await rowCheck('iPhone 换深色后');

  // 卡片末行：滚到底，最后一行完整在卡片里，卡片没有裁掉内容。
  for (const size of ['portrait', 'landscape']) {
    await open(size, 'ios', 'light');
    const end = await evaluate(`(async () => { const p = document.getElementById('tree'); p.scrollTop = p.scrollHeight; p.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('.row')], last = rows.at(-1).getBoundingClientRect(), card = document.querySelector('.spacer'), c = card.getBoundingClientRect(), pane = p.getBoundingClientRect();
      return { lastText: rows.at(-1).textContent, lastH: last.height, inCard: last.bottom <= c.bottom + 0.01, cardFits: card.scrollHeight <= card.clientHeight, inPane: last.bottom <= pane.bottom + 0.01, cardBottom: c.bottom, paneBottom: pane.bottom }; })()`);
    check(`iPhone ${size}：卡片末行完整可见`, end.lastText.includes('zz-119') && end.lastH === 44 && end.inCard && end.cardFits && end.inPane, JSON.stringify(end));
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
    const end = await evaluate(`(async () => { const body = document.querySelector('.pbody'); body.scrollTop = body.scrollHeight; await new Promise(r => setTimeout(r, 100));
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

  // iPhone 树页顶部：返回（仅横屏）、根目录名、⋯；⋯ 打开的菜单完整在安全区内，项至少 44 点，再次激活只关闭。
  for (const size of ['portrait', 'landscape']) {
    await open(size, 'ios', 'light');
    const top = await evaluate(`(() => { const b = document.getElementById('bar'), more = b.querySelector('[aria-label="更多"]'), r = more.getBoundingClientRect(), exit = b.querySelector('.exit');
      return { title: b.querySelector('.bar-title').textContent, w: r.width, h: r.height, inside: r.right <= innerWidth - ${size === 'landscape' ? 59 : 0},
        exitShown: exit.getClientRects().length > 0 }; })()`);
    check(`iPhone ${size}：顶部工具条有根目录名和 44 点的 ⋯，返回${size === 'landscape' ? '显示' : '隐藏'}`,
      top.title === 'demo-project' && top.w >= 44 && top.h >= 44 && top.inside && top.exitShown === (size === 'landscape'), JSON.stringify(top));
    await evaluate(`document.querySelector('[aria-label="更多"]').click()`);
    const menu = await evaluate(`(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(), items = [...m.querySelectorAll('button')];
      return { shown: !m.hidden, names: items.map(x => x.textContent), roles: items.map(x => x.getAttribute('role')), heights: items.map(x => x.getBoundingClientRect().height),
        left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, expanded: document.querySelector('[aria-label="更多"]').getAttribute('aria-expanded') }; })()`);
    const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
    check(`iPhone ${size}：⋯ 菜单两项，项至少 44 点，完整在安全区内`, menu.shown && JSON.stringify(menu.names) === JSON.stringify(['刷新', '显示隐藏文件']) && menu.heights.every(x => x >= 44)
      && menu.left >= sl && menu.right <= menu.w - sr && menu.top >= 0 && menu.bottom <= menu.h && menu.expanded === 'true', JSON.stringify(menu));
    await evaluate(`document.querySelector('[aria-label="更多"]').click()`); // 没有 pointerdown 的再次激活，同键盘
    check(`iPhone ${size}：再次激活 ⋯ 只关闭`, await evaluate(`document.getElementById('menu').hidden && document.querySelector('[aria-label="更多"]').getAttribute('aria-expanded') === 'false'`));
    await evaluate(`document.querySelector('[aria-label="更多"]').click(); [...document.querySelectorAll('#menu button')].find(x => x.textContent === '显示隐藏文件').click()`);
    check(`iPhone ${size}：选「显示隐藏文件」后菜单关闭，再打开时对勾在`, await evaluate(`(() => { const closed = document.getElementById('menu').hidden; document.querySelector('[aria-label="更多"]').click();
      const item = [...document.querySelectorAll('#menu button')].find(x => x.textContent === '显示隐藏文件'); return closed && item.getAttribute('aria-checked') === 'true' && item.querySelector('svg') !== null; })()`));
  }

  // Mac 预览头部：图标按钮 28 点，有 aria-label 和 title，元信息是 行数 · 大小。
  await open('mac', 'mac', 'light');
  await evaluate(`[...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')).click()`);
  await until(`document.querySelector('.text')`, 'Mac 预览出现');
  const mac = await evaluate(`(() => { const buttons = [...document.querySelectorAll('.phead button.icon')];
    return { labels: buttons.map(x => x.getAttribute('aria-label') + '/' + x.title), sizes: buttons.map(x => x.getBoundingClientRect().width), meta: document.querySelector('.pmeta').textContent,
      headIcon: document.querySelector('.pico svg') !== null, inside: buttons.every(x => x.getBoundingClientRect().right <= innerWidth) }; })()`);
  check('Mac：预览头部有文件图标、复制路径和窗口两个图标按钮（28 点，有 aria-label 和 title）', JSON.stringify(mac.labels) === JSON.stringify(['复制路径/复制路径', '窗口/窗口']) && mac.sizes.every(x => x === 28) && mac.headIcon && mac.inside, JSON.stringify(mac));
  check('Mac：元信息是 行数 · 大小', /^300 行 · \d/.test(mac.meta), mac.meta);

  // ---- 截图 ----
  const picked = { v: 1, seq: 1, hidden: false, sessions: { A: { at: 1, expanded: [], selected: 'notes.txt', scroll: { tree: 0, top: 0, left: 0 } } } }; // iPhone 上刚打开过 notes.txt，回到树页时它是选中行
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    for (const name of ['src', 'locked']) await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('${name}')).click()`);
    await shoot(`mac-sidebar-${theme}`);
    await evaluate(`[...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')).click()`);
    await until(`document.querySelector('.text')`, 'Mac 预览出现');
    await shoot(`mac-preview-${theme}`);
    for (const size of ['portrait', 'landscape']) {
      await open(size, 'ios', theme, { state: picked });
      await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')).click()`);
      await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('locked')).click()`);
      await shoot(`ios-${size}-${theme}`);
      await evaluate(`document.querySelector('[aria-label="更多"]').click()`);
      await shoot(`ios-${size}-${theme}-menu`);
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
