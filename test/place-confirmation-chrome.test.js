// ════════════════════════════════════════════════════════════════════════════
// THE PLACES CONFIRMATION SCREEN, IN REAL CHROME, AT LETTER AND A4 AND INSIDE
// A FRAME AS NARROW AS WIX'S (overnight 2026-09-26, Item 4).
//
// The REAL app serves the REAL survey page; only outbound calls are replaced
// (Places answers with a scripted candidate, the model is a fake, rvp_outcomes
// and Resend are captured). The survey is filled and submitted the way an owner
// does, and the screen is checked where it is actually shown:
//
//   Letter 816 x 1056 and A4 794 x 1123 CSS px, as the SVP and EVP gates do
//   an iframe 320 px wide and 568 tall: THE WIX FRAME'S WIDTH WAS NOT MEASURED
//     (no Wix access; nothing in the repos records it), so the narrowest
//     plausible width is used, Wix's 320 px mobile canvas, with a short fixed
//     height so the screen must scroll inside the frame
//   an iframe 860 px wide: the page's own .shell max-width
//
// At every size: the card shows name, address and review count; both buttons
// carry the exact words, sit inside the width, and are on top where they are
// clicked (elementFromPoint after scrolling into view); no element of the
// screen's own panel extends past the width. A FAILING CONTROL widens the card
// in the 320 frame and requires the same check to report it.
//
// THE PAGE'S OWN HEADER ALREADY SCROLLS SIDEWAYS AT 320 PX, BEFORE ANY OF THIS
// (measured 2026-09-24: the logo image is 402 px wide and the tagline ends at
// 457 px, on the untouched survey form). That is recorded, not fixed here. So
// the page-level check is that the screen adds NO sideways scroll beyond what
// the form itself already has, read at the same size before submitting.
//
// Then the three outcomes: Yes runs the assessment with the token (the row is
// place_confirmed), a thin place is refused with the standard copy and never
// an estimated report, No returns to the form with the entries kept and
// writes declined-by-user, and no match shows its own copy.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

process.env.PORT = '39472';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.RVP_IDENTITY_SECRET = 'test-identity-secret';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude } = __test__;

const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };
const scenario = { mode: 'match', reviews: 765 };
const seen = { outcomes: [], emails: [] };
const fake = async (url, init) => {
  const u = String(url);
  const ok = (j) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.includes('findplacefromtext') && u.includes('formatted_address')) {
    if (scenario.mode === 'nomatch') return ok({ status: 'ZERO_RESULTS', candidates: [] });
    return ok({ status: 'OK', candidates: [{ place_id: 'ChIJ-teclados', name: 'Teclados',
      formatted_address: 'Av. Italia 1234, Providencia, Santiago, Chile', rating: 4.4,
      user_ratings_total: scenario.reviews, business_status: 'OPERATIONAL', geometry: { location: { lat: -33.44, lng: -70.62 } } }] });
  }
  if (u.includes('/rest/v1/rvp_outcomes')) { seen.outcomes.push(JSON.parse(init.body)); return { ok: true, status: 201, text: async () => '' }; }
  if (u.includes('api.resend.com')) { seen.emails.push(JSON.parse(init.body)); return ok({ id: 'x' }); }
  return ok({});
};

const CHROME = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CDP_PORT = 9376, SRV_PORT = 8827;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

// Same origin as the survey, so the test can reach into the frame's document.
const hostPage = (w, h) => `<!doctype html><html><body style="margin:0;background:#ddd">
<iframe id="wix" src="/" style="width:${w}px;height:${h}px;border:0;display:block"></iframe></body></html>`;

// Runs in the page. `W` is the window holding the survey (top or the frame).
const FILL = `(function(W){ var d = W.document;
  d.getElementById('f-name').value = 'Teclados';
  d.getElementById('f-loc-city').value = 'Santiago';
  d.getElementById('f-loc-country').value = 'Chile';
  d.getElementById('f-cname').value = 'Ana';
  d.getElementById('f-email').value = 'owner@example.org';
  W.goStep(1);
  d.querySelector('#p1 .btn-next').click();
  return true; })`;
const CHECK = `(function(W){ var d = W.document, de = d.documentElement;
  var card = d.getElementById('pc-card'), yes = d.getElementById('pc-yes'), no = d.getElementById('pc-no');
  if (!card || !yes || !no) return { missing: true };
  var inX = function(el){ var r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= W.innerWidth + 0.5; };
  var reach = function(el){ el.scrollIntoView({ block: 'center' }); var r = el.getBoundingClientRect();
    var e = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === el || el.contains(e)); };
  var panelRight = 0; d.querySelectorAll('#p5 *').forEach(function(el){ var r = el.getBoundingClientRect();
    if (r.width) panelRight = Math.max(panelRight, r.right); });
  return { active: d.getElementById('p5').classList.contains('active'), card: card.innerText,
    panelOverflow: Math.round(panelRight - W.innerWidth),
    yes: yes.textContent.trim(), no: no.textContent.trim(),
    cardInX: inX(card), yesInX: inX(yes), noInX: inX(no), yesReach: reach(yes), noReach: reach(no),
    overflowX: de.scrollWidth - de.clientWidth, innerWidth: W.innerWidth }; })`;
