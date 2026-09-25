// ════════════════════════════════════════════════════════════════════════════
// THE DELIVERED REPORT IS READABLE ON A PHONE (2026-09-29, recommendation 1).
//
// Measured 2026-09-28 (B3) on the most recent paid report, Orchid 94a649d8: a
// phone laid the page out at 980 px and shrank it to fit, because
// renderReportHtml had NO viewport meta tag. Every line of body text was
// unreadably small, 182 elements sat past 390 px, and the page's own
// @media (max-width:680px) rules never fired. The survey page has the tag; the
// report did not.
//
// In real Chrome with mobile emulation at 390 x 844 (a phone lays out by the
// viewport tag, exactly as here), and at Letter and A4 widths:
//   the layout viewport is the device width (390 on the phone), not 980
//   the page does not scroll sideways
//   (text under 12 px on the phone is printed as a measurement, not failed)
// A FAILING CONTROL puts a 1200 px element (wider than even the 980 px fallback layout) in the page at 390 px and requires
// the sideways-scroll check to report it.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

process.env.RVP_IMPORT_ONLY = '1';
process.env.PORT = process.env.PORT || '39491';
const { __test__ } = await import('../server.js');
const { renderReportHtml } = __test__;

const CHROME = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CDP_PORT = 9391, SRV_PORT = 8841;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const FIXTURE = {
  pillars: {
    cs: { score: 71, label: 'Customer Sentiment', status: 'good' },
    pa: { score: 64, label: 'Pricing & Accessibility', status: 'warn' },
    es: { score: 58, label: 'Employee Sentiment', status: 'warn' },
    sm: { score: 49, label: 'Social Media Impact', status: 'warn' },
    cp: { score: 66, label: 'Competitive Positioning', status: 'good' },
    bg: { score: 74, label: 'Brand Experience & Growth', status: 'good' },
  },
  executiveSummary: 'The restaurant earns a fair overall position, with steady customer sentiment and a menu that '
    + 'reviewers single out, set against thinner evidence on staff experience and a social presence that updates '
    + 'infrequently. The clearest openings are in review response time and in publishing the wine list.',
  strengths: ['Consistent review sentiment across platforms', 'Distinctive menu'],
  risks: ['Few recent staff reviews', 'Social posting has lapsed'],
  actions: [
    { title: 'Reply to every review inside 48 hours', detail: 'Assign one owner.' },
    { title: 'Publish the current wine list', detail: 'On the site, not a PDF.' },
  ],
  competitors: [
    { name: 'Nearby One', note: 'Higher review volume' },
    { name: 'Nearby Two', note: 'Stronger social cadence' },
  ],
  reviewVerbatims: [
    { text: 'The tasting menu was the best meal we have had all year.', source: 'Google', stars: 5, sentiment: 'positive' },
    { text: 'Service dragged badly once the room filled up.', source: 'Tripadvisor', stars: 2, sentiment: 'negative' },
  ],
  evidence: { searchesRun: 9, resultsReturned: 81, resultsRead: 40, distinctSites: 17, reviewsTotal: 10461 },
  // "Where you sit", from Analytics' own renderer (the contract fixture): its fixed inline column
  // widths are what kept the real Orchid report 79 px wider than a phone after the viewport tag.
  peerComparisonHtml: fs.readFileSync(new URL('../test-support/peer-comparison-fragment-2026-09-29.html', import.meta.url), 'utf8'),
};

const READ = `(function(){ var d = document.documentElement, small = [], texts = 0;
  document.querySelectorAll('p, li, .exec-box, td').forEach(function(el){
    if (!el.innerText || !el.innerText.trim()) return; texts++;
    var px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 12) small.push((el.className || el.tagName) + ' ' + px + 'px'); });
  return { layoutWidth: window.innerWidth, sideways: d.scrollWidth - d.clientWidth, small: small, texts: texts }; })()`;

test('THE DELIVERED REPORT ON A PHONE, IN REAL CHROME', async (t) => {
  const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. Set CHROME_PATH.');
  const server = http.createServer((req, res) => {
    const html = renderReportHtml({ subscriber: { restaurant_name: 'Phone Gate Fixture With A Long Restaurant Name', location: 'Santiago' },
      report: FIXTURE, reportLabel: 'HealthCheck' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/rvp-report-phone', 'about:blank'], { stdio: 'ignore' });
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
      for (let k = 0; k < 150; k++) { if (await evalJs(`document.readyState === 'complete'`)) break; await sleep(80); }
      await sleep(200);
    };

    for (const s of [{ name: 'Letter 816', width: 816, height: 1056 }, { name: 'A4 794', width: 794, height: 1123 },
      { name: 'phone 390', width: 390, height: 844 }]) {
      await t.test('at ' + s.name, async () => {
        await open(s.width, s.height);
        const r = await evalJs(READ);
        assert.equal(r.layoutWidth, s.width, 'the page lays out at ' + r.layoutWidth + ' px, not the device width ' + s.width);
        assert.ok(r.sideways <= 0, 'the page scrolls sideways by ' + r.sideways + ' px');
        // Small text is MEASURED, not failed: recommendation 1 for RVP is the
        // viewport tag, and the remaining sub-12 px text is the report's own
        // small-caps labels and footer, a separate type decision (recorded).
        if (s.width === 390) console.log('# RVP phone 390: text blocks under 12 px: ' + JSON.stringify(r.small) + ' of ' + r.texts);
      });
    }

    await t.test('CONTROL: a 1200 px element at 390 px is reported as sideways scroll', async () => {
      await open(390, 844);
      await evalJs(`(function(){ var x = document.createElement('div'); x.style.width = '1200px'; x.style.height = '4px';
        document.body.appendChild(x); return true; })()`);
      const r = await evalJs(READ);
      assert.ok(r.sideways > 0, 'the check did not see the 1200 px element: ' + JSON.stringify(r));
    });
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    await new Promise((r) => server.close(r));
  }
});
