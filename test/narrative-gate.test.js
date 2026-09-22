// ════════════════════════════════════════════════════════════════════════════
// THE NARRATIVE MUST NOT CONTRADICT THE COMPUTED BAND.
//
// The score is computed from the six pillars. The prose was written by a model
// that had been told the score was about seven points higher.
//
// THE FIGURES LIVE IN lib-narrative.js's HEADER, reconciled against the
// harness that first measured them, and are NOT repeated here. Two copies of
// a measurement drift, and this file would be the copy nobody reruns.
//
// The short version: 114 blocking contradictions over 105 stored reports, on
// 66 rows which are 49 distinct subject-and-score pairs, skewed 5 to 1 toward
// the higher band. That skew is what says it is real; a word list catching
// positive adjectives at random would miss both ways.
//
// SCOPED TO THE EXECUTIVE SUMMARY, and that scoping is the whole difference
// between a useful gate and a word counter. The first version of the harness
// read the entire page and reported 725 contradictions across 103 reports,
// flagging "Excellent service quality" in a STRENGTHS list and "the food is
// very good" in a CUSTOMER REVIEW QUOTE. A Fair report is SUPPOSED to contain
// some excellent things and several critical ones; that is what puts the
// average in the middle.
//
// THE SAME DETECTOR OVER SVP'S 49 STORED PAYLOADS SPLIT 27 HIGHER TO 27 LOWER,
// dead even, and every one of its twelve worst cases was an aspect claim
// rather than a verdict. That contrast is the strongest evidence the RVP
// finding is not an artefact of the word list.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { bandWordsIn, contradictsBand, retryInstruction, BAND_WORDS, NOT_A_VERDICT } from '../lib-narrative.js';

// ── It finds band words ───────────────────────────────────────────────────

test('it finds a word for each of the four bands', () => {
  assert.equal(bandWordsIn('The restaurant is excellent.')[0].band, 'Excellent');
  assert.equal(bandWordsIn('A strong operation.')[0].band, 'Good');
  assert.equal(bandWordsIn('Performance is mixed.')[0].band, 'Fair');
  assert.equal(bandWordsIn('Reviews are poor.')[0].band, 'Needs Attention');
});

test('it finds several in one sentence', () => {
  const hits = bandWordsIn('An excellent kitchen and a strong team.');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(h => h.word).sort(), ['excellent', 'strong']);
});

test('it finds nothing when there is nothing', () => {
  assert.deepEqual(bandWordsIn('The kitchen serves food to people who eat it.'), []);
  assert.deepEqual(bandWordsIn(''), []);
  assert.deepEqual(bandWordsIn(null), []);
});

// ── The exclusions ────────────────────────────────────────────────────────

test('A BAND WORD THAT IS NOT A VERDICT IS NOT COUNTED', () => {
  // Every one of these was observed in the live corpus.
  for (const s of [
    'They offer good value for money.',
    'That is good news for the owner.',
    'Good luck getting a table at the weekend.',
    'The average check is rising.',
    'Critical gaps are listed below.',
    'This is critically important.',
    'Its weakness is the wine list.',
  ]) {
    assert.deepEqual(bandWordsIn(s), [], 'flagged a non-verdict: ' + s);
  }
});

test('but the same word IS counted when it is a verdict', () => {
  // The exclusions must be phrase-scoped, not word-scoped, or the word list
  // would empty itself.
  assert.equal(bandWordsIn('The restaurant is good.').length, 1);
  assert.equal(bandWordsIn('Performance is critical.').length, 1);
});

// ── The contradiction rule ────────────────────────────────────────────────

test('A WORD NAMING ITS OWN BAND IS NEVER A CONTRADICTION', () => {
  const r = contradictsBand('The restaurant is good.', 'Good');
  assert.equal(r.contradicts, false);
  assert.equal(r.hits.length, 0);
});

test('a word naming a HIGHER band on a Fair report contradicts', () => {
  const r = contradictsBand('Farmshop delivers a strong farm to table experience.', 'Fair');
  assert.equal(r.contradicts, true);
  assert.equal(r.hits[0].band, 'Good');
  assert.equal(r.hits[0].direction, 'higher');
});

test('a word naming a LOWER band also contradicts, and says so', () => {
  const r = contradictsBand('The operation is weak.', 'Excellent');
  assert.equal(r.contradicts, true);
  assert.equal(r.hits[0].direction, 'lower');
});

test('ADJACENT BANDS COUNT. "Good" on a Fair report is the defect', () => {
  // It is the word the model would have used at the old inflated score, so
  // excusing one step would excuse the whole population.
  assert.equal(contradictsBand('A good restaurant.', 'Fair').contradicts, true);
});

test('NO BAND MEANS NO GATE, because there is nothing to contradict', () => {
  for (const b of [null, undefined, '', 'Nonsense']) {
    assert.equal(contradictsBand('The restaurant is excellent.', b).contradicts, false);
  }
});

test('it never throws', () => {
  for (const bad of [null, undefined, 0, [], {}]) {
    assert.doesNotThrow(() => contradictsBand(bad, 'Good'));
    assert.doesNotThrow(() => bandWordsIn(bad));
  }
});

test('the hit carries enough context to quote back to the model', () => {
  const r = contradictsBand('Farmshop delivers a strong farm to table experience.', 'Fair');
  assert.ok(r.hits[0].context.includes('strong'));
  assert.ok(r.hits[0].context.length > 10);
});

// ── The real corpus lines ─────────────────────────────────────────────────

