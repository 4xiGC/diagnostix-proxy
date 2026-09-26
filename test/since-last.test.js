// ════════════════════════════════════════════════════════════════════════════
// "SINCE YOUR LAST REPORT" (2026-10-01, D2 of 2026-09-28, C2).
//
// One section, shown only when an EARLIER run of the same subject exists (same
// benchmarks.subject_key, the place id). Numbers are compared only when both runs
// record the SAME non-null scoring method: pillar by pillar, then and now, the
// change, and the band each sits in. A change is movement only above the
// measured same-method noise (RVP pillar p90 10, 2026-09-28 D2); smaller reads
// "within run-to-run range". Under different or unrecorded methods the section is
// ONE sentence saying so, with no numbers.
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { sinceLastModel, sinceLastHtml, RVP_PILLAR_NOISE } from '../lib-since-last.js';

process.env.PORT = '39737';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
const { __test__ } = await import('../server.js');

const P = (s, label) => ({ score: s, label, status: 'good' });
const PILLARS = { cs: P(82, 'Customer Sentiment'), pa: P(60, 'Pricing & Accessibility'), es: P(58, 'Employee Sentiment'), sm: P(40, 'Social Media Impact'), cp: P(70, 'Competitive Positioning'), bg: P(66, 'Brand Experience & Growth') };
const PREV = { pillar_scores: { cs: 70, pa: 66, es: 58, sm: 52, cp: 70, bg: 66 }, method_version: 'rvp-overall-mean-v1', created_at: '2026-06-01T10:00:00Z', subject_name: 'Orchid' };
const CUR = { pillars: PILLARS, methodVersion: 'rvp-overall-mean-v1', createdAt: '2026-09-20T10:00:00Z', name: 'Orchid' };

test('the noise floor is the measured RVP pillar p90', () => assert.equal(RVP_PILLAR_NOISE, 10));

test('SAME METHOD: deltas, bands, and movement only above the noise', () => {
  const m = sinceLastModel({ current: CUR, previous: PREV });
  assert.equal(m.comparable, true);
  const row = (k) => m.rows.find((r) => r.key === k);
  assert.deepEqual([row('cs').then, row('cs').now, row('cs').delta, row('cs').reading], [70, 82, 12, 'up']);
  assert.deepEqual([row('cs').bandThen, row('cs').bandNow], ['Good', 'Excellent']);
  assert.equal(row('pa').reading, 'within run-to-run range', 'a 6-point change is inside the noise');
  assert.equal(row('sm').reading, 'down');
  assert.equal(row('es').delta, 0);
});

test('A CHANGE OF EXACTLY THE NOISE IS NOT MOVEMENT', () => {
  const m = sinceLastModel({ current: CUR, previous: { ...PREV, pillar_scores: { ...PREV.pillar_scores, cp: 60 } } });
  assert.equal(m.rows.find((r) => r.key === 'cp').reading, 'within run-to-run range');
});

test('DIFFERENT METHODS: one sentence, no numbers', () => {
  const m = sinceLastModel({ current: { ...CUR, methodVersion: 'rvp-overall-mean-v2' }, previous: PREV });
  assert.equal(m.comparable, false);
  assert.equal(m.rows, undefined);
  const html = sinceLastHtml(m);
  assert.match(html, /scored under a different method/);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ''), /\d/, 'a number leaked into the methods-differ sentence');
});

test('AN UNRECORDED METHOD ON EITHER RUN IS NOT "THE SAME"', () => {
  assert.equal(sinceLastModel({ current: { ...CUR, methodVersion: null }, previous: PREV }).comparable, false);
  assert.equal(sinceLastModel({ current: CUR, previous: { ...PREV, method_version: null } }).comparable, false);
});

test('NO EARLIER RUN: no section', () => {
  assert.equal(sinceLastModel({ current: CUR, previous: null }), null);
  assert.equal(sinceLastHtml(null), '');
});

const render = (previousRun) => __test__.renderReportHtml({ subscriber: { restaurant_name: 'Orchid', location: 'Harrogate', email: 'x@example.org' },
  report: { pillars: PILLARS, executiveSummary: 'A summary.', benchmarkId: 'b-2' }, reportLabel: 'Full Report', previousRun });

test('THE PAGE: the section follows the pillar scores, and only when there is an earlier run', () => {
  const html = render({ current: { methodVersion: 'rvp-overall-mean-v1', createdAt: CUR.createdAt }, previous: PREV });
  const at = html.indexOf('<h2 class="rpt-h">Since your last report</h2>');
  assert.ok(at > html.indexOf('<h2 class="rpt-h">Pillar Scores</h2>'), 'the section is missing or above the pillar scores');
  assert.match(html.slice(at, at + 4000), /within run-to-run range/i);
  assert.equal(render(null).includes('Since your last report'), false);
});

// THE ROUTE: /report reads this run's benchmark row and the latest earlier row of the same subject.
async function get(row, bench) {
  const calls = [];
  const restore = __test__.setFetch(async (url) => {
    const u = decodeURIComponent(String(url)); calls.push(u);
    const body = u.includes('/rest/v1/subscribers') ? [row] : u.includes('id=eq.b-2') ? [bench.current] : u.includes('subject_key=eq.') ? (bench.earlier ? [bench.earlier] : []) : null;
    if (!body) throw new Error('unexpected fetch ' + u);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });
  const srv = __test__.app.listen(0);
  try { const r = await globalThis.fetch('http://127.0.0.1:' + srv.address().port + '/report?token=' + 'a'.repeat(32)); return { status: r.status, body: await r.text(), calls }; }
  finally { srv.close(); restore(); }
}
const ROW = { email: 'x@example.org', restaurant_name: 'Orchid', location: 'Harrogate', report_token: 'a'.repeat(32), plan_type: 'one_off',
  baseline_report: { pillars: PILLARS, executiveSummary: 'A summary.', benchmarkId: 'b-2' } };
const THIS_RUN = { id: 'b-2', subject_key: 'ChIJorchid', method_version: 'rvp-overall-mean-v1', created_at: '2026-09-20T10:00:00Z' };

test('THE ROUTE: an earlier same-subject run reaches the page', async () => {
  const r = await get(ROW, { current: THIS_RUN, earlier: PREV });
  assert.equal(r.status, 200);
  assert.match(r.body, /Since your last report/);
  assert.ok(r.calls.some((u) => u.includes('subject_key=eq.ChIJorchid') && u.includes('created_at=lt.2026-09-20T10:00:00Z')), 'the earlier-run query is not by subject and date');
});

test('THE ROUTE: no earlier run, no section; the page still renders', async () => {
  const r = await get(ROW, { current: THIS_RUN, earlier: null });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /Since your last report/);
  assert.match(r.body, /Pillar Scores/);
});

test('THE ROUTE: a report with no benchmark row makes no benchmark query', async () => {
  const row = { ...ROW, baseline_report: { pillars: PILLARS, executiveSummary: 'A summary.' } };
  const r = await get(row, { current: THIS_RUN, earlier: PREV });
  assert.equal(r.calls.filter((u) => u.includes('/benchmarks')).length, 0);
  assert.doesNotMatch(r.body, /Since your last report/);
});
