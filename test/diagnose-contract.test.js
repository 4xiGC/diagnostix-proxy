// ════════════════════════════════════════════════════════════════════════════
// THE /diagnose RESPONSE SATISFIES THE CONTRACT ANALYTICS DEPENDS ON.
//
// contract/diagnose-response.contract.json names every field of the response
// that diagnostix-analytics reads. An IDENTICAL copy is in
// diagnostix-analytics/test/fixtures/, where a test runs Analytics' real
// acceptance check (assessOnce) against the example. So:
//
//   RVP stops sending a field Analytics needs  -> THIS file goes red
//   Analytics starts needing something else    -> ITS test goes red on the
//                                                 example, and the fixture
//                                                 has to change in both repos
//
// 8.11.52 broke exactly this and both suites stayed green. Against the
// 8.11.52 tree this test fails on healthCheckScore.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.PORT = '39465';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';

const { __test__ } = await import('../server.js');
const { diagnoseHarness } = await import('../test-support/diagnose-harness.js');
const { computeOverall } = await import('../lib-score.js');
const postDiagnose = diagnoseHarness(__test__);

const CONTRACT = JSON.parse(readFileSync(new URL('../contract/diagnose-response.contract.json', import.meta.url), 'utf8'));

// The contract's rules, applied to any response. Returns the list of breaches.
function breaches(resp) {
  const out = [];
  const isInt = (v) => Number.isInteger(v) && v >= 0 && v <= 100;
  for (const k of CONTRACT.pillarKeys) {
    if (!resp.pillars || !resp.pillars[k] || !isInt(resp.pillars[k].score)) out.push('pillars.' + k + '.score');
  }
  if (!isInt(resp.healthCheckScore)) out.push('healthCheckScore is ' + JSON.stringify(resp.healthCheckScore));
  else if (resp.healthCheckScore !== computeOverall(resp.pillars).score) out.push('healthCheckScore is not the mean of the pillars');
  if (!('benchmarkId' in resp)) out.push('benchmarkId key missing');
  else if (resp.benchmarkId !== null && typeof resp.benchmarkId !== 'string') out.push('benchmarkId is not a string or null');
  return out;
}

test('THE REAL /diagnose RESPONSE SATISFIES THE CONTRACT', async () => {
  const { status, body } = await postDiagnose(CONTRACT.example.pillars);
  assert.equal(status, 200);
  assert.deepEqual(breaches(body), [], 'the response breaks the contract Analytics reads');
  assert.equal(body.healthCheckScore, CONTRACT.example.healthCheckScore,
    'the same pillars give the contract example its score');
});

test('the contract example is itself valid, so the Analytics copy tests a real shape', () => {
  assert.deepEqual(breaches(CONTRACT.example), []);
});

test('CONTROL: the checker catches the 8.11.52 shape', () => {
  const broken = { ...CONTRACT.example };
  delete broken.healthCheckScore;
  assert.deepEqual(breaches(broken), ['healthCheckScore is undefined']);
});
