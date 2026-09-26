// ════════════════════════════════════════════════════════════════════════════
// THE FIELD-REWRITE ROUTE, SECOND PASS (2026-10-02; Simon, 2026-09-26 00:18Z).
//
// The first dry run (2026-09-26) left Orchid's "higher-rated" against an equal or
// lower rating, and the check refused Bocanáriz and Streat Burger for two ranks
// in one sentence. Simon's three changes:
//   (1) the check accepts two NAMED lists in one sentence
//       ("#2 on <list A> and #62 of 3,523 on <list B>");
//   (2) rating comparisons: "higher-rated" never against an equal or lower
//       rating (Orchid 4.7: Bettys 4.6, Ascot House 4.7);
//   (3) two-list rank comparisons become percentiles or are dropped
//       (#95 of 117 is the bottom 19 percent; #287 of 3,501 is the top 9 percent).
// The rewrite's mechanical checks (lib-field-revisions.js rewriteProblems) let a
// rank pair go only as its percentile or not at all, and allow no other number
// in or out. Pure; nothing leaves the machine. Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { findContradictionsInText, findContradictions, rankPercentile, rankFacts, RATING_RULE, RANK_RULE } from '../lib-comparisons.js';
import { rewriteProblems } from '../lib-field-revisions.js';

const kinds = (t, o) => findContradictionsInText(t, o).map((f) => f.kind);

// ── (1) two NAMED lists ──────────────────────────────────────────────────────
test('(1) two ranks, each on a NAMED list, in one sentence: accepted', () => {
  assert.deepEqual(kinds('Bocanáriz ranks #2 in Santiago dining and #62 of 3,523 on the Tripadvisor Santiago list.'), []);
  assert.deepEqual(kinds('It is #2 on Google Maps Santiago and #62 of 3,523 on Tripadvisor.'), []);
});
test('(1, control) an UNNAMED second list is still flagged, as the stored Bocanáriz and Streat Burger sentences are', () => {
  assert.deepEqual(kinds('Bocanáriz ranks #2 in Santiago dining (4.5 rating, 8,285 reviews, #62 of 3,523 restaurants).'), ['two-ranks']);
  assert.deepEqual(kinds('The Las Condes location shows significantly lower rating (3.0 vs 3.9) and ranking (#95 of 117 vs #287 of 3,501).'), ['two-ranks']);
  assert.deepEqual(kinds('It is #2 on Tripadvisor and #5 on Tripadvisor.'), ['two-ranks'], 'the same list named twice is not two lists');
});

// ── (2) ratings ──────────────────────────────────────────────────────────────
const ORCHID = 'Risk: tier-matched upscale-casual restaurants like Yorkshire Tapas and Gianni\'s Brio (both 4.6/5) offer alternative occasions in the same price band, and higher-rated neighborhood competitors (Bettys 4.6 with 7112 reviews, Ascot House 4.7 with 354) may dilute share of the upscale leisure dinner occasion.';
test('(2) "higher-rated" against an equal or lower rating is flagged, given the subject\'s own rating', () => {
  assert.deepEqual(kinds(ORCHID, { subjectRating: 4.7 }), ['rating']);
});
test('(2, controls) a true "higher-rated" is not flagged; with no subject rating the rating check does not run', () => {
  assert.deepEqual(kinds('Direct conceptual competitors include Le Due Torri (4.6 rating, 1,042 reviews, higher-rated but smaller review base), Casaluz Restaurant (4.5 rating, 2,793 reviews, hospitality-forward).', { subjectRating: 4.5 }), []);
  assert.deepEqual(kinds(ORCHID), [], 'the render-time check has no stored subject rating and must not guess one');
  assert.deepEqual(findContradictions({ competitiveInsight: ORCHID }), []);
  assert.deepEqual(kinds('lower-rated rivals (Harvey\'s 4.8) crowd the street.', { subjectRating: 4.5 }), ['rating'], '"lower-rated" against a higher rating is flagged too');
});

// ── (3) percentiles ──────────────────────────────────────────────────────────
test('(3) a rank on a list of known size reads as a percentile: #95 of 117 is the bottom 19 percent, #287 of 3,501 the top 9 percent', () => {
  assert.equal(rankPercentile(95, 117).words, 'the bottom 19 percent');
  assert.equal(rankPercentile(287, 3501).words, 'the top 9 percent');
  assert.equal(rankPercentile(62, 3523).words, 'the top 2 percent');
  assert.equal(rankPercentile(1, 1), null, 'a list of one has no percentile');
  assert.deepEqual(rankFacts('ranking (#95 of 117 vs #287 of 3,501)').map((f) => f.rank + ' = ' + f.words),
    ['#95 of 117 = the bottom 19 percent', '#287 of 3,501 = the top 9 percent']);
});

// ── the rewrite's mechanical checks ──────────────────────────────────────────
const STREAT = 'The Las Condes location shows significantly lower rating (3.0 vs 3.9) and ranking (#95 of 117 vs #287 of 3,501). Conduct immediate operational audit.';
test('rewriteProblems: a rank pair may become its percentiles, and no other number may come or go', () => {
  assert.deepEqual(rewriteProblems(STREAT, 'The Las Condes location shows a lower rating (3.0 against 3.9) and sits in the bottom 19 percent of its list of 117, where the other sits in the top 9 percent of 3,501. Conduct immediate operational audit.'), []);
  assert.deepEqual(rewriteProblems(STREAT, 'The Las Condes location shows a lower rating (3.0 against 3.9). Conduct immediate operational audit.'), [], 'dropping the rank pair entirely is allowed');
  assert.match(rewriteProblems(STREAT, 'The Las Condes location shows a lower rating (3.0 against 3.9) and sits in the bottom 25 percent. Conduct immediate operational audit.').join(' '), /numbers added: 25/);
  assert.match(rewriteProblems(STREAT, 'The Las Condes location shows a lower rating (3.9) and sits in the bottom 19 percent. Conduct immediate operational audit.').join(' '), /numbers dropped: 3\.0/);
  assert.match(rewriteProblems(STREAT, STREAT).join(' '), /two-ranks/, 'an unchanged passage still fails the check');
});
test('rewriteProblems: with the subject rating it refuses a "higher-rated" against an equal or lower rating', () => {
  const after = ORCHID.replace('higher-rated neighborhood competitors', 'neighborhood competitors rated at or below Orchid');
  assert.deepEqual(rewriteProblems(ORCHID, after, { subjectRating: 4.7 }), []);
  assert.match(rewriteProblems(ORCHID, ORCHID, { subjectRating: 4.7 }).join(' '), /rating/);
});

test('the two new prompt lines exist, name the rule, and are not part of COMPARISON_RULE (delivery is unchanged)', async () => {
  const { COMPARISON_RULE } = await import('../lib-comparisons.js');
  assert.match(RATING_RULE, /^RATINGS, HARD RULE:/);
  assert.match(RANK_RULE, /^RANKINGS, HARD RULE:/);
  assert.ok(!COMPARISON_RULE.includes('RATINGS') && !COMPARISON_RULE.includes('percentile'));
});
