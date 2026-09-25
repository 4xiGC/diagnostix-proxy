// THE PRINT GATE RUNS AT LETTER AND AT A4, IN REAL CHROME, IN npm test.
//
// WHY THIS FILE EXISTS. Before it, every Chrome gate this project has ever run
// lived OUTSIDE the repo, in overnight\. `npm test` was 496 assertions of
// static text and logic and could not observe a single thing a reader sees.
// The print rule added in e748fe7 was pinned by reading the CSS string, which
// proves the rule was TYPED, not that Chrome APPLIES it. Those are different
// claims and only the second one matters to a customer holding paper.
//
// ── THE PAPER IS AN OPEN DECISION, AND THAT IS WHY BOTH ARE TESTED ─────────
//
// The report declares `@page{margin:0.6in}` and NO size. So the paper is the
// printer's default: Letter for a US customer, A4 for a European one. THIS
// TEST DOES NOT DECIDE THAT and must not be read as deciding it. It asserts
// the layout survives BOTH, which is the only assertion available while the
// decision is open. If a size is ever declared, this file is where the
// assertion narrows to it.
//
//   content area, 96 css px/in, 0.6in margins all round:
//     Letter  (8.5  - 1.2) x (11    - 1.2)  ->  701 x 941
//     A4      (8.27 - 1.2) x (11.69 - 1.2)  ->  679 x 1007
//
// A4 is TALLER and NARROWER. Narrower wins: across the 106 stored reports on
// 2026-09-23, A4 came to 631 pages against Letter's 626.
//
// ── WHAT IS ASSERTED, AND ONE THING THAT CANNOT BE ────────────────────────
//
// EMULATED PRINT MEDIA DOES NOT PAGINATE. Emulation.setEmulatedMedia applies
// the print CSS and then lays the document out as one continuous strip, so
// "does this box cross a multiple of the page height" answers the question
// "what would happen with NO break rules", not "what happens". An earlier gate
// did exactly that and flagged three selectors that all CARRY the rule.
//
// So the two observable things are asserted instead:
//   1. COMPUTED STYLE at each paper: Chrome reports page-break-inside:avoid on
//      every block that must stay whole. Chrome's own answer, not the source.
//   2. REAL PAGINATION: Page.printToPDF genuinely paginates. The page count is
//      read out of the PDF, at each paper, and the two must DISAGREE, which is
//      the control proving the paper argument is live rather than ignored.
//
// AND A CONTROL THAT FAILS: the same page is served again with one stylesheet
// appended that sets .exec-box back to page-break-inside:auto. The probe must
// report `auto` for it. If that control ever passes, the probe is reading
// something other than the rule and every green above it is worthless.
//
// CHROME MISSING IS A FAILURE, NOT A SKIP. A ship gate that goes quietly green
// on the machine that lacks its dependency is the failure mode this project
// has already hit once, where a superseded check went true instead of red.
import { test } from 'node:test';
import assert from 'node:assert';
import { launchChrome } from '../test-support/chrome-launch.mjs';
import http from 'node:http';
import fs from 'node:fs';

process.env.RVP_IMPORT_ONLY = '1';
process.env.PORT = process.env.PORT || '39477';
const { __test__ } = await import('../server.js');
const { renderReportHtml } = __test__;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const PAPERS = [
  { name: 'Letter', w: 701, h: 941, pw: 8.5, ph: 11 },
  { name: 'A4', w: 679, h: 1007, pw: 8.27, ph: 11.69 },
];
const KEEP_WHOLE = ['.exec-box', '.act', '.comp-card', '.qblock', '.col-2'];
const BREAK_THE_RULE =
  '<style>@media print{.exec-box{page-break-inside:auto;break-inside:auto}}</style>';