const PAGE_OVERFLOW = `(function(W){ var de = W.document.documentElement; return de.scrollWidth - de.clientWidth; })`;
const PANEL_OVERFLOW = (id) => `(function(W){ var m = 0; W.document.querySelectorAll('#${id} *').forEach(function(el){
  var r = el.getBoundingClientRect(); if (r.width) m = Math.max(m, r.right); }); return Math.round(m - W.innerWidth); })`;
const ACTIVE = `(function(W){ var a = W.document.querySelector('.panel.active'); return a ? a.id : null; })`;

function assertScreen(r, where, baseline) {
  assert.ok(!r.missing, where + ': the confirmation screen does not exist');
  assert.equal(r.active, true, where + ': the confirmation panel is not the one shown');
  assert.match(r.card, /Teclados/, where);
  assert.match(r.card, /Av\. Italia 1234, Providencia, Santiago, Chile/, where);
  assert.match(r.card, /765 reviews on Google, rated 4\.4/, where);
  assert.equal(r.yes, 'Yes, assess this restaurant', where);
  assert.equal(r.no, 'No, let me correct it', where);
  assert.ok(r.cardInX && r.yesInX && r.noInX, where + ': something sits outside the width ' + JSON.stringify(r));
  assert.ok(r.yesReach && r.noReach, where + ': a button is covered where it is clicked ' + JSON.stringify(r));
  assert.ok(r.panelOverflow <= 0, where + ': the screen extends ' + r.panelOverflow + 'px past the width');
  assert.ok(r.overflowX <= baseline, where + ': the screen adds sideways scroll, ' + r.overflowX + 'px against the form ' + baseline + 'px');
}

