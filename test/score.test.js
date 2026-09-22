// ════════════════════════════════════════════════════════════════════════════
// THE OVERALL SCORE IS THE MEAN OF THE SIX PILLARS. COMPUTED, NOT TYPED.
//
// RVP's healthCheckScore is produced by the model in the SAME JSON object as
// the six pillars, and nothing has ever checked that it is the mean of them.
// It is not. Measured 2026-09-22 across the 103 stored reports that carry six
// pillars and a typed score:
//
//   typed is HIGHER than the mean of the pillars   102 of 103   99.0%
//   identical                                        1 of 103    1.0%
//   typed is LOWER                                   0 of 103    0.0%
//   median delta +7, mean delta +6.28, range 0 to +11
//
// ONE-DIRECTIONAL, WHICH IS WHAT SAYS IT IS NOT NOISE. A model rounding badly
// would miss both ways. This misses one way, every time.
//
// Worked example from the corpus, Teclados: pillars 66, 70, 42, 48, 58, 72
// sum to 356, divided by 6 is 59.333, so the score is 59. The report said 68.
//
// THE RULE. Round half UP on the mean of the six pillar scores, which is what
// SVP shipped as lib-pillars.js. Half up so that a reader who adds the six
// printed numbers and divides gets the printed total.
//
// NO FALLBACK. If the six pillars are not all there, there is NO SCORE. Falling
// back to the typed value would reintroduce the number this exists to replace,
// and would do it silently on exactly the payloads nobody looked at.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOverall, overallFormula, verdictFor, VERDICT_BANDS,
  OVERALL_METHOD_VERSION, PILLAR_KEYS, NO_SCORE_SENTENCE,
} from '../lib-score.js';

const six = (a, b, c, d, e, f) => ({
  cs: { score: a }, pa: { score: b }, es: { score: c },
  sm: { score: d }, cp: { score: e }, bg: { score: f },
});

// ── The arithmetic ────────────────────────────────────────────────────────

test('the worked example from the corpus', () => {
  // Teclados, 2026-05-18. The delivered report said 68.
  const r = computeOverall(six(66, 70, 42, 48, 58, 72));
  assert.equal(r.ok, true);
  assert.equal(r.sum, 356);
  assert.equal(r.score, 59, 'the stored report claimed 68 for these six pillars');
});

test('HALF GOES UP, not to even and not down', () => {
  // 80,80,80,83,83,83 sums to 489, over 6 is exactly 81.5.
  const r = computeOverall(six(80, 80, 80, 83, 83, 83));
  assert.equal(r.mean, 81.5);
  assert.equal(r.score, 82, 'a reader adding the six printed numbers would get 82');
});

test('a second exact half, to show the first was not a coincidence', () => {
  const r = computeOverall(six(70, 70, 70, 71, 71, 71));
  assert.equal(r.mean, 70.5);
  assert.equal(r.score, 71);
});

test('it does not round when it does not have to', () => {
  assert.equal(computeOverall(six(60, 60, 60, 60, 60, 60)).score, 60);
  assert.equal(computeOverall(six(0, 0, 0, 0, 0, 0)).score, 0);
  assert.equal(computeOverall(six(100, 100, 100, 100, 100, 100)).score, 100);
});

test('the six pillars are the six the report actually uses', () => {
  assert.deepEqual(PILLAR_KEYS, ['cs', 'pa', 'es', 'sm', 'cp', 'bg']);
});

// ── NO FALLBACK ───────────────────────────────────────────────────────────

test('A MISSING PILLAR MEANS NO SCORE, never the typed one', () => {
  const p = six(60, 60, 60, 60, 60, 60);
  delete p.es;
  const r = computeOverall(p, { healthCheckScore: 77 });
  assert.equal(r.ok, false);
  assert.equal(r.score, null, 'it fell back to a number it was told to ignore');
  assert.match(r.reason, /pillar/i);
});

test('a non-numeric pillar means no score', () => {
  for (const bad of [null, undefined, 'seventy', NaN, {}, []]) {
    const p = six(60, 60, 60, 60, 60, 60);
    p.sm.score = bad;
    const r = computeOverall(p);
    assert.equal(r.score, null, 'accepted a pillar score of ' + JSON.stringify(bad));
  }
});

test('an out-of-range pillar means no score', () => {
  // A score outside 0-100 is not a rounding question, it is a broken payload,
  // and averaging it would launder it into a plausible looking total.
  for (const bad of [-1, 101, 1000]) {
    const p = six(60, 60, 60, 60, 60, 60);
    p.cp.score = bad;
    assert.equal(computeOverall(p).score, null, 'accepted ' + bad);
  }
});

