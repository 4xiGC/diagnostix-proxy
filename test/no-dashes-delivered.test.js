// NOTHING DELIVERED TO A READER CONTAINS AN EM DASH OR AN EN DASH.
//
// ── WHY A SOURCE GREP IS THE WRONG TEST, AND THIS IS THE RIGHT ONE ────────
//
// server.js contains about a hundred lines with an em dash and every one of
// them is a CODE COMMENT that never leaves the server. A grep over the source
// would fail on all of them, be silenced with an exception list, and the
// exception list would then be where the real ones hide.
//
// So the unit is DELIVERED BYTES: what renderReportHtml returns, and what the
// survey page ships. A dash is a defect when a reader can see it.
//
// ── THREE SOURCES OF A DASH, AND ONLY ONE OF THEM WAS DEFENDED ────────────
//
// 1. MODEL PROSE. Handled twice over: every p1 and p2 prompt carries a
//    PUNCTUATION HARD RULE, and stripDashes is the backstop behind it, with a
//    greppable [dash-sanitizer] log line so it is measurable whether the
//    prompt is doing its job or only the backstop is.
//
// 2. HARD CODED TEMPLATE COPY. NOT DEFENDED AT ALL, because
//    sanitizeReportProse walks a named allow list of MODEL-authored fields and
//    template literals are not in it. "These complement &mdash; not replace
//    &mdash; the operational actions below." sat in both renderers and reached
//    every reader. That is what this commit fixes.
//
// 3. HTML ENTITIES. &mdash; passes any literal-character check and still
//    renders as a dash. decodeDashEntities exists for exactly this and the
//    scanner below checks entities too, for the same reason.
//
// ── TWO DASHES THAT MUST SURVIVE, AND THE TEST SAYS SO ────────────────────
//
// An em dash in renderEvpReportHtml's `proposerProfile.split(/[,—-]/)` is a
// SEPARATOR, not prose: it splits a profile on whichever separator the user
// typed, and users type the dash. Substituting it silently stops matching
// those profiles.
//
// And the prompts say `never use an em-dash (—)`. The example IS the
// instruction. Removing the character to satisfy house style would leave the
// model told never to use nothing.
//
// Both are asserted PRESENT here, so a later sweep cannot quietly take them.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

process.env.RVP_IMPORT_ONLY = '1';
process.env.PORT = process.env.PORT || '39481';
const { __test__ } = await import('../server.js');
const { renderReportHtml, stripDashes, sanitizeReportProse } = __test__;

const EM = '—';
const EN = '–';
const ENTITY = /&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;/i;
// The escape form, as it appears in a JavaScript string literal shipped inside
// a page. It renders as a dash in the browser and contains no dash byte.
const ESCAPE = /\\u201[34]/;

function dashesIn(text) {
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    const why = line.includes(EM) ? 'literal em dash'
      : line.includes(EN) ? 'literal en dash'
      : ENTITY.test(line) ? 'dash entity'
      : ESCAPE.test(line) ? 'dash escape'
      : null;
    if (why) out.push('line ' + (i + 1) + ', ' + why + ': ' + line.trim().slice(0, 120));
  });
  return out;
}

const PILLARS = {
  cs: { score: 72, label: 'Customer Sentiment', status: 'good' },
  pa: { score: 65, label: 'Pricing & Accessibility', status: 'warn' },
  es: { score: 58, label: 'Employee Sentiment', status: 'warn' },
  sm: { score: 74, label: 'Social Media Impact', status: 'good' },
  cp: { score: 70, label: 'Competitive Positioning', status: 'good' },
  bg: { score: 71, label: 'Brand Experience & Growth', status: 'good' },
};

// Every optional block turned on, so the scan reaches the template copy that
// only renders when a payload is complete. A minimal payload would pass this
// test while leaving the commercial recommendations block unexamined, and the
// sentence that started this was in that block.
const FULL = {
  pillars: PILLARS,
  executiveSummary: 'A fair overall position with steady customer sentiment.',
  strengths: ['Consistent sentiment'], risks: ['Thin staff signal'],
  actions: [{ title: 'Reply to reviews', detail: 'Assign one owner.', priority: 'urgent' }],
  competitors: [{ name: 'Nearby One', note: 'Higher review volume' }],
  reviewVerbatims: [{ text: 'Very good', source: 'Google', stars: 5, sentiment: 'positive' }],
  themes: { positive: ['food'], negative: ['wait'], neutral: ['decor'] },
  businessRealityAnalysis: 'Covers are down while sentiment holds steady.',
  perceptionGap: 'Survey optimism runs ahead of public sentiment.',
  pillarGapNarratives: { cs: 'Sentiment is steady while covers fall.' },
  // commercialActions, not commercialRecommendations. The first draft of this
  // fixture used the wrong name and the CONTROL below is what said so: the
  // main scan was passing over a page that never rendered the block holding
  // the defect this commit fixes.
  commercialActions: [{ title: 'Raise midweek covers', desc: 'Target the office trade.', evidence: 'Covers down 4%' }],
  meta: { executiveSummaryReplacedAt: '2026-09-22T04:00:00Z', executiveSummaryOriginal: 'old' },
};

