// ════════════════════════════════════════════════════════════════════════════
// "HOW THIS REPORT WAS BUILT" (2026-10-01, recommendation 10, C1).
//
// The standard (SUBJECT_INTEGRITY_STANDARD.md 6.2): seven sections, the same
// headings in the same order in all three products, every value read from what
// the run stored. A value the run did not store reads "not recorded for this
// report" and is never estimated. The page is the report's LAST section and a
// standalone route on the same token, with the same access as the report.
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { proofPageModel, proofPageHtml, PROOF_HEADINGS, NOT_RECORDED } from '../lib-proof-page.js';

process.env.PORT = '39735';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
const { __test__ } = await import('../server.js');

const P = (s, label) => ({ score: s, label, status: 'good' });
const FULL = {
  pillars: { cs: P(70, 'Customer Sentiment'), pa: P(66, 'Pricing & Accessibility'), es: P(60, 'Employee Sentiment'), sm: P(58, 'Social Media Impact'), cp: P(72, 'Competitive Positioning'), bg: P(68, 'Brand Experience & Growth') },
  executiveSummary: 'A summary.',
  actions: [{ priority: 'urgent', title: 'Fix pacing', desc: 'Reviews mention long waits.' }],
  subject: { name: 'Orchid Restaurant', typedName: 'The Orchid', placeId: 'ChIJxyz' },
  evidence: { searchesRun: 9, resultsReturned: 87, resultsRead: 72, distinctSites: 29, reviewsTotal: 10461, sourcesCounted: 4, reviewsSentence: 'x' },
  coverage: { state: 'pass', subjectReviewCount: 648 },
  summaryGate: 'accepted-attempt-1',
  _debug: { version: '8.11.60', totalMs: 38400, googlePlaces: { count: 20, peersUnresolved: 0 } },
  provenance: {
    methodVersion: 'rvp-overall-mean-v2', durationMs: 38400, writtenAt: '2026-10-02T10:00:00Z',
    confidence: { level: 'standard', basis: 'coverage pass: 648 Google reviews, the rule met' },
    passes: [
      { label: 'diagnose-p1', model: 'claude-sonnet-4-5-20250929', promptVersion: 'p1-2026-09-29-0ced20243c98', inputTokens: 9000, outputTokens: 900 },
      { label: 'diagnose-p2', model: 'claude-haiku-4-5-20251001', promptVersion: 'p2-2026-10-01-plan-flag-8b25ce616f9e', inputTokens: 12000, outputTokens: 2500 },
    ],
  },
  meta: { executiveSummaryReplacedAt: '2026-09-25T14:00:00Z' },
};
const valuesOf = (m) => m.sections.flatMap((s) => s.rows.map((r) => r.value));

test('THE SEVEN SECTIONS, IN THE STANDARD\'S ORDER', () => {
  assert.deepEqual(PROOF_HEADINGS, ['What was assessed', 'What we read', 'Coverage', 'How it was scored', 'What was checked before you saw it', 'Confidence', 'Revision notes']);
  assert.deepEqual(proofPageModel(FULL, {}).sections.map((s) => s.heading), PROOF_HEADINGS);
  assert.deepEqual(proofPageModel({}, {}).sections.map((s) => s.heading), PROOF_HEADINGS);
});

test('a full payload: every value comes from its stored field', () => {
  const m = proofPageModel(FULL, { restaurantName: 'Orchid Restaurant', revisionNotes: ['The executive summary on this page was rewritten on 2026-09-25.'] });
  const t = JSON.stringify(m);
  for (const v of ['Orchid Restaurant', 'The Orchid', '9', '87', '72', '29', '648', 'rvp-overall-mean-v2', '8.11.60', 'claude-haiku-4-5-20251001',
    'p2-2026-10-01-plan-flag-8b25ce616f9e', '38 seconds', 'standard', 'rewritten on 2026-09-25']) assert.ok(t.includes(v), v + ' is missing');
  assert.ok(t.includes('9,813'), 'the peers\' reviews are shown apart from the restaurant\'s own (10,461 - 648)');
});

