// ════════════════════════════════════════════════════════════════════════════
// rvp-overall-mean-v2: THE NO-DATA EMPLOYEE SENTIMENT 50 IS NOT AVERAGED IN
// (Simon, 2026-09-25, Q20).
//
// The report's own "Where you sit" says 50 on Employee Sentiment is "the value
// returned when no public employee signal exists". v1 averaged that 50 into
// the overall as though it were a measurement. v2 averages the five pillars
// that were measured, prints them, says in one sentence why Employee Sentiment
// is left out, and names the method. The page is rendered from stored pillars,
// so the change reaches stored reports; where the delivered number differs,
// the cover says it was revised and from what (the revision convention).
//
// Measured 2026-09-29 over 111 six-pillar stored reports: 19 at exactly 50;
// 2 bands move (Fair to Good, both the own test restaurant); 17 rise 1 to 2
// points within band.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOverall, computeOverallV1, overallFormula, OVERALL_METHOD_VERSION, ES_NO_SIGNAL } from '../lib-score.js';

process.env.PORT = '39272';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
const { __test__ } = await import('../server.js');

const six = (a, b, c, d, e, f) => ({
  cs: { score: a, label: 'Customer Sentiment', status: 'good' }, pa: { score: b, label: 'Pricing', status: 'good' },
  es: { score: c, label: 'Employee', status: 'warn' }, sm: { score: d, label: 'Social', status: 'warn' },
  cp: { score: e, label: 'Competitive', status: 'good' }, bg: { score: f, label: 'Brand', status: 'good' },
});
const render = (report) => __test__.renderReportHtml({
  subscriber: { restaurant_name: 'A Restaurant', location: 'Santiago' }, report, reportLabel: 'HealthCheck' });
const formulaBlock = (html) => (html.match(/<div class="score-formula">([\s\S]*?)<\/div>/) || [])[1] || '';

test('THE METHOD IS v2', () => {
  assert.equal(OVERALL_METHOD_VERSION, 'rvp-overall-mean-v2');
  assert.equal(ES_NO_SIGNAL, 50);
});

test('EMPLOYEE SENTIMENT AT EXACTLY 50 IS LEFT OUT: the mean of the five measured pillars', () => {
  // Casa las Cuja: 78 + 68 + 58 + 72 + 74 = 350, over 5 = 70 (v1 averaged the 50 in: 67).
  const r = computeOverall(six(78, 68, 50, 58, 72, 74));
  assert.equal(r.ok, true);
  assert.deepEqual(r.averaged, ['cs', 'pa', 'sm', 'cp', 'bg']);
  assert.deepEqual(r.excluded, ['es']);
  assert.equal(r.sum, 350);
  assert.equal(r.score, 70);
  assert.equal(computeOverallV1(six(78, 68, 50, 58, 72, 74)).score, 67, 'v1 is kept for the revision note');
});

test('any other Employee Sentiment is averaged in, as before', () => {
  for (const es of [49, 51, 0, 100]) {
    const r = computeOverall(six(78, 68, es, 58, 72, 74));
    assert.deepEqual(r.excluded, [], 'excluded at ' + es);
    assert.equal(r.score, computeOverallV1(six(78, 68, es, 58, 72, 74)).score);
  }
});

test('the formula shows the pillars actually averaged, and not the 50', () => {
  const f = overallFormula(computeOverall(six(78, 68, 50, 58, 72, 74)));
  assert.equal(f, '78 + 68 + 58 + 72 + 74 = 350, divided by 5 = 70, rounded to 70');
});

test('THE COVER: five pillars, one plain sentence why, the method named, and the revision', () => {
  const block = formulaBlock(render({ pillars: six(78, 68, 50, 58, 72, 74), executiveSummary: 'A summary.' }));
  assert.match(block, /78 \+ 68 \+ 58 \+ 72 \+ 74 = 350, divided by 5 = 70/);
  assert.ok(block.includes('Employee Sentiment is not averaged in: no public employee signal was found, and 50 is the value given when there is none.'), 'the why sentence is missing');
  assert.match(block, /Method rvp-overall-mean-v2/);
  assert.ok(block.includes('Revised 25 September 2026: this report first showed an overall score of 67, which averaged in that 50.'), 'the revision note is missing');
  assert.doesNotMatch(block, /[–—]/);
});

test('with a measured Employee Sentiment: six pillars, no why sentence, no revision note', () => {
  const block = formulaBlock(render({ pillars: six(66, 70, 42, 48, 58, 72), executiveSummary: 'A summary.' }));
  assert.match(block, /divided by 6/);
  assert.doesNotMatch(block, /not averaged in|Revised 25 September/);
  assert.match(block, /Method rvp-overall-mean-v2/);
});

test('excluded but the same rounded number: the why sentence, and no revision note', () => {
  // 60,60,50,60,60,60: v1 = 350/6 = 58.3 -> 58; v2 = 300/5 = 60. Different, so pick a set where they agree:
  // 51,50,50,50,50,50 -> v1 301/6 = 50.2 -> 50; v2 251/5 = 50.2 -> 50.
  const block = formulaBlock(render({ pillars: six(51, 50, 50, 50, 50, 50), executiveSummary: 'A summary.' }));
  assert.match(block, /not averaged in/);
  assert.doesNotMatch(block, /Revised 25 September/, 'a revision note for a number that did not change');
});

test('CONTROL: the revision detector finds the note when it is present', () => {
  assert.ok(formulaBlock(render({ pillars: six(78, 68, 50, 58, 72, 74), executiveSummary: 'A summary.' })).indexOf('Revised 25 September 2026') >= 0);
});

// THE SHARED v2 TABLE. An identical table is in diagnostix-analytics
// test/peer-scores.test.js (overallFromPillars); a change to either rule turns
// one of the two suites red. Five-pillar sums never land on an exact half (a
// fifth is .0, .2, .4, .6 or .8), so the half-up rows are all six-pillar.
export const SHARED_V2_TABLE = [
  { pillars: [66, 70, 42, 48, 58, 72], expect: 59 },   // Teclados, six measured
  { pillars: [80, 80, 80, 83, 83, 83], expect: 82 },   // exact .5, UP
  { pillars: [70, 70, 70, 71, 71, 71], expect: 71 },   // exact .5 again
  { pillars: [78, 68, 50, 58, 72, 74], expect: 70 },   // Casa las Cuja, es 50 left out (v1 67)
  { pillars: [85, 78, 55, 48, 80, 83], expect: 72 },   // William & Victoria, es 55 averaged in
  { pillars: [60, 62, 50, 64, 66, 67], expect: 64 },   // es 50 left out: 319/5 = 63.8 (v1 369/6 = 61.5, 62)
  { pillars: [0, 0, 50, 0, 0, 0], expect: 0 },         // es 50 left out (v1 8)
];

test('THE SHARED v2 TABLE, value for value', () => {
  const keys = ['cs', 'pa', 'es', 'sm', 'cp', 'bg'];
  for (const row of SHARED_V2_TABLE) {
    const p = {}; keys.forEach((k, i) => { p[k] = { score: row.pillars[i] }; });
    assert.equal(computeOverall(p).score, row.expect, row.pillars.join(','));
  }
});