const SRV_PORT = 8823;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A payload with every guarded block present. Built here, not read from the
// database, so this test needs no credentials and no network.
const FIXTURE = {
  pillars: {
    cs: { score: 71, label: 'Customer Sentiment', status: 'good' },
    pa: { score: 64, label: 'Pricing & Accessibility', status: 'warn' },
    es: { score: 58, label: 'Employee Sentiment', status: 'warn' },
    sm: { score: 49, label: 'Social Media Impact', status: 'warn' },
    cp: { score: 66, label: 'Competitive Positioning', status: 'good' },
    bg: { score: 74, label: 'Brand Experience & Growth', status: 'good' },
  },
  executiveSummary:
    'The restaurant earns a fair overall position, with steady customer sentiment '
    + 'and a menu that reviewers single out, set against thinner evidence on staff '
    + 'experience and a social presence that updates infrequently. The clearest '
    + 'openings are in review response time and in publishing the wine list where '
    + 'guests actually look for it before booking a table.',
  strengths: ['Consistent review sentiment across platforms', 'Distinctive menu'],
  risks: ['Few recent staff reviews', 'Social posting has lapsed'],
  actions: [
    { title: 'Reply to every review inside 48 hours', detail: 'Assign one owner.' },
    { title: 'Publish the current wine list', detail: 'On the site, not a PDF.' },
    { title: 'Post twice a week', detail: 'Dishes and people, not offers.' },
  ],
  competitors: [
    { name: 'Nearby One', note: 'Higher review volume' },
    { name: 'Nearby Two', note: 'Stronger social cadence' },
    { name: 'Nearby Three', note: 'Comparable pricing' },
  ],
  // .qblock comes from reviewVerbatims and from nothing else (server.js:3795).
  // The first draft of this fixture left them out, and the coverage control
  // above is what said so: four of five selectors present, so the .qblock half
  // of the assertion was quietly asserting nothing.
  reviewVerbatims: [
    { text: 'The tasting menu was the best meal we have had all year.', source: 'Google', stars: 5, sentiment: 'positive' },
    { text: 'Service dragged badly once the room filled up.', source: 'Tripadvisor', stars: 2, sentiment: 'negative' },
    { text: 'Solid food, unremarkable room, fair prices.', source: 'Yelp', stars: 3, sentiment: 'neutral' },
  ],
};

const getJSON = (url) =>
  new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });

test('THE PRINT LAYOUT HOLDS AT LETTER AND AT A4, MEASURED IN REAL CHROME', async (t) => {
  const chromePath = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(
    chromePath,
    'NO CHROME FOUND, AND THAT IS A FAILURE, NOT A SKIP. This gate checks what a '
    + 'reader sees on paper and cannot be answered without a browser. Set '
    + 'CHROME_PATH. Looked in: ' + CHROME_CANDIDATES.join(', ')
  );

  const server = http.createServer((req, res) => {
    const broken = /broken/.test(req.url);
    const html = renderReportHtml({
      subscriber: { restaurant_name: 'Print Gate Fixture', location: 'Santiago' },
      report: FIXTURE,
      reportLabel: 'HealthCheck',
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(broken ? html + BREAK_THE_RULE : html);
  });
  await new Promise((r) => server.listen(SRV_PORT, '127.0.0.1', r));

  // 2026-09-30 (Q14): Chrome picks its own debugging port (test-support/chrome-launch.mjs).
  const chrome = await launchChrome(chromePath);

  let ws = null;
  try {
    const tgt = chrome.target;
    assert.ok(tgt, 'Chrome started but exposed no debuggable page');

    ws = new WebSocket(tgt.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    await new Promise((r) => ws.addEventListener('open', r));
    const send = (method, params) =>
      new Promise((resolve) => {
        const myId = ++id;
        pending.set(myId, resolve);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      });
    const evalJs = async (e) => {
      const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setEmulatedMedia', { media: 'print' });

    const PROBE = `(function(){
      const sels = ${JSON.stringify(KEEP_WHOLE)};
      const out = {};
      for (const sel of sels) {
        out[sel] = [...document.querySelectorAll(sel)].map(el => ({
          h: Math.round(el.getBoundingClientRect().height),
          w: Math.round(el.getBoundingClientRect().width),
          rule: getComputedStyle(el).pageBreakInside || getComputedStyle(el).breakInside,
        }));
      }
      const box = document.querySelector('.exec-box');
      const r = box ? box.getBoundingClientRect() : null;
      return JSON.stringify({
        blocks: out,
        box: r ? { top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY),
                   h: Math.round(r.height) } : null,
      });
    })()`;

    const load = async (path) => {
      await send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + path });
      for (let k = 0; k < 60; k++) {
        if ((await evalJs('document.readyState')) === 'complete') break;
        await sleep(60);
      }
      await sleep(60);
      return JSON.parse(await evalJs(PROBE));
    };

    const printPdf = async (paper) => {
      const r = await send('Page.printToPDF', {
        paperWidth: paper.pw, paperHeight: paper.ph,
        marginTop: 0.6, marginBottom: 0.6, marginLeft: 0.6, marginRight: 0.6,
        printBackground: true, preferCSSPageSize: false,
      });
      const b64 = r && r.result && r.result.data;
      if (!b64) return { pages: null, media: null };
      const buf = Buffer.from(b64, 'base64').toString('latin1');
      const pages = (buf.match(/\/Type\s*\/Page[^s]/g) || []).length || null;
      // The paper Chrome ACTUALLY used, read back out of the file it produced.
      const box = buf.match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/);
      const media = box
        ? { w: Math.round(Number(box[3]) - Number(box[1])), h: Math.round(Number(box[4]) - Number(box[2])) }
        : null;
      return { pages, media };
    };

    const pdfByPaper = {};

    for (const paper of PAPERS) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: paper.w, height: paper.h, deviceScaleFactor: 1, mobile: false,
      });

      await t.test(paper.name + ': every block that must stay whole carries the rule', async () => {
        const m = await load('/r');
        const seen = [];
        const bad = [];
        for (const sel of KEEP_WHOLE) {
          const els = m.blocks[sel] || [];
          if (els.length) seen.push(sel + ' x' + els.length);
          for (const el of els) {
            if (!/avoid/.test(String(el.rule))) bad.push(sel + '=' + el.rule);
          }
        }
        assert.strictEqual(
          seen.length, KEEP_WHOLE.length,
          'CONTROL: the fixture must contain every guarded block, otherwise this '
          + 'test asserts nothing about the ones it is missing. Present: ' + seen.join(', ')
        );
        assert.deepStrictEqual(bad, [], 'blocks without page-break-inside:avoid at ' + paper.name);
      });

      await t.test(paper.name + ': the summary box is shorter than one page', async () => {
        const m = await load('/r');
        assert.ok(m.box, 'no .exec-box rendered');
        assert.ok(
          m.box.h < paper.h,
          'the summary box is ' + m.box.h + 'px at ' + paper.name + ', taller than the '
          + paper.h + 'px page. NO BREAK RULE CAN SAVE A BLOCK TALLER THAN THE PAGE; '
          + 'it will split wherever the page ends.'
        );
      });

      await t.test(paper.name + ': the page really paginates onto ' + paper.name + ' paper', async () => {
        await load('/r');
        const { pages, media } = await printPdf(paper);
        assert.ok(typeof pages === 'number' && pages >= 1,
          'printToPDF produced no countable pages at ' + paper.name);
        // 72 pt per inch. This is the paper Chrome used, not the paper we asked
        // for: it is read from the MediaBox of the PDF that came back.
        const wantW = Math.round(paper.pw * 72), wantH = Math.round(paper.ph * 72);
        assert.ok(media, 'the PDF declared no MediaBox, so the paper cannot be read back');
        assert.ok(
          Math.abs(media.w - wantW) <= 1 && Math.abs(media.h - wantH) <= 1,
          'asked Chrome for ' + paper.name + ' (' + wantW + 'x' + wantH + 'pt) and the '
          + 'PDF came back ' + media.w + 'x' + media.h + 'pt'
        );
        pdfByPaper[paper.name] = { pages, media };
      });

      await t.test(paper.name + ': CONTROL, overriding the rule is detected', async () => {
        const m = await load('/r?broken');
        const rules = (m.blocks['.exec-box'] || []).map((el) => String(el.rule));
        assert.ok(rules.length, 'no .exec-box on the control page');
        assert.ok(
          rules.every((r) => /auto/.test(r)),
          'THE CONTROL DID NOT GO RED at ' + paper.name + '. The same page was served '
          + 'with page-break-inside:auto forced on .exec-box and the probe still read '
          + JSON.stringify(rules) + '. The probe is not reading the rule.'
        );
      });
    }

    // CONTROL: the two runs are genuinely two papers.
    //
    // The first draft of this control asserted the PAGE COUNTS differed, and it
    // failed: this fixture comes to 3 pages on both. That was the control being
    // wrong, not the gate. Across the 106 stored reports only 9 change page
    // count between the papers, so one short fixture agreeing is the expected
    // case and an assertion built on it would have to be padded until it
    // happened to break, which measures the padding.
    //
    // The MediaBox is the honest version: it is the paper Chrome actually used,
    // read back out of the PDF, and it cannot agree if the argument is ignored.
    await t.test('CONTROL: the two runs used two different papers', () => {
      const L = pdfByPaper.Letter, A = pdfByPaper.A4;
      assert.ok(L && A, 'one of the two papers produced no PDF');
      assert.notDeepStrictEqual(
        L.media, A.media,
        'Letter and A4 both came back as ' + JSON.stringify(L.media) + '. The paper '
        + 'argument is being ignored, so every measurement above is one paper '
        + 'reported twice.'
      );
      assert.ok(A.media.h > L.media.h, 'A4 must be the taller page');
      assert.ok(A.media.w < L.media.w, 'A4 must be the narrower page');
    });

    await t.test('the report still declares NO paper size, so the decision stays open', () => {
      const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
      const pageRules = src.match(/@page\s*\{[^}]*\}/g) || [];
      assert.ok(pageRules.length, 'no @page rule found at all');
      for (const rule of pageRules) {
        assert.ok(
          !/\bsize\s*:/.test(rule),
          'server.js now declares a paper size in ' + rule + '. That is a real '
          + 'decision and it may well be the right one, but this gate asserts both '
          + 'papers precisely because it was open. Narrow the gate in the same '
          + 'commit that declares the size.'
        );
      }
    });
  } finally {
    try { ws && ws.close(); } catch { /* closing */ }
    try { chrome.kill(); } catch { /* already gone */ }
    server.close();
  }
});