test('THE THREE LIVE EXAMPLES FROM THE 2026-09-22 MEASUREMENT', () => {
  const cases = [
    ['Farmshop Marin delivers a strong farm to table California dining experience.', 'Fair', true],
    ['Polk State delivers exceptional value through low tuition.', 'Fair', true],
    ['The restaurant has real strengths and significant risks.', 'Fair', false],
  ];
  for (const [text, band, expect] of cases) {
    assert.equal(contradictsBand(text, band).contradicts, expect,
      JSON.stringify(text.slice(0, 40)) + ' at ' + band);
  }
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the detector CAN return true, so the false cases mean something', () => {
  assert.equal(contradictsBand('An excellent restaurant.', 'Needs Attention').contradicts, true);
});

test('CONTROL: and CAN return false on a page full of words', () => {
  const r = contradictsBand('A good, solid, healthy operation.', 'Good');
  assert.equal(r.contradicts, false, 'every Good word on a Good report must pass');
  assert.ok(r.hits.length === 0);
});

test('CONTROL: the vocabulary covers all four bands and the lists are non-empty', () => {
  assert.deepEqual(Object.keys(BAND_WORDS).sort(),
    ['Excellent', 'Fair', 'Good', 'Needs Attention']);
  for (const [band, words] of Object.entries(BAND_WORDS)) {
    assert.ok(words.length >= 3, band + ' has too few words to be a vocabulary');
  }
  assert.ok(NOT_A_VERDICT.length >= 10, 'the exclusion list is too short to have been tested');
});

test('CONTROL: an exclusion phrase actually appears in the exclusion list', () => {
  // Guards against the list being reordered into uselessness.
  assert.ok(NOT_A_VERDICT.includes('good value'));
  assert.ok(NOT_A_VERDICT.includes('average check'));
});

// ════════════════════════════════════════════════════════════════════════════
// v8.11.52: TWO LISTS, AND ONLY ONE OF THEM BLOCKS.
//
// Simon's decision: the delivery gate blocks on the four band names and their
// direct synonyms. Five words carried over from the SVP version of this gate
// (world class, robust, uneven, inconsistent, lagging) are REPORTED and never
// block, because they were never checked against the aspect-claim problem the
// way the blocking words were.
//
// A WORD THAT HAS NOT BEEN SHOWN TO DISCRIMINATE MUST NOT REFUSE A DELIVERY.
// ════════════════════════════════════════════════════════════════════════════

import { WARN_WORDS } from '../lib-narrative.js';

test('A WARNING WORD DOES NOT BLOCK', () => {
  const r = contradictsBand('The service is uneven across the week.', 'Excellent');
  assert.equal(r.contradicts, false, 'a warning word refused a delivery');
  assert.equal(r.hits.length, 0);
});

test('but it IS reported', () => {
  const r = contradictsBand('The service is uneven across the week.', 'Excellent');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].word, 'uneven');
  assert.equal(r.warnings[0].band, 'Fair');
});

test('all five demoted words warn and none of them blocks', () => {
  // EACH IS TESTED AGAINST A BAND IT DOES NOT NAME. The first version of this
  // used 'Fair' for all five, and 'uneven' and 'inconsistent' ARE Fair words,
  // so they correctly produced neither a block nor a warning and the test
  // failed on its own fixture. A word naming its own band is not a warning
  // either.
  const cases = [
    ['world class', 'Fair'], ['robust', 'Fair'],
    ['uneven', 'Excellent'], ['inconsistent', 'Excellent'],
    ['lagging', 'Excellent'],
  ];
  for (const [w, band] of cases) {
    const r = contradictsBand('The operation is ' + w + ' in every respect.', band);
    assert.equal(r.contradicts, false, w + ' blocked a delivery at ' + band);
    assert.ok(r.warnings.length >= 1, w + ' was not reported at ' + band);
  }
});

test('and a demoted word naming its OWN band is neither blocked nor warned', () => {
  const r = contradictsBand('The service is uneven.', 'Fair');
  assert.equal(r.contradicts, false);
  assert.equal(r.warnings.length, 0, 'it warned about a word naming its own band');
});

test('and a BLOCKING word still blocks, beside a warning word', () => {
  // Band Good, so 'poor' blocks (Needs Attention) and 'uneven' warns (Fair).
  // Neither names Good, so both are off-band and both are counted, each in
  // its own list.
  const r = contradictsBand('Poor consistency and uneven service.', 'Good');
  assert.equal(r.contradicts, true, 'the blocking word stopped blocking');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].word, 'poor');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].word, 'uneven');
});

test('the retry instruction quotes only the BLOCKING words', () => {
  const r = contradictsBand('An excellent kitchen with uneven service.', 'Good');
  const msg = retryInstruction(r);
  assert.match(msg, /"excellent"/);
  assert.doesNotMatch(msg, /uneven/, 'the retry asked the model to fix a warning');
});

test('CONTROL: the two lists do not overlap', () => {
  // A word in both would block and warn at once, and the counts would double
  // count it.
  const blocking = new Set(Object.values(BAND_WORDS).flat());
  for (const w of Object.values(WARN_WORDS).flat()) {
    assert.ok(!blocking.has(w), w + ' is in both lists');
  }
});

test('CONTROL: the warning list is the five words and no others', () => {
  assert.deepEqual(Object.values(WARN_WORDS).flat().sort(),
    ['inconsistent', 'lagging', 'robust', 'uneven', 'world class', 'world-class'].sort());
});

test('CONTROL: the blocking list is the one the measurement used', () => {
  // If this drifts, the figures in the header stop describing this code.
  assert.deepEqual(BAND_WORDS['Excellent'], ['excellent', 'exceptional', 'outstanding', 'superb']);
  assert.deepEqual(BAND_WORDS['Good'], ['good', 'strong', 'solid', 'healthy']);
});
