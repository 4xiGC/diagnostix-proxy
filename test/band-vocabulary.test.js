// THE BAND VOCABULARY SHIP GATE.
//
// Fixtures are VERBATIM markup from the live corpus, copied out of stored
// `baseline_report.peerComparisonHtml` on 2026-09-23, not written from the
// renderer's source. A detector tuned against the source it is supposed to
// police passes on markup no page ever produced.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  FOUR_BAND_WORDS, SIX_BAND_WORDS, FAMILY_SIZE,
  familyOf, scanBandCells, vocabularyFindings, describeFindings,
} from '../lib-vocab.js';

// General Tarleton Inn, row e1b501ce, as the customer has it now.
const REAL_SIX = `<table class="report"><tbody>
<tr><td class="subject">Customer Sentiment</td><td class="num"><strong>72</strong></td><td>Strong <span class="muted">(band 5 of 6)</span></td><td class="num">1</td><td class="num">3</td><td class="num">0</td></tr>
<tr><td class="subject">Pricing and Accessibility</td><td class="num"><strong>65</strong></td><td>Solid <span class="muted">(band 4 of 6)</span></td><td class="num">4</td><td class="num">0</td><td class="num">0</td></tr>
<tr><td class="subject">Social Media Impact</td><td class="num"><strong>74</strong></td><td>Strong <span class="muted">(band 5 of 6)</span></td><td class="num">0</td><td class="num">1</td><td class="num">3</td></tr>
</tbody></table>`;

// The same subject, as the B5.1 rebuild renders it.
const REAL_FOUR = `<table class="report"><tbody>
<tr><td class="subject">Customer Sentiment</td><td class="num"><strong>72</strong></td><td>Good <span class="muted">(band 3 of 4)</span></td><td class="num">3</td><td class="num">1</td><td class="num">0</td></tr>
<tr><td class="subject">Pricing and Accessibility</td><td class="num"><strong>65</strong></td><td>Good <span class="muted">(band 3 of 4)</span></td><td class="num">0</td><td class="num">4</td><td class="num">0</td></tr>
<tr><td class="subject">Social Media Impact</td><td class="num"><strong>74</strong></td><td>Good <span class="muted">(band 3 of 4)</span></td><td class="num">0</td><td class="num">1</td><td class="num">3</td></tr>
</tbody></table>`;

// A whole report's cover verdict. FOUR-BAND WORDS IN PROSE, no band cell.
// This is why the detector is scoped to cells: every RVP report contains
// these words already and always has.
const COVER_PROSE = `<div class="cover-verdict">GOOD</div>
<p>This business is in good standing overall, with a fair result on pricing
and an excellent showing on brand. Critical gaps are listed below.</p>`;

test('the two word lists are DISJOINT, asserted rather than assumed', () => {
  const both = FOUR_BAND_WORDS.filter((w) => SIX_BAND_WORDS.includes(w));
  assert.deepStrictEqual(both, [],
    'a word in both lists makes familyOf() return whichever list is checked '
    + 'first, and every finding downstream is then decided by list order');
  for (const w of FOUR_BAND_WORDS) assert.strictEqual(familyOf(w), 'four');
  for (const w of SIX_BAND_WORDS) assert.strictEqual(familyOf(w), 'six');
});

test('REAL stored markup is read: six coherent cells, flagged as coherent', () => {
  const cells = scanBandCells(REAL_SIX);
  assert.strictEqual(cells.length, 3, 'the real six-band fixture must yield 3 cells');
  assert.deepStrictEqual(cells.map((c) => c.word), ['Strong', 'Solid', 'Strong']);
  assert.deepStrictEqual(cells.map((c) => c.of), [6, 6, 6]);
  const f = vocabularyFindings(REAL_SIX);
  assert.strictEqual(f.ok, true, describeFindings(f));
  assert.deepStrictEqual(f.families, ['six']);
});

test('REAL rebuilt markup is read: four coherent cells, flagged as coherent', () => {
  const f = vocabularyFindings(REAL_FOUR);
  assert.strictEqual(f.cells, 3);
  assert.deepStrictEqual(f.families, ['four']);
  assert.strictEqual(f.ok, true, describeFindings(f));
});

// ── THE DOCTORED CONTROLS ─────────────────────────────────────────────────