// The financial metrics are numbers read off the SUBSCRIBER, not the report,
// and hasAnyBM gates both the business reality block and the commercial
// recommendations block behind them.
const render = (report, subscriber = {}) => renderReportHtml({
  subscriber: { restaurant_name: 'Dash Fixture', location: 'Santiago', ...subscriber },
  report, reportLabel: 'HealthCheck',
});
const WITH_METRICS = { guest_count_change: -4, avg_check_change: 1, profitability_change: -5 };

test('THE DELIVERED REPORT PAGE CARRIES NO DASH, in any of its three forms', () => {
  const found = dashesIn(render(FULL, WITH_METRICS));
  assert.deepStrictEqual(found, [], found.join('\n'));
});

test('and neither does a minimal payload, where different branches render', () => {
  const found = dashesIn(render({ pillars: PILLARS }));
  assert.deepStrictEqual(found, [], found.join('\n'));
});

test('THE SURVEY PAGE CARRIES NO DASH', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const found = dashesIn(html);
  assert.deepStrictEqual(found, [], found.join('\n'));
});

// ── CONTROLS ──────────────────────────────────────────────────────────────

test('CONTROL: the scanner CAN fail, on all three forms', () => {
  assert.strictEqual(dashesIn('a ' + EM + ' b').length, 1, 'literal em dash not caught');
  assert.strictEqual(dashesIn('a ' + EN + ' b').length, 1, 'literal en dash not caught');
  assert.strictEqual(dashesIn('a &mdash; b').length, 1, 'entity not caught');
  assert.strictEqual(dashesIn('a \\u2014 b').length, 1, 'escape not caught');
  assert.strictEqual(dashesIn('a - b').length, 0, 'a plain hyphen must NOT be caught');
});

test('CONTROL: the report fixture actually renders the block that held the defect', () => {
  const html = render(FULL, WITH_METRICS);
  assert.match(html, /These complement, and do not replace, the operational actions below/,
    'the commercial recommendations block must be in the rendered output, '
    + 'otherwise the main test is scanning a page that never contained the bug');
});

// ── THE BACKSTOP STILL WORKS, BOTH DIRECTIONS ─────────────────────────────

test('stripDashes: a numeric range becomes a hyphen, never a deletion', () => {
  // Deleting the dash from "5,000-50,000" would yield "5,00050,000", which is
  // a different number presented with full confidence.
  assert.strictEqual(stripDashes('5,000' + EN + '50,000'), '5,000-50,000');
  assert.strictEqual(stripDashes('10 ' + EM + ' 20'), '10-20');
});

test('stripDashes: spaced prose becomes a comma, and entities decode first', () => {
  assert.strictEqual(stripDashes('lead ' + EM + ' and follow'), 'lead, and follow');
  assert.strictEqual(stripDashes('lead &mdash; and follow'), 'lead, and follow');
  assert.strictEqual(stripDashes('200&ndash;500'), '200-500');
});

test('sanitizeReportProse cleans model prose in place', () => {
  const report = { executiveSummary: 'Strong sentiment ' + EM + ' weak staffing.' };
  sanitizeReportProse(report);
  assert.strictEqual(report.executiveSummary, 'Strong sentiment, weak staffing.');
});

// ── THE TWO DASHES THAT MUST NOT BE SWEPT AWAY ────────────────────────────

test('THE SEPARATOR SURVIVES: proposerProfile still splits on a dash', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // The CALL, not the comment above it that also names the function. The first
  // draft of this matched the comment and passed on a line that proves nothing.
  const line = src.split('\n').find((l) => l.includes('proposerProfile.split(/'));
  assert.ok(line, 'the split call has gone; if it moved, move this assertion with it');
  assert.ok(line.includes(EM),
    'the em dash in the split character class is a SEPARATOR, not prose. Users '
    + 'type it in a profile like "Acme Partners - hospitality advisory" and '
    + 'removing it stops matching them. Line found: ' + line.trim());
  // And it behaves: the same class, applied here, splits on the dash.
  const profile = 'Acme Partners ' + EM + ' hospitality advisory';
  assert.strictEqual(profile.split(/[,—-]/)[0].trim(), 'Acme Partners');
});

test('THE PROMPT RULE SURVIVES: the example dashes are still in the instruction', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const all = src.split('\n').filter((l) => l.includes('PUNCTUATION, HARD RULE'));
  assert.ok(all.length >= 3, 'expected the rule in at least three places, found ' + all.length);
  // One statement of the rule is in words with no example, and correctly
  // contains no dash at all. Only the lines that SHOW the character are
  // asserted to keep it.
  const rules = all.filter((l) => l.includes('em-dash ('));
  assert.strictEqual(rules.length, 2,
    'expected the parenthetical example on both the p1 and p2 prompts, found ' + rules.length);
  for (const r of rules) {
    assert.ok(r.includes(EM) && r.includes(EN),
      'the rule says never use an em-dash (X) or an en-dash (Y) and the '
      + 'characters in the parentheses ARE the instruction. Stripping them to '
      + 'satisfy house style leaves the model told never to use nothing.');
  }
});
