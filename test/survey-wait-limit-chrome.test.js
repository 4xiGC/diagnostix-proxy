// ════════════════════════════════════════════════════════════════════════════
// THE SURVEY PAGE WAITS AS LONG AS THE SERVER MAY RUN (Simon, 2026-09-25).
//
// The page aborted /diagnose at 90 s and then showed an ESTIMATED report. Since
// 2026-09-29 every model call may take 180 s and is retried once, so the page
// was giving up on runs the server would finish, and replacing them with
// estimates. The limit is now 420 s: the model phase at its longest (180 s
// plus one retry, p1 and p2 in parallel) plus 60 s for the searches and the
// summary. The "still working" line keeps counting the whole time, and the
// estimated fallback is reached only after the limit.
//
// In real Chrome, on the REAL survey page served by the REAL app, at Letter, A4
// and 390 px:
//   - the page's default limit is 420 000 ms;
//   - with the limit scaled down (window.RVP_DIAGNOSE_TIMEOUT_MS) and the
//     request held open, nothing is estimated before the limit, the line keeps
//     updating, and the fallback arrives only after it;
//   - A FAILING CONTROL: with a limit far shorter than the check window, the
//     check reports the early fallback.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

process.env.PORT = '39498';
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
const CDP_PORT = 9396, SRV_PORT = 8846;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const READ = `(function(){ var h = document.querySelector('.think-h'), tw = document.getElementById('tw'), d = document.documentElement;
  return { heading: h ? h.textContent.trim() : null, line: tw ? tw.textContent.trim() : null,
    estimated: !!(h && /estimated/i.test(h.textContent)), failure: (document.getElementById("rf-h") || {}).textContent || "", sideways: d.scrollWidth - d.clientWidth }; })()`;

// Early fallback, a silent line, or sideways scroll: every one is a problem.
function problems(r, stage) {
  const p = [];
  // 2026-09-30 (B3): giving up early is either an estimate (gone) or the failure page.
  if (r.estimated || r.failure) p.push(stage + ': the page gave up before the limit (' + (r.estimated ? 'an estimate' : 'the failure page') + ')');
  if (!/^(This usually takes|Still working:)/.test(String(r.line || ''))) p.push(stage + ': the still-working line is not showing (' + r.line + ')');
  if (r.sideways > 0) p.push(stage + ': the page scrolls sideways by ' + r.sideways + ' px');
  return p;
}

test('THE SURVEY PAGE WAITS OUT THE SERVER, IN REAL CHROME', async (t) => {
  const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. Set CHROME_PATH.');
  const server = http.createServer((req, res) => app(req, res));
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/rvp-wait-limit', 'about:blank'], { stdio: 'ignore' });
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

    const open = async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
      for (let k = 0; k < 150; k++) {
        if (await evalJs(`document.readyState === 'complete' && typeof runHealthCheck === 'function'`)) break;
        await sleep(80);
      }
    };
    // The request is held open, as a slow assessment is; the clock is scaled.
    const run = (limitMs) => evalJs(`window.RVP_STILL_WORKING_MS = 100; window.RVP_DIAGNOSE_TIMEOUT_MS = ${limitMs};
      window.fetch = function(url, o){ return new Promise(function(res, rej){
        if (o && o.signal) o.signal.addEventListener('abort', function(){ var e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); }); };
      runHealthCheck(); true`);

    await t.test('THE DEFAULT LIMIT IS 420 SECONDS', async () => {
      await open(816, 1056);
      assert.equal(await evalJs(`window.RVP_DIAGNOSE_DEFAULT_MS`), 420000,
        'the page does not wait out the server (180 s plus one retry, plus the searches and the summary)');
    });

    for (const s of [{ name: 'Letter 816', width: 816, height: 1056 }, { name: 'A4 794', width: 794, height: 1123 },
      { name: 'phone 390', width: 390, height: 844 }]) {
      await t.test('at ' + s.name + ': nothing is estimated before the limit, and the line keeps counting', async () => {
        await open(s.width, s.height);
        await run(1500);
        await sleep(350);
        const a = await evalJs(READ);
        await sleep(700);
        const b = await evalJs(READ);
        assert.deepEqual(problems(a, 'at 0.35 s').concat(problems(b, 'at 1.05 s')), [], JSON.stringify([a, b]));
        assert.notEqual(a.line, b.line, 'the still-working line stopped counting');
        await sleep(1100);
        const c = await evalJs(READ);
        // 2026-09-30 (B3): after the limit the page shows the plain failure, never an estimate.
        assert.equal(c.estimated, false, 'an estimated report was shown: ' + JSON.stringify(c));
        assert.equal(c.failure, 'We could not complete this assessment', 'after the limit the failure page should show: ' + JSON.stringify(c));
      });
    }

    await t.test('CONTROL: a limit far shorter than the window is reported as an early fallback', async () => {
      await open(390, 844);
      await run(100);
      await sleep(600);
      const p = problems(await evalJs(READ), 'control');
      assert.ok(p.some((x) => /before the limit/.test(x)), 'the check did not see the early fallback: ' + JSON.stringify(p));
    });
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    await new Promise((r) => server.close(r));
  }
});
