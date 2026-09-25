// ════════════════════════════════════════════════════════════════════════════
// THE SURVEY PAGE NEVER SHOWS AN ESTIMATED REPORT (2026-09-30, B3; Simon Q4).
//
// When /diagnose failed or the page gave up waiting, the page built an
// ESTIMATED report in the browser (buildFallback) and showed it, paywall and
// all, while that estimate was never saved to the server, so a buyer could
// pay for a report the payment webhook would never find. Now the page shows a
// plain failure in the standard's five parts (heading, reason, next,
// consultant, closing), in the refusal step, with the contact address:
//   - after the 420 s wait, if the server never answered;
//   - at once, if the server answered with an error (the server has already
//     sent its internal alert, 43a8a39).
// In real Chrome on the REAL survey page served by the REAL app, at Letter, A4
// and 390 px, with the clock scaled. A FAILING CONTROL hides a part and
// requires the check to say so.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

process.env.PORT = '39496';
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
const CDP_PORT = 9397, SRV_PORT = 8847;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const PARTS = ['heading', 'reason', 'next', 'consultant', 'closing'];
const READ = `(function(){
  var step = document.getElementById('rf-h'); var box = step ? step.closest('.step, section, div') : null;
  var visible = function(el){ if (!el) return false; var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  var parts = ${JSON.stringify(PARTS)}.map(function(p){ var el = document.querySelector('[data-part="' + p + '"]');
    return { part: p, text: el ? el.textContent.trim() : '', visible: visible(el), top: el ? el.getBoundingClientRect().top : null,
      px: el ? parseFloat(getComputedStyle(el).fontSize) : null }; });
  var body = document.body.innerText, d = document.documentElement;
  return { parts: parts, estimated: /estimated/i.test(body), paywall: /Unlock Full Report/i.test(body) && visible(Array.from(document.querySelectorAll('*')).find(function(e){ return /Unlock Full Report/i.test(e.textContent) && e.children.length === 0; })),
    label: (document.getElementById('step-lbl') || {}).textContent, sideways: d.scrollWidth - d.clientWidth, width: innerWidth };
})()`;

function problems(r) {
  const p = [];
  for (const x of r.parts) {
    if (!x.visible || !x.text) p.push('part "' + x.part + '" is missing or empty');
    if (r.width === 390 && x.px !== null && x.px < 13) p.push('part "' + x.part + '" is ' + x.px + ' px on the phone');
  }
  const tops = r.parts.map((x) => x.top);
  if (tops.every((t) => t !== null) && tops.some((t, i) => i && t < tops[i - 1])) p.push('the parts are out of order');
  if (r.estimated) p.push('the page shows an estimated report');
  if (r.paywall) p.push('the page shows the paywall');
  if (r.sideways > 0) p.push('the page scrolls sideways by ' + r.sideways + ' px');
  return p;
}

test('THE SURVEY PAGE SHOWS A PLAIN FAILURE, NEVER AN ESTIMATE, IN REAL CHROME', async (t) => {
  const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. Set CHROME_PATH.');
  const server = http.createServer((req, res) => app(req, res));
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/rvp-failure-page', 'about:blank'], { stdio: 'ignore' });
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
    // The server never answers (the fetch honours its abort), the limit is scaled.
    const runHung = () => evalJs(`window.RVP_STILL_WORKING_MS = 100; window.RVP_DIAGNOSE_TIMEOUT_MS = 400;
      window.fetch = function(url, o){ return new Promise(function(res, rej){
        if (o && o.signal) o.signal.addEventListener('abort', function(){ var e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); }); };
      runHealthCheck(); true`);
    // The server answers at once with an error.
    const run500 = () => evalJs(`window.fetch = function(){ return Promise.resolve(new Response(JSON.stringify({ error: 'Internal' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } })); }; runHealthCheck(); true`);

    for (const s of [{ name: 'Letter 816', width: 816, height: 1056 }, { name: 'A4 794', width: 794, height: 1123 },
      { name: 'phone 390', width: 390, height: 844 }]) {
      await t.test('at ' + s.name + ': the server never answers, the failure after the limit', async () => {
        await open(s.width, s.height);
        await runHung();
        await sleep(200);
        const early = await evalJs(READ);
        assert.equal(early.parts[0].visible, false, 'the failure was shown before the limit');
        await sleep(700);
        const r = await evalJs(READ);
        assert.deepEqual(problems(r), [], JSON.stringify(r));
        assert.equal(r.parts[0].text, 'We could not complete this assessment');
        assert.match(r.parts[4].text, /hello@4xiconsulting\.com/);
      });
      await t.test('at ' + s.name + ': the server answers with an error, the failure at once', async () => {
        await open(s.width, s.height);
        await run500();
        await sleep(300);
        const r = await evalJs(READ);
        assert.deepEqual(problems(r), [], JSON.stringify(r));
      });
    }

    await t.test('CONTROL: a hidden part is reported', async () => {
      await open(390, 844);
      await run500();
      await sleep(300);
      await evalJs(`(function(){ var el = document.querySelector('[data-part="consultant"]'); if (el) el.style.display = 'none'; return true; })()`);
      const p = problems(await evalJs(READ));
      assert.ok(p.some((x) => /consultant/.test(x)), 'the check did not see the hidden part: ' + JSON.stringify(p));
    });
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    await new Promise((r) => server.close(r));
  }
});