test('THE PLACES CONFIRMATION SCREEN, IN REAL CHROME', async (t) => {
  const chromePath = CHROME.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(chromePath, 'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. Set CHROME_PATH.');
  const restoreFetch = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  const restoreClaude = setClaude(async (prompt, opts) => {
    const label = (opts && opts.label) || '';
    if (label === 'diagnose-p1') return { cuisineDetected: 'italian', priceDetected: '$$', pillars: PILLARS };
    if (label === 'diagnose-p2') return { strengths: ['a'], risks: ['b'], competitors: [], actions: [] };
    if (label === 'diagnose-summary') return { executiveSummary: 'A clean summary that names no band.' };
    return {};
  });
  const server = http.createServer((req, res) => {
    const m = /^\/__host\/(\d+)x(\d+)$/.exec(req.url);
    if (m) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(hostPage(m[1], m[2])); }
    return app(req, res);
  });
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/rvp-place-confirm', 'about:blank'], { stdio: 'ignore' });
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

    // Opens the survey at a size and brings it to the confirmation screen.
    // Returns the expression naming the survey's window.
    const open = async ({ width, height, frame }) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const path = frame ? '/__host/' + frame.w + 'x' + frame.h : '/';
      await send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + path });
      const W = frame ? "document.getElementById('wix').contentWindow" : 'window';
      for (let k = 0; k < 150; k++) {
        const ready = await evalJs(`(function(){ try { var w = ${W}; return w.document.readyState === 'complete'
          && typeof w.goStep === 'function' && !!w.document.getElementById('f-name'); } catch (e) { return false; } })()`);
        if (ready) break; await sleep(80);
      }
      return W;
    };
    const waitPanel = async (W, want) => {
      let last = null;
      for (let k = 0; k < 200; k++) { last = await evalJs(ACTIVE + '(' + W + ')'); if (last === want) return last; await sleep(80); }
      return last;
    };

    const SIZES = [
      { name: 'Letter 816 x 1056', width: 816, height: 1056 },
      { name: 'A4 794 x 1123', width: 794, height: 1123 },
      { name: 'Wix frame 320 x 568 (narrowest plausible, unmeasured)', width: 1000, height: 900, frame: { w: 320, h: 568 } },
      { name: 'frame 860 x 700 (the page shell width)', width: 1100, height: 900, frame: { w: 860, h: 700 } },
    ];
    for (const s of SIZES) {
      await t.test('the screen at ' + s.name, async () => {
        Object.assign(scenario, { mode: 'match', reviews: 765 });
        const W = await open(s);
        const baseline = await evalJs(PAGE_OVERFLOW + '(' + W + ')');
        await evalJs(FILL + '(' + W + ')');
        assert.equal(await waitPanel(W, 'p5'), 'p5', s.name + ': the confirmation screen never appeared');
        assertScreen(await evalJs(CHECK + '(' + W + ')'), s.name, baseline);
      });
    }

    await t.test('FAILING CONTROL: a card wider than the 320 frame is reported', async () => {
      Object.assign(scenario, { mode: 'match', reviews: 765 });
      const W = await open(SIZES[2]);
      await evalJs(FILL + '(' + W + ')');
      await waitPanel(W, 'p5');
      await evalJs(`(function(W){ var s = W.document.createElement('style');
        s.textContent = '#pc-card{min-width:700px}'; W.document.head.appendChild(s); return 1; })(${W})`);
      const r = await evalJs(CHECK + '(' + W + ')');
      assert.ok(!r.missing && r.active, 'the control never reached the screen, so it proves nothing');
      assert.ok(!r.cardInX && r.panelOverflow > 0, 'the check passed a card 700px wide in a 320px frame: ' + JSON.stringify(r));
    });

    await t.test('NO: back to the form with the entries kept, and declined-by-user recorded', async () => {
      Object.assign(scenario, { mode: 'match', reviews: 765 });
      seen.outcomes.length = 0;
      const W = await open(SIZES[2]);
      await evalJs(FILL + '(' + W + ')');
      await waitPanel(W, 'p5');
      await evalJs(`(function(W){ W.document.getElementById('pc-no').click(); return 1; })(${W})`);
      assert.equal(await waitPanel(W, 'p0'), 'p0');
      assert.equal(await evalJs(`(${W}).document.getElementById('f-name').value`), 'Teclados');
      for (let k = 0; k < 50 && !seen.outcomes.length; k++) await sleep(60);
      assert.equal(seen.outcomes.length, 1);
      assert.equal(seen.outcomes[0].decision, 'declined-by-user');
      assert.equal(seen.outcomes[0].place_id, 'ChIJ-teclados');
    });

    await t.test('YES: the assessment runs on the confirmed place and the report is shown', async () => {
      Object.assign(scenario, { mode: 'match', reviews: 765 });
      seen.outcomes.length = 0;
      const W = await open(SIZES[0]);
      await evalJs(FILL + '(' + W + ')');
      await waitPanel(W, 'p5');
      await evalJs(`(function(W){ W.document.getElementById('pc-yes').click(); return 1; })(${W})`);
      assert.equal(await waitPanel(W, 'p3'), 'p3', 'the report was never shown');
      const text = await evalJs(`(${W}).document.body.innerText`);
      assert.doesNotMatch(text, /estimated/i, 'an estimated report was shown');
      const row = seen.outcomes.find((o) => o.kind === 'coverage');
      assert.ok(row, 'no coverage row');
      assert.equal(row.place_confirmed, true);
      assert.equal(row.coverage_verdict, 'pass');
    });

    await t.test('REFUSED: a thin place gets the standard refusal, never an estimated report', async () => {
      Object.assign(scenario, { mode: 'match', reviews: 12 });
      const W = await open(SIZES[2]);
      const baseline = await evalJs(PAGE_OVERFLOW + '(' + W + ')');
      await evalJs(FILL + '(' + W + ')');
      await waitPanel(W, 'p5');
      await evalJs(`(function(W){ W.document.getElementById('pc-yes').click(); return 1; })(${W})`);
      assert.equal(await waitPanel(W, 'p4'), 'p4', 'the refusal panel was never shown');
      const text = await evalJs(`(${W}).document.getElementById('p4').innerText`);
      assert.match(text, /We cannot assess Teclados yet/);
      assert.match(text, /You have not been charged for this assessment\./);
      assert.doesNotMatch(await evalJs(`(${W}).document.body.innerText`), /estimated/i);
      const p = await evalJs(PANEL_OVERFLOW('p4') + '(' + W + ')');
      assert.ok(p <= 0, 'the refusal extends ' + p + 'px past the 320 frame');
      const o = await evalJs(PAGE_OVERFLOW + '(' + W + ')');
      assert.ok(o <= baseline, 'the refusal adds sideways scroll: ' + o + 'px against the form ' + baseline + 'px');
    });

    await t.test('NO MATCH: its own copy, and no confirmation screen', async () => {
      Object.assign(scenario, { mode: 'nomatch' });
      const W = await open(SIZES[0]);
      await evalJs(FILL + '(' + W + ')');
      assert.equal(await waitPanel(W, 'p4'), 'p4');
      assert.match(await evalJs(`(${W}).document.getElementById('p4').innerText`), /We could not find Teclados on Google/);
    });
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    server.close();
    globalThis.fetch = realGlobal; restoreClaude(); restoreFetch();
  }
});
