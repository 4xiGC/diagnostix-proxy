// ════════════════════════════════════════════════════════════════════════════
// THE INTEGRITY HARNESS READS EACH GATE'S VERDICT, IT NEVER ASSUMES ONE.
//
// scripts/integrity.mjs runs every gate and prints one table. Its verdict per
// gate comes from the gate's own output. The dangerous failure is a harness
// that reports PASS for a gate that failed, errored or never ran, so:
//   - a red line beats a green one in the same output
//   - a non-zero exit with no verdict line is ERROR, never PASS
//   - a clean exit with no verdict line is not PASS either (it is MEASURED)
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import(new URL('../scripts/integrity.mjs', import.meta.url).href);

test('the green lines each gate prints are read as PASS', async () => {
  const { parseVerdict } = await load();
  assert.equal(parseVerdict('...\nGATE GREEN: on every stored payload...', 0), 'PASS');
  assert.equal(parseVerdict('ALL 5 CHECKS PASSED', 0), 'PASS');
  assert.equal(parseVerdict('PASS: no summary contradicts its computed band', 0), 'PASS');
});

test('the red lines are FAIL, and a red line beats a green one', async () => {
  const { parseVerdict } = await load();
  assert.equal(parseVerdict('GATE FAILED, 2 payload(s):', 1), 'FAIL');
  assert.equal(parseVerdict('2 CHECK(S) FAILED:', 1), 'FAIL');
  assert.equal(parseVerdict('CONTROLS FAILED. The result above means nothing', 0), 'FAIL');
  assert.equal(parseVerdict('ALL 5 CHECKS PASSED\nFAIL: 1 contradiction(s)', 0), 'FAIL');
});

test('CONTROL: a crash with no verdict is ERROR, and a clean exit with none is not PASS', async () => {
  const { parseVerdict } = await load();
  assert.equal(parseVerdict('TypeError: x is undefined', 1), 'ERROR');
  assert.equal(parseVerdict('reports rendered 224, marks 27', 0), null);
});

test('the suite counts are read from node --test output', async () => {
  const { suiteCounts } = await load();
  assert.deepEqual(suiteCounts('ℹ tests 316\nℹ pass 316\nℹ fail 0'), { tests: 316, pass: 316, fail: 0 });
});

test('the RVP gate list names every gate the program built, and says why one is skipped', async () => {
  const { RVP_GATES } = await load();
  const names = RVP_GATES.map((g) => g.name).join(' | ');
  for (const w of ['suite', 'print', 'verdict words', 'score_verdict', 'statistics', 'review-count']) assert.match(names, new RegExp(w));
  for (const g of RVP_GATES.filter((x) => x.skip)) assert.match(g.skip, /^SKIPPED: /);
});
