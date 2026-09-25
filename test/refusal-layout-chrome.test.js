// ════════════════════════════════════════════════════════════════════════════
// THE REFUSAL LAYOUT, IN REAL CHROME, AT LETTER, A4 AND 390 PX (2026-09-28, A2).
//
// The REAL app serves the REAL survey page. The page's own showRefusal() is
// called with the copy the server builds (the coverage refusal and the no-match
// identity refusal), and the refusal panel is read where it is shown:
//
//   the five parts are present, non-empty and in order (heading, reason, next,
//   consultant, closing: data-part on each block)
//   nothing in the panel extends past the width, and the page does not scroll
//   sideways
//   the body text is at least 13 px at 390 px wide
//
// A FAILING CONTROL puts a 700 px element in the reason block at 390 px and
// requires the same check to report it.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome } from '../test-support/chrome-launch.mjs';
import http from 'node:http';
import fs from 'node:fs';

process.env.PORT = '39481';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const { app } = __test__;
const { reviewGate, refusalCopy, noMatchCopy } = await import('../lib-review-gate.js');

const CHROME = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const SRV_PORT = 8831;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const PARTS = ['heading', 'reason', 'next', 'consultant', 'closing'];
const READ = `(function(){ var d = document, p = d.getElementById('p4');
  var parts = Array.prototype.map.call(p.querySelectorAll('[data-part]'), function(el){
    return { part: el.getAttribute('data-part'), text: el.innerText.trim(),
      px: parseFloat(getComputedStyle(el.querySelector('p') || el).fontSize) }; });
  var right = 0; p.querySelectorAll('*').forEach(function(el){ var r = el.getBoundingClientRect(); if (r.width) right = Math.max(right, r.right); });
  return { active: p.classList.contains('active'), parts: parts,
    panelOverflow: Math.round(right - window.innerWidth),
    pageOverflow: d.documentElement.scrollWidth - d.documentElement.clientWidth }; })()`;

function checkPanel(r) {
  const problems = [];
  if (!r.active) problems.push('the refusal panel is not the one shown');
  const order = r.parts.map((x) => x.part);
  if (JSON.stringify(order) !== JSON.stringify(PARTS)) problems.push('parts out of order: ' + order.join(','));
  for (const x of r.parts) if (!x.text) problems.push('empty part: ' + x.part);
  if (r.panelOverflow > 0) problems.push('the panel extends ' + r.panelOverflow + 'px past the width');
  if (r.pageOverflow > 0) problems.push('the page scrolls sideways by ' + r.pageOverflow + 'px');
  return problems;
}

test('THE REFUSAL LAYOUT, IN REAL CHROME', async (t) => {
  const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. Set CHROME_PATH.');
  const server = http.createServer((req, res) => app(req, res));
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));
  // 2026-09-30 (Q14): Chrome picks its own debugging port (test-support/chrome-launch.mjs).
  const chrome = await launchChrome(chromePath);
  let ws = null;
  try {
    const tgt = chrome.target;
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

    const show = async (width, height, copy) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
      for (let k = 0; k < 150; k++) {
        if (await evalJs(`document.readyState === 'complete' && typeof showRefusal === 'function'`)) break;
        await sleep(80);
      }
      await evalJs('showRefusal(' + JSON.stringify(copy) + '); true');
      await sleep(150);
      return evalJs(READ);
    };

    const NOW = Date.parse('2026-09-24T12:00:00Z');
    const COPIES = {
      'coverage refusal': refusalCopy({ subject: 'Casa Teclados SpA', gate: reviewGate({ subjectReviewCount: 12 }, null, NOW), channel: 'page' }),
      'identity refusal (no Places match)': noMatchCopy('Nowhere Bistro With A Rather Long Name', 'page'),
    };
    const SIZES = [
      { name: 'Letter 816 x 1056', width: 816, height: 1056 },
      { name: 'A4 794 x 1123', width: 794, height: 1123 },
      { name: 'phone 390 x 844', width: 390, height: 844 },
    ];
    for (const [label, copy] of Object.entries(COPIES)) {
      for (const s of SIZES) {
        await t.test(label + ' at ' + s.name, async () => {
          const r = await show(s.width, s.height, copy);
          assert.deepEqual(checkPanel(r), [], JSON.stringify(r));
          if (s.width === 390) for (const x of r.parts) assert.ok(x.px >= 13, x.part + ' is ' + x.px + 'px at 390 wide');
        });
      }
    }

    await t.test('CONTROL: a 700 px element in the reason block at 390 px is reported', async () => {
      await show(390, 844, COPIES['coverage refusal']);
      await evalJs(`(function(){ var b = document.querySelector('#p4 [data-part="reason"]');
        var x = document.createElement('div'); x.style.width = '700px'; x.textContent = 'wide'; b.appendChild(x); return true; })()`);
      const problems = checkPanel(await evalJs(READ));
      assert.ok(problems.some((p) => /past the width|sideways/.test(p)), 'the check did not see the wide element: ' + JSON.stringify(problems));
    });
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    await new Promise((r) => server.close(r));
  }
});
