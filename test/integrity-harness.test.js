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

// 2026-09-25, FOUND BY THE FIRST FULL RUN: the harness ran each suite under
// `railway run`, so tests that do not set their own database URL inherited
// PRODUCTION credentials. EVP's confirmation-screen Chrome test then wrote two
// "STOP: no paid run in a test" error rows into production evp_assessments.
// A suite must never see a production credential.
test('THE SUITE RUNS WITHOUT PRODUCTION CREDENTIALS', async () => {
  const { suiteEnv } = await load();
  const env = suiteEnv({ PATH: '/bin', SystemRoot: 'C:/Windows', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_KEY: 'k',
    SUPABASE_SERVICE_KEY: 'k', ANTHROPIC_API_KEY: 'k', SERPER_API_KEY: 'k', RESEND_API_KEY: 'k', WIX_WEBHOOK_SECRET: 's',
    GOOGLE_PLACES_API_KEY: 'k', HUBSPOT_TOKEN: 't', ANALYTICS_SUPABASE_URL: 'https://y.supabase.co', RAILWAY_ENVIRONMENT: 'production',
    EVP_IDENTITY_SECRET: 's', ADMIN_PASSWORD: 'p' });
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'SystemRoot'], 'a credential reached the suite');
});

// 2026-09-26, FOUND BY ITEM 7: this branch builds the review gate and stores
// the subject's own Places count, but the harness still printed "SKIPPED: not
// built". A superseded skip goes quietly true. The gate now MEASURES what the
// review gate says over stored reports, on the subject's own Places count only.
test('THE REVIEW-COUNT GATE MEASURES THE STORED REPORTS, IT IS NOT SKIPPED AS UNBUILT', async () => {
  const { RVP_GATES } = await load();
  const g = RVP_GATES.find((x) => /review-count/.test(x.name));
  assert.ok(!g.skip, 'still skipped as not built');
  assert.equal(g.script, 'rvp-review-gate-retro.mjs');
  assert.ok(g.measure, 'no pass rule is set on stored data yet');
  const out = JSON.stringify({ reports: 108, A_subject_places_count: 16, B_sum_only: 0, C_kg_only: 15, none: 77,
    states: { limited: 2, pass: 14 }, sensitivity: { '100,500': { 'refused-coverage': 9, limited: 4, pass: 12 } } }, null, 1);
  assert.equal(g.counts(out), 'reports 108, judged on the subject\'s own Places count 16: refused 0, limited 2, pass 14; not judgeable 92');
  // CONTROL: an output without the judged count is not a count.
  assert.equal(g.counts('TypeError: x'), '');
});
