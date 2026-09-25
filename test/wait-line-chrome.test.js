// ════════════════════════════════════════════════════════════════════════════
// THE THINKING SCREEN TELLS THE TRUTH ABOUT THE WAIT, AND KEEPS TALKING
// (2026-09-29, recommendation 3).
//
// B1 (2026-09-28): the eight messages ran out at about 14 s and the bar stopped
// at 88 percent, then nothing changed for about 20 s at the median and 54 s at
// the slowest. The screen promised nothing and said nothing.
//
// Now, under the bar:
//   at once        "This usually takes about 35 seconds." (the measured median,
//                  33.5 s over the last 28 runs; rvp-wait-measure.mjs)
//   every 20 s     "Still working: 20 seconds so far." and so on, until the
//                  report arrives
// In real Chrome, on the REAL survey page served by the REAL app: the request is
// held open (window.fetch never answers), the tick is shortened to 150 ms by
// window.RVP_STILL_WORKING_MS, and the line is read as it changes, at Letter, A4
// and 390 px. A FAILING CONTROL hides the line and requires the check to say so.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

process.env.PORT = '39499';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const { app } = __test__;

const CHROME = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CDP_PORT = 9395, SRV_PORT = 8845;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const READ = `(function(){ var el = document.getElementById('tw'), d = document.documentElement;
  if (!el) return { present: false };
  var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  return { present: true, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    text: el.textContent.trim(), right: Math.round(r.right), width: window.innerWidth, sideways: d.scrollWidth - d.clientWidth,
    px: parseFloat(cs.fontSize) }; })()`;

function problems(r) {
  const p = [];
  if (!r.present) { p.push('no wait line (#tw) on the thinking screen'); return p; }
  if (!r.visible) p.push('the wait line is not visible');
  if (r.right > r.width) p.push('the wait line runs ' + (r.right - r.width) + ' px past the width');
  if (r.sideways > 0) p.push('the page scrolls sideways by ' + r.sideways + ' px');
  return p;
}

test('THE WAIT LINE, IN REAL CHROME', async (t) => {
  const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. Set CHROME_PATH.');
  const server = http.createServer((req, res) => app(req, res));
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/rvp-wait-line', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try { targets = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json');
        if (targets.some((x) => x.type === 'page' && x.webSocketDebuggerUrl)) break; } catch { /* not up */ }
      await sleep(400);
    }
    const tgt = (targets || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    assert.ok(tgt, 'Chrome started but exposed no debuggable page');
    ws = new WebSocket(tgt.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
    await new Promise((r) => ws.addEventListener('open', r));
    const send = (method, params) => new Promise((resolve) => { const myId = ++id;
      pending.set(myId, resolve); ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
    const evalJs = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result ? r.result.result.value : undefined; };
    await send('Page.enable');

    const start = async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
      for (let k = 0; k < 150; k++) {
        if (await evalJs(`document.readyState === 'complete' && typeof runHealthCheck === 'function'`)) break;
        await sleep(80);
      }
      // The request is held open, as a slow assessment is; the tick is short.
      await evalJs(`window.RVP_STILL_WORKING_MS = 150; window.fetch = function(){ return new Promise(function(){}); };
        runHealthCheck(); true`);
      await sleep(60);
    };

    for (const s of [{ name: 'Letter 816', width: 816, height: 1056 }, { name: 'A4 794', width: 794, height: 1123 },
      { name: 'phone 390', width: 390, height: 844 }]) {
      await t.test('at ' + s.name, async () => {
        await start(s.width, s.height);
        const first = await evalJs(READ);
        assert.deepEqual(problems(first), [], JSON.stringify(first));
        assert.equal(first.text, 'This usually takes about 35 seconds.');
        await sleep(200);
        const second = await evalJs(READ);
        assert.equal(second.text, 'Still working: 20 seconds so far.', JSON.stringify(second));
        await sleep(300);
        const third = await evalJs(READ);
        assert.notEqual(third.text, second.text, 'the line stopped updating: ' + third.text);
        assert.match(third.text, /^Still working: (40|60|80) seconds so far\./);
        assert.deepEqual(problems(third), [], JSON.stringify(third));
        if (s.width === 390) assert.ok(third.px >= 13, 'the wait line is ' + third.px + ' px on the phone');
      });
    }

    await t.test('CONTROL: a hidden wait line is reported', async () => {
      await start(390, 844);
      await evalJs(`(function(){ var el = document.getElementById('tw'); if (el) el.style.display = 'none'; return true; })()`);
      const p = problems(await evalJs(READ));
      assert.ok(p.some((x) => /not visible|no wait line/.test(x)), 'the check did not see the hidden line: ' + JSON.stringify(p));
    });
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    await new Promise((r) => server.close(r));
  }
});
