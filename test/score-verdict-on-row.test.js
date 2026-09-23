// ════════════════════════════════════════════════════════════════════════════
// THE BENCHMARK ROW'S VERDICT IS THE BAND OF ITS OWN SCORE.
//
// cohort_extra.score_verdict read report.scoreVerdict, a field the model was
// told to stop writing in b13449b. Measured on the live table 2026-09-23: 9
// rows under 8.11.52 and 12 under 8.11.53 carry null, while every one of them
// has a computed overall_score. Before that, 69 rows since 2026-09-22 carried
// the MODEL's verdict, 6 of which disagree with the band of their own score
// (overnight A4). Simon's decision: the row carries the computed band.
//
// THE RULE: whenever the row carries a score, score_verdict is
// verdictFor(overall_score). Null is impossible when a score exists. A verdict
// the model typed is never read.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictFor, VERDICT_BANDS } from '../lib-score.js';

process.env.PORT = '39263';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.BENCHMARK_WRITE_ENABLED = 'true';

const { __test__ } = await import('../server.js');
const { buildBenchmarkRow, benchmarkSkipReason } = __test__;

const pillars = (a, b, c, d, e, f) => ({
  cs: { score: a }, pa: { score: b }, es: { score: c },
  sm: { score: d }, cp: { score: e }, bg: { score: f },
});
const build = (report) => buildBenchmarkRow({
  report, name: 'A Restaurant', location: 'Santiago', country: 'Chile',
  region: null, focalContext: null, focalGeo: null, focalPlaceId: null,
});

test('a row with a score carries the band of that score', () => {
  // Don Antonio Ristorante, 2026-09-22: stored "Good", its own pillars mean 61.
  const row = build({ pillars: pillars(70, 66, 50, 48, 62, 70) });
  assert.equal(row.overall_score, 61);
  assert.equal(row.cohort_extra.score_verdict, 'Fair');
});

test('the verdict the model typed is never read', () => {
  const row = build({ scoreVerdict: 'Good', pillars: pillars(70, 66, 50, 48, 62, 70) });
  assert.equal(row.cohort_extra.score_verdict, 'Fair', 'the typed word reached the cohort');
});

test('a row written today, with no typed verdict at all, is not null', () => {
  // The 8.11.52 and 8.11.53 shape: no scoreVerdict on the report.
  const row = build({ pillars: pillars(89, 72, 58, 82, 91, 88) });
  assert.equal(row.overall_score, 80);
  assert.equal(row.cohort_extra.score_verdict, 'Excellent');
});

test('NULL IS IMPOSSIBLE WHEN A SCORE EXISTS, at every score from 0 to 100', () => {
  for (let s = 0; s <= 100; s++) {
    const row = build({ pillars: pillars(s, s, s, s, s, s) });
    assert.equal(row.overall_score, s);
    assert.notEqual(row.cohort_extra.score_verdict, null, 'null verdict at score ' + s);
    assert.equal(row.cohort_extra.score_verdict, verdictFor(s), 'wrong band at score ' + s);
  }
});

test('every band boundary lands on the band it names', () => {
  for (const b of VERDICT_BANDS) {
    const row = build({ pillars: pillars(b.min, b.min, b.min, b.min, b.min, b.min) });
    assert.equal(row.cohort_extra.score_verdict, b.name);
  }
});

test('no score, no verdict, and no row', () => {
  const row = build({ scoreVerdict: 'Good', pillars: { cs: { score: 70 } } });
  assert.equal(row.overall_score, null);
  assert.equal(row.cohort_extra.score_verdict, null, 'a verdict with no score to band');
  assert.ok(benchmarkSkipReason(row), 'a row with no score must be skipped, not written');
});

test('CONTROL: the fixture pillars do move the band', () => {
  // Without this the tests above could pass on a builder that returned one
  // constant band.
  const lo = build({ pillars: pillars(40, 40, 40, 40, 40, 40) }).cohort_extra.score_verdict;
  const hi = build({ pillars: pillars(90, 90, 90, 90, 90, 90) }).cohort_extra.score_verdict;
  assert.notEqual(lo, hi);
});