test('it never throws on rubbish', () => {
  for (const bad of [null, undefined, 0, '', [], {}, { cs: null }]) {
    assert.doesNotThrow(() => computeOverall(bad));
    assert.equal(computeOverall(bad).score, null);
  }
});

test('there is a sentence to print when there is no score', () => {
  assert.equal(typeof NO_SCORE_SENTENCE, 'string');
  assert.ok(NO_SCORE_SENTENCE.length > 20);
  assert.doesNotMatch(NO_SCORE_SENTENCE, /[–—]/, 'house style forbids en and em dashes');
});

// ── The formula, printed ──────────────────────────────────────────────────

test('THE FORMULA SHOWS ITS WORKING', () => {
  const r = computeOverall(six(66, 70, 42, 48, 58, 72));
  const f = overallFormula(r);
  assert.match(f, /66/); assert.match(f, /72/);
  assert.match(f, /356/, 'the sum is not shown');
  assert.match(f, /\b6\b/, 'the divisor is not shown');
  assert.match(f, /59/, 'the result is not shown');
});

test('the formula is arithmetic a reader can redo', () => {
  const r = computeOverall(six(80, 80, 80, 83, 83, 83));
  const f = overallFormula(r);
  // Every one of the six numbers, the sum, and the answer.
  for (const n of [80, 83, 489, 82]) assert.ok(f.includes(String(n)), 'missing ' + n);
});

test('no formula when there is no score', () => {
  assert.equal(overallFormula(computeOverall(null)), '');
});

test('the formula carries no dashes', () => {
  assert.doesNotMatch(overallFormula(computeOverall(six(66, 70, 42, 48, 58, 72))), /[–—]/);
});

// ── The bands ─────────────────────────────────────────────────────────────

test('the band table is the prompt own pillar cutoffs', () => {
  // The overall is now the mean of the pillars, so it lives on the pillar
  // scale, and that scale already has published numbers in the prompt:
  // good >= 65, warn 45 to 64, bad < 45.
  assert.deepEqual(VERDICT_BANDS.map(b => b.min), [80, 65, 45, 0]);
});

test('every band is reachable', () => {
  assert.equal(verdictFor(90), 'Excellent');
  assert.equal(verdictFor(70), 'Good');
  assert.equal(verdictFor(50), 'Fair');
  assert.equal(verdictFor(20), 'Needs Attention');
});

test('the boundaries belong to the band above', () => {
  assert.equal(verdictFor(80), 'Excellent');
  assert.equal(verdictFor(79), 'Good');
  assert.equal(verdictFor(65), 'Good');
  assert.equal(verdictFor(64), 'Fair');
  assert.equal(verdictFor(45), 'Fair');
  assert.equal(verdictFor(44), 'Needs Attention');
});

test('NO SCORE MEANS NO VERDICT', () => {
  for (const bad of [null, undefined, NaN, 'Good', {}]) {
    assert.equal(verdictFor(bad), null, 'invented a verdict for ' + JSON.stringify(bad));
  }
});

test('the method version names the rule and the product', () => {
  assert.equal(OVERALL_METHOD_VERSION, 'rvp-overall-mean-v1');
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: computeOverall CAN return a score, so the nulls mean something', () => {
  assert.equal(computeOverall(six(70, 70, 70, 70, 70, 70)).score, 70);
});

test('CONTROL: two different pillar sets give two different scores', () => {
  assert.notEqual(
    computeOverall(six(60, 60, 60, 60, 60, 60)).score,
    computeOverall(six(61, 61, 61, 61, 61, 61)).score);
});

test('CONTROL: the computed score DISAGREES with the typed one on real data', () => {
  // If these ever agreed on the whole corpus the change would be pointless.
  // Three rows lifted from the measurement, with the score the report printed.
  const corpus = [
    { pillars: six(78, 68, 50, 58, 72, 74), typed: 78, expect: 67 },  // Casa las Cuja
    { pillars: six(68, 62, 45, 58, 67, 72), typed: 72, expect: 62 },  // Lolita Jones
    { pillars: six(85, 78, 55, 48, 80, 83), typed: 82, expect: 72 },  // William & Victoria
  ];
  for (const c of corpus) {
    const r = computeOverall(c.pillars);
    assert.equal(r.score, c.expect);
    assert.notEqual(r.score, c.typed, 'the computed score matched the typed one');
  }
});

test('CONTROL: verdictFor can return something other than the first band', () => {
  const seen = new Set([90, 70, 50, 20].map(verdictFor));
  assert.equal(seen.size, 4, 'the band function collapses to fewer than four answers');
});
