// ════════════════════════════════════════════════════════════════════════════
// A PEER RUN THAT ASSESSED NOBODY SHOWS THE ABSENT SENTENCE, NOT AN EMPTY TABLE.
//
// WHY THIS EXISTS. On 2026-09-23 every peer in both B2 test runs failed, and
// Analytics still answered ok:true with a fragment. RVP stored it, and the paid
// report read "against 0 comparable businesses" above a table of 0/0/0 rows.
// A comparison against nobody is not a comparison. The product already has
// the sentence for a comparison it could not produce (PEER_COMPARISON_ABSENT),
// and that is what this report should have shown.
//
// HOW THIS IS DRIVEN. deliverPaidReport, the real delivery path, with every
// outbound request replaced. Analytics answers with the EXACT fragment it sent
// on 2026-09-23 (test-support/zero-peer-fragment-2026-09-23.html) and
// stats.assessed 0. The payload the delivery PATCHes back is the one rendered,
// in real Chrome, and the page a reader would see is what is asserted.
//
// CONTROL: the same fragment with assessed 3 must still render as a table, so
// this test can tell the two cases apart and is not passing on a page that
// never shows a comparison at all.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

process.env.PORT = '39467';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANALYTICS_URL = 'https://analytics.invalid';
process.env.ANALYTICS_TEAM_PASSWORD = 'not-a-password';
process.env.RESEND_API_KEY = 'test-not-a-key';

const { __test__ } = await import('../server.js');
const { deliverPaidReport, renderReportHtml, setFetch, PEER_COMPARISON_ABSENT } = __test__;

const FRAGMENT = fs.readFileSync(new URL('../test-support/zero-peer-fragment-2026-09-23.html', import.meta.url), 'utf8');

const REPORT = () => ({
  pillars: {
    cs: { score: 88, label: 'Customer Sentiment' }, pa: { score: 72, label: 'Pricing & Accessibility' },
    es: { score: 62, label: 'Employee Sentiment' }, sm: { score: 58, label: 'Social Media Impact' },
    cp: { score: 81, label: 'Competitive Positioning' }, bg: { score: 84, label: 'Brand Experience & Growth' },
  },
  executiveSummary: 'A clean summary.',
  competitors: [{ name: 'Rosewood London' }, { name: 'Soho House' }, { name: 'One Aldwych' }],
});

// Runs a delivery with Analytics answering `assessed`, and returns the payload
// the delivery wrote back to subscribers.baseline_report.
async function deliverWith(assessed) {
  const patched = [];
  const fake = async (url, init) => {
    const u = String(url);
    const i = init || {};
    let body = null;
    try { body = i.body ? JSON.parse(i.body) : null; } catch (_) { body = null; }
    let answer = {};
    if (u.startsWith('https://analytics.invalid/peer-comparison')) {
      answer = { ok: true, html: FRAGMENT, runId: 'run-test',
        stats: { named: 3, resolved: 3, assessed, excluded: 0, exclusions: [] } };
    } else if (u.startsWith('https://db.invalid/rest/v1/subscribers')) {
      if (String(i.method).toUpperCase() === 'PATCH' && body && body.baseline_report) patched.push(body.baseline_report);
      answer = [{ id: 'row-1', report_token: (body && body.report_token) || 'tok' }];
    }
    return { ok: true, status: 200, headers: { get: () => null },
             json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  const restore = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await deliverPaidReport({ destEmail: 'owner@example.test', firstName: 'Ana',
      restaurant: 'The Union Club Soho', location: 'London, UK', report: REPORT(),
      survey: { location: 'London, UK', website: '' }, product: 'full', planType: 'one_off',
      amountPaid: 24.99, source: 'test', swapUrl: null });
  } finally { globalThis.fetch = realGlobal; restore(); }
  assert.ok(patched.length, 'the delivery wrote no baseline_report back');
  return patched[patched.length - 1];
}

const CHROME = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CDP_PORT = 9374, SRV_PORT = 8825;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

test('ZERO PEERS ASSESSED: THE PAGE SAYS THE COMPARISON COULD NOT BE PRODUCED, IN REAL CHROME', async (t) => {
  const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. Set CHROME_PATH.');

  const pages = { '/zero': await deliverWith(0), '/three': await deliverWith(3) };
  const server = http.createServer((req, res) => {
    const report = pages[req.url];
    res.writeHead(report ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(report ? renderReportHtml({ subscriber: { restaurant_name: 'The Union Club Soho', location: 'London, UK' },
      report, reportLabel: 'Full Report' }) : '');
  });
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/rvp-zero-peers', 'about:blank'], { stdio: 'ignore' });
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
    const evalJs = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
      return r.result && r.result.result ? r.result.result.value : undefined; };
    await send('Page.enable');
    const read = async (path) => {
      await send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + path });
      for (let k = 0; k < 60; k++) { if ((await evalJs('document.readyState')) === 'complete') break; await sleep(60); }
      return JSON.parse(await evalJs(`JSON.stringify({
        text: document.body.innerText,
        peerTables: document.querySelectorAll('.peer-cmp table').length,
        peerBlocks: document.querySelectorAll('.peer-cmp').length })`));
    };

    await t.test('0 assessed: the absent sentence is on the page', async () => {
      const p = await read('/zero');
      assert.ok(p.text.includes(PEER_COMPARISON_ABSENT.slice(0, 50)), 'the absent sentence is not shown');
    });
    await t.test('0 assessed: and there is no peer table and no "0 comparable" claim', async () => {
      const p = await read('/zero');
      assert.equal(p.peerBlocks, 0, 'a peer block was rendered for a run that assessed nobody');
      assert.equal(p.peerTables, 0);
      assert.doesNotMatch(p.text, /against 0 comparable/);
    });
    await t.test('CONTROL, 3 assessed: the fragment renders as a table and the sentence does not', async () => {
      const p = await read('/three');
      assert.equal(p.peerTables, 1, 'the control shows no table, so this test cannot tell the cases apart');
      assert.ok(!p.text.includes(PEER_COMPARISON_ABSENT.slice(0, 50)));
    });
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    server.close();
  }
});
