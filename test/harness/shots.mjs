// 开发用：无头 Chrome（不是 WKWebView）经 CDP 给 harness 的页面截图并量行高、按钮尺寸，不是产品代码。
// 先起 harness：node test/harness/server.mjs <目录> <目录> 18765；目录里要有 src/app.js、docs/、file-1.txt…、一个很长的文件名（含 "very-long"）。
// 用法：node test/harness/shots.mjs http://127.0.0.1:18765 <输出目录> <Chrome 的临时 profile 目录>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const [serverUrl, outDir, chromeDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${chromeDir}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let list;
for (let i = 0; i < 50; i++) { try { list = await (await fetch('http://127.0.0.1:9333/json')).json(); break; } catch { await wait(200); } }
const ws = new WebSocket(list.find(x => x.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const waiting = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const sizes = { portrait: [420, 790, '0,0,34,0'], landscape: [844, 390, '0,59,21,59'] };
const report = [];
async function shoot(name, path, [w, h, safe], theme, steps = '', platform = 'ios') {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${serverUrl}${path}${path.includes('?') ? '&' : '?'}platform=${platform}&theme=${theme}&safe=${safe}&t=${Date.now()}` });
  await wait(1200);
  if (steps) { await evaluate(steps); await wait(700); }
  const data = await evaluate(`(() => { const q = s => [...document.querySelectorAll(s)];
    const vis = e => e.getClientRects().length > 0; const box = e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    return { rowH: q('.row').slice(0, 1).map(box), buttons: q('.bar button, .phead button').filter(vis).map(b => b.textContent + ':' + box(b).join('x')),
      exitShown: q('.exit').some(vis), draggable: q('.row').filter(r => r.draggable).length, scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
      pheadH: q('.phead').slice(0,1).map(box), pname: q('.pname').map(e => e.textContent) }; })()`);
  report.push({ name, ...data });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${outDir}/${name}.png`, Buffer.from(shot.result.data, 'base64'));
}
const expand = `document.querySelector('.row.dir').click();`;
for (const theme of ['light', 'dark']) for (const [orient, size] of Object.entries(sizes)) {
  await shoot(`tree-${orient}-${theme}`, '/view/index.html', size, theme, expand);
  await shoot(`file-${orient}-${theme}`, '/view/file.html?session=A&path=src/app.js', size, theme);
}
await shoot('mac-preview-320-light', '/view/index.html', [320, 600, '0,0,0,0'], 'light', `[...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('file-1.txt')).click();`, 'mac');
await shoot('mac-preview-320-longname', '/view/index.html', [320, 600, '0,0,0,0'], 'dark', `[...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('very-long')).click();`, 'mac');
// iPhone 点文件：整页跳到文件页，再用 history.back 回来（harness 的 coda.open / coda.close）
await shoot('flow-tap-file-portrait', '/view/index.html', sizes.portrait, 'light', `document.querySelector('.row.file').click();`);
await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 1));
ws.close(); chrome.kill();
process.exit(0);
