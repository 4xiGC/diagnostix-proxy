// ════════════════════════════════════════════════════════════════════════════
// THE score_verdict BACKFILL PLAN: WHICH ROWS, WHAT VALUE, AND THE OLD TEXT KEPT.
//
// Simon's decisions of 2026-09-23: fill the null rows from their own computed
// score; recompute the 69 rows since 2026-09-22 that carry the model's verdict;
// preserve the old text. The plan is a pure function so it can be tested; the
// two scripts in scripts/ only read, plan, audit and print (and write only
// with --write, which the overnight session never passes).
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { planVerdictBackfill } from '../scripts/lib-verdict-backfill.mjs';

const row = (id, created, verdict, p, extra = {}) => ({
  id, created_at: created, subject_name: 'R ' + id, overall_score: null,
  pillar_scores: { cs: p, pa: p, es: p, sm: p, cp: p, bg: p },
  cohort_extra: Object.assign({ location_raw: 'Santiago', score_verdict: verdict }, extra),
});

test('NULL-FILL: a null row gets the band of its own pillar mean', () => {
  const plan = planVerdictBackfill([row('a', '2026-09-23T12:27:00Z', null, 69)], { mode: 'null-fill' });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].next, 'Good');
  assert.equal(plan[0].old, null);
});

test('NULL-FILL leaves rows that already carry text alone', () => {
  const plan = planVerdictBackfill([row('a', '2026-09-22T11:01:00Z', 'Good', 61)], { mode: 'null-fill' });
  assert.equal(plan.length, 0);
});

test('RECOMPUTE: a text row since the cutoff whose word disagrees with its band changes', () => {
  // Don Antonio Ristorante, 2026-09-22: stored Good, pillar mean 61.
  const plan = planVerdictBackfill([row('a', '2026-09-22T11:01:00Z', 'Good', 61)], { mode: 'recompute', since: '2026-09-22T00:00:00Z' });
  assert.equal(plan.length, 1);
  assert.deepEqual([plan[0].old, plan[0].next], ['Good', 'Fair']);
});

test('RECOMPUTE: a row that already agrees is not touched', () => {
  const plan = planVerdictBackfill([row('a', '2026-09-22T11:01:00Z', 'Good', 70)], { mode: 'recompute', since: '2026-09-22T00:00:00Z' });
  assert.equal(plan.length, 0);
});

test('RECOMPUTE respects the cutoff: an older row is out of the decided scope', () => {
  // Boragó, 2026-08-31: stored Good, pillar mean 64. It would change, and it is
  // NOT in the 69 Simon decided on.
  const plan = planVerdictBackfill([row('a', '2026-08-31T17:31:00Z', 'Good', 64)], { mode: 'recompute', since: '2026-09-22T00:00:00Z' });
  assert.equal(plan.length, 0);
});

test('RECOMPUTE WITH NO CUTOFF IS THE WHOLE TABLE, one rule (Simon, 2026-09-24, Q4)', () => {
  const plan = planVerdictBackfill([row('a', '2026-08-31T17:31:00Z', 'Good', 64), row('b', '2026-09-22T11:01:00Z', 'Good', 61)],
    { mode: 'recompute', since: null });
  assert.deepEqual(plan.map((p) => p.id), ['a', 'b']);
});

test('THE OLD TEXT IS KEPT, and every other cohort_extra key survives the patch', () => {
  const [p] = planVerdictBackfill([row('a', '2026-09-22T11:01:00Z', 'Good', 61, { cuisine_detected: 'Italian' })],
    { mode: 'recompute', since: '2026-09-22T00:00:00Z' });
  assert.equal(p.patch.cohort_extra.score_verdict, 'Fair');
  assert.equal(p.patch.cohort_extra.score_verdict_model, 'Good');
  assert.equal(p.patch.cohort_extra.location_raw, 'Santiago', 'a jsonb PATCH replaces the column: every key must be carried');
  assert.equal(p.patch.cohort_extra.cuisine_detected, 'Italian');
});

test('THE WRITE IS GUARDED on the value that was read', () => {
  const [a] = planVerdictBackfill([row('a', '2026-09-23T12:27:00Z', null, 69)], { mode: 'null-fill' });
  const [b] = planVerdictBackfill([row('b', '2026-09-22T11:01:00Z', 'Good', 61)], { mode: 'recompute', since: '2026-09-22T00:00:00Z' });
  assert.equal(a.guard, 'cohort_extra->>score_verdict=is.null');
  assert.equal(b.guard, 'cohort_extra->>score_verdict=eq.Good');
});

test('a row whose old text is already preserved is never planned twice', () => {
  const plan = planVerdictBackfill([row('a', '2026-09-22T11:01:00Z', 'Fair', 61, { score_verdict_model: 'Good' })],
    { mode: 'recompute', since: '2026-09-22T00:00:00Z' });
  assert.equal(plan.length, 0);
});

test('a row without six pillars is skipped and says why, never guessed', () => {
  const r = row('a', '2026-09-23T12:27:00Z', null, 69);
  delete r.pillar_scores.bg;
  const plan = planVerdictBackfill([r], { mode: 'null-fill' });
  assert.equal(plan.length, 0);
  const skipped = planVerdictBackfill.lastSkipped;
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /pillar-missing:bg/);
});

test('an unknown mode is refused', () => {
  assert.throws(() => planVerdictBackfill([], { mode: 'everything' }), /mode/);
});
