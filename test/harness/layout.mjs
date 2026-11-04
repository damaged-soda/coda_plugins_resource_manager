// 开发用：无头 Chrome（不是 WKWebView）经 CDP 断言假 DOM 查不出的真实布局，并给 Mac 侧栏、iPhone 竖屏和横屏的深浅色截图。不是产品代码。
// 自己起 harness 服务和临时目录（用完删掉），截图放在系统临时目录里，不进仓库。
// 用法：node test/harness/layout.mjs [Chrome 的路径]；失败时退出码非 0。
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const chromePath = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = await mkdtemp(join(tmpdir(), 'rm-ui-'));
const fixture = join(base, 'demo-project'), profile = join(base, 'profile'), shots = join(base, 'shots');
const FILLER = 120; // 根目录里排在最后的一批文件，撑出第二页以后的内容

// ---- 假工作目录 ----
await mkdir(shots, { recursive: true });
for (const dir of ['src', 'docs', 'assets', 'locked']) await mkdir(join(fixture, dir), { recursive: true });
const touch = (path, text = 'x\n') => writeFile(join(fixture, path), text);
await Promise.all([
  touch('src/app.js'), touch('src/util.mjs'), touch('src/style.css'), touch('docs/README.md'), touch('docs/guide.txt'), touch('assets/logo.png'),
  touch('LICENSE'), touch('package.json', '{}\n'), touch('notes.txt'),
  ...Array.from({ length: FILLER }, (_, i) => touch(`zz-${String(i).padStart(3, '0')}.txt`)),
]);
await symlink('notes.txt', join(fixture, 'latest-notes'));
await symlink('/nonexistent-target', join(fixture, 'dangling'));
await chmod(join(fixture, 'locked'), 0);
const ROOT_ROWS = 4 + 3 + 2 + FILLER; // 四个目录、三个文件、两个链接、填充

const children = [];
const cleanup = async () => {
  for (const child of children) child.kill();
  await chmod(join(fixture, 'locked'), 0o755).catch(() => {});
  await rm(fixture, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
};

const server = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), fixture, fixture, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
children.push(server);
const serverUrl = await new Promise(resolve => server.stdout.on('data', data => { const m = /http:\/\/\S+/.exec(String(data)); if (m) resolve(m[0]); }));

const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
children.push(chrome);
const wait = ms => new Promise(r => setTimeout(r, ms));
let list;
for (let i = 0; i < 50 && !list; i++) { try { list = await (await fetch('http://127.0.0.1:9334/json')).json(); } catch { await wait(200); } }
const ws = new WebSocket(list.find(x => x.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const waiting = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const until = async (expr, what) => { for (let i = 0; i < 50; i++) { if (await evaluate(expr)) return; await wait(100); } throw new Error(`等不到：${what}`); };

const SIZES = { mac: [280, 700, '0,0,0,0'], portrait: [420, 790, '0,0,34,0'], landscape: [844, 390, '0,59,21,59'] };
async function open(size, platform, theme, { keep = false } = {}) {
  const [w, h, safe] = SIZES[size];
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: platform === 'ios' });
  const url = `${serverUrl}view/index.html?platform=${platform}&theme=${theme}&safe=${safe}&t=${Date.now()}`;
  if (!keep) { await send('Page.navigate', { url: `${serverUrl}view/index.html` }); await wait(300); await evaluate('coda.setState = () => {}; sessionStorage.clear()'); } // 空白页离开时的 pagehide 不能再把状态存回去
  await send('Page.navigate', { url });
  await until(`document.querySelectorAll('.row.entry').length > 0`, '目录树出现');
}
const shoot = async name => { await wait(300); await writeFile(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };

const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`); if (!ok) failures.push(name); };

// 视口里每隔一段取一个点：每一点都该落在某一行上（空白说明虚拟滚动画少了）。
const covered = `(() => { const pane = document.getElementById('tree'), r = pane.getBoundingClientRect(), miss = [];
  for (let y = r.top + 4; y < r.bottom - 4; y += 8) { const e = document.elementFromPoint(r.left + r.width / 2, y); if (!e?.closest('.row')) miss.push(Math.round(y)); }
  return miss; })()`;

try {
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
  await open('mac', 'mac', 'light');
  await rowCheck('Mac 浅色');
  await evaluate(`document.documentElement.style.setProperty('--coda-font-size', '20px'); postMessage({ harness: 'theme', kind: 'dark' }, '*')`);
  await wait(300);
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

  // ---- 截图 ----
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    for (const name of ['src', 'locked']) await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('${name}')).click()`);
    await shoot(`mac-sidebar-${theme}`);
    for (const size of ['portrait', 'landscape']) {
      await open(size, 'ios', theme);
      await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')).click()`);
      await evaluate(`[...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('locked')).click()`);
      await shoot(`ios-${size}-${theme}`);
    }
  }
} finally {
  ws.close();
  await cleanup();
}
console.log(`截图：${shots}`);
console.log(failures.length ? `失败 ${failures.length} 项` : '全部通过');
process.exit(failures.length ? 1 : 0);
