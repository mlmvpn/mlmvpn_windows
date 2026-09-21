#!/usr/bin/env node
/*
 * Full-size screenshots of the UI preview (.claude/ui-preview.js) through headless Edge
 * and the DevTools protocol.
 *
 * The in-app Browser pane is far too small to judge a 1440×900 desktop, and
 * node_modules/electron has no binary, so this drives Windows' own Chromium. Nothing is
 * downloaded; the throwaway browser profile lives in the OS temp folder.
 *
 *   node .claude/ui-shot.js <out.png> [width] [height] [js-to-run-before-capture] [--light]
 *
 * The startup system check is dismissed the way a user would (skip, then enter) before
 * the optional JS runs. Page exceptions and console.error lines are printed.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [out = 'shot.png', W = '1440', H = '900', js = ''] = args;
const scheme = process.argv.includes('--light') ? 'light' : 'dark';
const url = process.env.SHOT_URL || 'http://127.0.0.1:35299/';
const PORT = 9333 + Math.floor(Math.random() * 400);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.join(os.tmpdir(), 'mlmvpn-ui-shot-profile');

const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'],
  { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = '';
    r.on('data', (d) => (b += d));
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej));
}

(async () => {
  let list = [];
  for (let i = 0; i < 40; i++) {
    try { list = await getJSON('/json/list'); if (list.length) break; } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log('[exception]', (d.exception && d.exception.description) || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      console.log('[console.error]', msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : r;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await send('Page.navigate', { url });
  // SHOT_EARLY_MS=n: photograph the page n ms after navigation (the boot screen) and stop.
  if (process.env.SHOT_EARLY_MS) {
    await sleep(+process.env.SHOT_EARLY_MS);
    const early = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(early.result.data, 'base64'));
    console.log('saved', out);
    ws.close(); edge.kill(); process.exit(0);
  }
  await sleep(3000);

  // SHOT_KEEP_BOOT=1 photographs the startup check itself instead of dismissing it.
  for (let i = 0; i < 40 && !process.env.SHOT_KEEP_BOOT; i++) {
    const gone = await evalJs(`(function(){var o=document.getElementById('sc-overlay');
      if(!o||!o.isConnected||getComputedStyle(o).display==='none') return true;
      var bs=[...o.querySelectorAll('button')];
      var b=bs.find(function(x){return /ورود/.test(x.textContent)&&!x.disabled})||bs.find(function(x){return /رد کردن/.test(x.textContent)&&!x.disabled});
      if(b) b.click(); return false})()`);
    if (gone) break;
    await sleep(400);
  }
  await sleep(700);

  // `@steps.json` instead of JS: one browser session, many shots —
  // [{ "out": "a.png", "js": "...", "wait": 900 }, …]; `out` may be omitted for a setup step.
  if (js.startsWith('@')) {
    const steps = JSON.parse(fs.readFileSync(js.slice(1), 'utf8'));
    for (const s of steps) {
      if (s.js) console.log('[js]', s.out || '-', JSON.stringify(await evalJs(s.js)));
      await sleep(s.wait == null ? 900 : s.wait);
      if (s.out) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(s.out, Buffer.from(shot.result.data, 'base64'));
        console.log('saved', s.out);
      }
    }
  } else {
    if (js) { console.log('[js]', JSON.stringify(await evalJs(js))); await sleep(900); }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('saved', out);
  }
  ws.close();
  edge.kill();
  process.exit(0);
})().catch((e) => { console.error(e); edge.kill(); process.exit(1); });