test('DOCTORED: a four-band word carrying a six-band denominator is CAUGHT', () => {
  // This is the half-migration: the words were substituted in the stored
  // markup and the denominator, and the counts behind it, were left alone.
  const doctored = REAL_SIX.replace('Strong <span class="muted">(band 5 of 6)',
                                    'Good <span class="muted">(band 5 of 6)');
  assert.notStrictEqual(doctored, REAL_SIX, 'the doctoring must actually change the fixture');
  const f = vocabularyFindings(doctored);
  assert.strictEqual(f.ok, false, 'a four-band word with "of 6" must not pass');
  assert.strictEqual(f.mixedFamilies, true);
  assert.ok(f.mismatched.some((m) => m.word === 'Good' && m.of === 6 && m.expected === 4),
    'the finding must name the word and both numbers: ' + JSON.stringify(f.mismatched));
});

test('DOCTORED: a six-band word carrying a four-band denominator is CAUGHT', () => {
  const doctored = REAL_FOUR.replace('Good <span class="muted">(band 3 of 4)',
                                     'Solid <span class="muted">(band 3 of 4)');
  const f = vocabularyFindings(doctored);
  assert.strictEqual(f.ok, false);
  assert.ok(f.mismatched.some((m) => m.word === 'Solid' && m.of === 4 && m.expected === 6),
    JSON.stringify(f.mismatched));
});

test('DOCTORED: the two vocabularies never coexist on one page', () => {
  // A partial rebuild: some rows re-rendered, some left behind. Every cell is
  // internally consistent, so neither "mismatched" nor "out of range" fires.
  // Only the page-level rule catches it.
  const half = REAL_SIX + REAL_FOUR;
  const f = vocabularyFindings(half);
  assert.strictEqual(f.mismatched.length, 0,
    'CONTROL: every cell in this fixture is internally consistent, so if this '
    + 'is non-empty the test is passing for the wrong reason');
  assert.strictEqual(f.mixedFamilies, true);
  assert.strictEqual(f.ok, false, 'six cells of one family and three of the other must fail');
  assert.deepStrictEqual([...f.families].sort(), ['four', 'six']);
});

test('DOCTORED: a band index outside its own denominator is CAUGHT', () => {
  const doctored = REAL_FOUR.replace('(band 3 of 4)', '(band 5 of 4)');
  const f = vocabularyFindings(doctored);
  assert.strictEqual(f.ok, false);
  assert.ok(f.outOfRange.some((o) => o.index === 5 && o.of === 4), JSON.stringify(f.outOfRange));
});

test('DOCTORED: a word from a third vocabulary is CAUGHT, not ignored', () => {
  const doctored = REAL_FOUR.replace('Good <span', 'Adequate <span');
  const f = vocabularyFindings(doctored);
  assert.strictEqual(f.ok, false, 'an unrecognised band word must fail rather than pass silently');
  assert.deepStrictEqual(f.unknownWords, ['Adequate']);
});

// ── THE SCOPE, WHICH IS THE PART MOST LIKELY TO BE BROKEN BY A LATER EDIT ──

test('PROSE IS NOT SCANNED: a cover verdict does not make a page mixed', () => {
  const f = vocabularyFindings(COVER_PROSE);
  assert.strictEqual(f.cells, 0, 'prose must produce no band cells at all');
  assert.strictEqual(f.families.length, 0);
  assert.strictEqual(describeFindings(f), 'no band cells');
});

test('a whole report: four-band cover prose beside a coherent six-band fragment PASSES', () => {
  // THIS IS THE STATE OF ALL 18 STORED REPORTS TODAY. A gate that failed here
  // would fail the entire live corpus on the strength of a word in a heading,
  // and would be turned off within a day.
  const f = vocabularyFindings(COVER_PROSE + REAL_SIX);
  assert.strictEqual(f.ok, true, describeFindings(f));
  assert.deepStrictEqual(f.families, ['six']);
});

test('CONTROL: a page with no band cells is reported as SAYING NOTHING, not as a pass', () => {
  const f = vocabularyFindings('<p>no table here</p>');
  assert.strictEqual(f.cells, 0);
  assert.strictEqual(f.ok, true);
  // The distinction the caller must preserve. ok === true AND cells === 0 is
  // "this gate has no opinion", and a sweep that adds it to the pass count is
  // reporting coverage it does not have.
  assert.strictEqual(describeFindings(f), 'no band cells',
    'the description must say so in words, because the sweep prints the '
    + 'description and a reader counts what they can see');
});

test('CONTROL: FAMILY_SIZE is what the denominators are checked against', () => {
  assert.strictEqual(FAMILY_SIZE.four, 4);
  assert.strictEqual(FAMILY_SIZE.six, 6);
  // If the product ever moves to five bands, this test fails here first, in a
  // file whose header explains what the counts mean, rather than in a sweep
  // over 110 reports that reports 110 failures and no cause.
});