test('AN EMPTY PAYLOAD: every value reads "not recorded for this report", nothing is estimated', () => {
  const m = proofPageModel({}, { restaurantName: 'X' });
  // Two rows are not read from the payload and say so: the name on the row, and the
  // scoring method the page applies when shown (labelled as applied, not stored).
  const vals = m.sections.flatMap((s) => s.rows).filter((r) => r.label !== 'Name on this report' && r.label !== 'Method used for the score on this page').map((r) => r.value);
  assert.ok(vals.length >= 12, 'too few rows to mean anything: ' + vals.length);
  for (const v of vals) assert.ok(v === NOT_RECORDED || /^None recorded/.test(v), 'estimated or blank value: ' + JSON.stringify(v));
  const html = proofPageHtml(m);
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]|>null</);
});

test('a limited run and a run with no confidence stored: confidence comes from the stored coverage state, said so', () => {
  const m = proofPageModel({ coverage: { state: 'limited', subjectReviewCount: 120 } }, {});
  const conf = m.sections.find((s) => s.heading === 'Confidence');
  assert.match(JSON.stringify(conf), /limited/);
  assert.match(JSON.stringify(conf), /derived from the coverage state/);
});

test('the page escapes what it prints', () => {
  const html = proofPageHtml(proofPageModel({ subject: { name: '<script>x</script>' } }, {}));
  assert.doesNotMatch(html, /<script>x/);
});

const render = (r) => __test__.renderReportHtml({ subscriber: { restaurant_name: 'Orchid Restaurant', location: 'Harrogate', email: 'x@example.org' }, report: r, reportLabel: 'Full Report' });

test('THE REPORT: "How this report was built" is the LAST section, and it starts a new printed page', () => {
  const html = render(FULL);
  const at = html.indexOf('class="proof-page"');
  assert.ok(at > 0, 'the proof page is not on the report');
  assert.equal(html.indexOf('<h2 class="rpt-h">', html.indexOf('</h2>', html.indexOf('How this report was built', at))), -1, 'a section follows the proof page');
  assert.match(html, /\.proof-page\{[^}]*page-break-before:always/);
  assert.match(html.slice(at), /The executive summary on this page was rewritten/, 'the page\'s own revision note did not reach the proof page');
});

test('CONTROL: a report with no payload fields still renders the page, all "not recorded"', () => {
  const html = render({ pillars: FULL.pillars, executiveSummary: 'A summary.' });
  const at = html.indexOf('class="proof-page"');
  assert.ok(at > 0);
  assert.ok((html.slice(at).match(/not recorded for this report/g) || []).length >= 10);
});

// THE STANDALONE ROUTE, through the real app, the store replaced.
async function get(pathAndQuery, row) {
  const restore = __test__.setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/subscribers')) return { ok: true, status: 200, json: async () => (row ? [row] : []), text: async () => JSON.stringify(row ? [row] : []) };
    throw new Error('unexpected fetch ' + u);
  });
  const srv = __test__.app.listen(0);
  try {
    const port = srv.address().port;
    const r = await globalThis.fetch('http://127.0.0.1:' + port + pathAndQuery);
    return { status: r.status, body: await r.text() };
  } finally { srv.close(); restore(); }
}
const ROW = { email: 'x@example.org', restaurant_name: 'Orchid Restaurant', location: 'Harrogate', report_token: 'a'.repeat(32), plan_type: 'one_off', baseline_report: FULL };

test('THE ROUTE /report/built: the same token, the proof page alone', async () => {
  const r = await get('/report/built?token=' + 'a'.repeat(32), ROW);
  assert.equal(r.status, 200);
  assert.match(r.body, /How this report was built/);
  assert.match(r.body, /class="proof-page"/);
  assert.doesNotMatch(r.body, /What to do first/, 'the standalone route served the whole report');
});

test('THE ROUTE: the same access as the report (a malformed token is 400, an unknown one 404)', async () => {
  assert.equal((await get('/report/built?token=short', ROW)).status, 400);
  assert.equal((await get('/report/built?token=' + 'b'.repeat(32), null)).status, 404);
});

test('CONTROL: /report still serves the whole report on the same token', async () => {
  const r = await get('/report?token=' + 'a'.repeat(32), ROW);
  assert.equal(r.status, 200);
  assert.match(r.body, /What to do first/);
  assert.match(r.body, /class="proof-page"/);
});
