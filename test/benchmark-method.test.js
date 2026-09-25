// ════════════════════════════════════════════════════════════════════════════
// A BENCHMARK ROW SAYS HOW ITS SCORE WAS ARRIVED AT.
//
// `benchmarks` is shared by EVP, SVP and RVP, and migration 011 added
// method_version for exactly this. Its own column comment, read from the live
// schema on 2026-09-22:
//
//   "NULL MEANS MODEL-TYPED: the number came from the model's own overall.score
//    field. A non-null value names the code path that computed it. Typed and
//    computed scores are DIFFERENT MEASUREMENTS and do not agree. Any median,
//    ranking or distribution over this table should filter to a single value of
//    this column, or state that it mixes methods."
//
// Today, measured from the live table: rvp/NULL 308, evp/NULL 103, svp/NULL 16,
// svp/svp-overall-mean-v1 1, svp/svp-overall-mean-v2 1. Every RVP row in the
// table is model-typed and says so correctly. From this release they are
// computed, and must say THAT.
//
// IF THEY DID NOT, 308 typed rows and every future computed row would average
// together in one cohort, and the computed ones run about 6 points lower. The
// cohort average would drift downward for a reason no query could see.
//
// WHEN THERE IS NO COMPUTED SCORE, NO ROW IS WRITTEN. overall_score is NOT
// NULL on this table, so the choice is between skipping and inventing, and
// benchmarkSkipReason already skips on a null score. Writing the typed value
// instead would put the number the release exists to replace back into the
// cohort under a NULL method_version, which is honest labelling of a number
// the product itself refuses to show.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERALL_METHOD_VERSION } from '../lib-score.js';

process.env.PORT = '39261';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
// BENCHMARK_ENABLED is a module-level const read at import, and
// benchmarkSkipReason checks capture_disabled FIRST. Without this the skip
// tests below pass for the wrong reason: they would read 'capture_disabled'
// and never reach the no_score guard they exist to test. Found by the control
// that asserts a row CAN be written.
process.env.BENCHMARK_WRITE_ENABLED = 'true';

const { __test__ } = await import('../server.js');
const { buildBenchmarkRow, benchmarkSkipReason } = __test__;

const pillars = (a, b, c, d, e, f) => ({
  cs: { score: a, label: 'Customer Sentiment', status: 'good' },
  pa: { score: b, label: 'Pricing', status: 'good' },
  es: { score: c, label: 'Employee', status: 'warn' },
  sm: { score: d, label: 'Social', status: 'warn' },
  cp: { score: e, label: 'Competitive', status: 'good' },
  bg: { score: f, label: 'Brand', status: 'good' },
});

const build = (report) => buildBenchmarkRow({
  report, name: 'A Restaurant', location: 'Santiago', country: 'Chile',
  region: null, focalContext: null, focalGeo: null, focalPlaceId: null,
});

// ── The score on the row is the computed one ──────────────────────────────

test('THE ROW CARRIES THE COMPUTED SCORE, not the typed one', () => {
  // Teclados: the delivered report said 68, the six pillars average 59.333.
  const row = build({ healthCheckScore: 68, pillars: pillars(66, 70, 42, 48, 58, 72) });
  assert.equal(row.overall_score, 59, 'the cohort would have taken the typed 68');
});

test('and it NAMES the method', () => {
  const row = build({ healthCheckScore: 68, pillars: pillars(66, 70, 42, 48, 58, 72) });
  assert.equal(row.method_version, OVERALL_METHOD_VERSION);
  assert.equal(row.method_version, 'rvp-overall-mean-v2');   // v2 from 2026-09-25 (Q20)
});

test('the method version is not the one SVP uses', () => {
  // One shared table, three products. A row that borrowed SVP's label would
  // make a filtered query silently mix two products' arithmetic.
  const row = build({ healthCheckScore: 70, pillars: pillars(70, 70, 70, 70, 70, 70) });
  assert.doesNotMatch(String(row.method_version), /^svp-/);
  assert.match(String(row.method_version), /^rvp-/);
});

test('an exact half rounds up on the row too', () => {
  const row = build({ healthCheckScore: 90, pillars: pillars(80, 80, 80, 83, 83, 83) });
  assert.equal(row.overall_score, 82);
});

// ── No computed score means no row ────────────────────────────────────────

test('A MISSING PILLAR MEANS NO SCORE ON THE ROW', () => {
  const p = pillars(60, 60, 60, 60, 60, 60);
  delete p.sm;
  const row = build({ healthCheckScore: 77, pillars: p });
  assert.equal(row.overall_score, null,
    'the typed 77 was written into the cohort for a report that shows no score');
});

test('and that row is SKIPPED, not written', () => {
  const p = pillars(60, 60, 60, 60, 60, 60);
  delete p.sm;
  assert.equal(benchmarkSkipReason(build({ healthCheckScore: 77, pillars: p })), 'no_score');
});

test('a report with no pillars at all is skipped', () => {
  assert.equal(benchmarkSkipReason(build({ healthCheckScore: 70 })), 'no_score');
  assert.equal(benchmarkSkipReason(build({ healthCheckScore: 70, pillars: {} })), 'no_score');
});

test('the method version is NULL when nothing was computed', () => {
  // Not the label on a row that has no computed score: NULL means model-typed
  // and this is neither, but a labelled row that is never written is less
  // misleading than a label claiming a computation that did not happen.
  const row = build({ healthCheckScore: 70, pillars: {} });
  assert.equal(row.method_version, null);
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: a row CAN be built and written, so the skips mean something', () => {
  const row = build({ healthCheckScore: 70, pillars: pillars(70, 70, 70, 70, 70, 70) });
  assert.equal(benchmarkSkipReason(row), null, 'nothing can ever be written');
  assert.equal(row.overall_score, 70);
});

test('CONTROL: the computed and typed scores differ on the row used above', () => {
  const row = build({ healthCheckScore: 68, pillars: pillars(66, 70, 42, 48, 58, 72) });
  assert.notEqual(row.overall_score, 68,
    'the two numbers agree here, so this file proves nothing about which was used');
});

test('CONTROL: pillar_scores still carries the six, so the row is self-checking', () => {
  const row = build({ healthCheckScore: 68, pillars: pillars(66, 70, 42, 48, 58, 72) });
  assert.ok(row.pillar_scores && typeof row.pillar_scores === 'object');
  const vals = Object.values(row.pillar_scores).filter(v => typeof v === 'number');
  assert.equal(vals.length, 6, 'a reader cannot recompute overall_score from this row');
  assert.equal(vals.reduce((a, b) => a + b, 0), 356);
});
