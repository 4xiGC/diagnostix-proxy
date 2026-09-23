// ════════════════════════════════════════════════════════════════════════════
// /diagnose RETURNS A NUMERIC healthCheckScore, COMPUTED FROM THE SIX PILLARS.
//
// WHY THIS EXISTS. 8.11.52 (b13449b) stopped asking the model for the score and
// computed it from the pillars for the page, but nothing put the number back on
// the /diagnose RESPONSE. Analytics reads that response for every peer
// assessment and rejects any without a numeric healthCheckScore
// (diagnostix-analytics lib/orchestrator.js:230). On 2026-09-23 both B2 test
// peer runs came back with every peer failed, and the delivered report said
// "against 0 comparable businesses". npm test passed, because no test looked at
// the response.
//
// HOW THIS IS DRIVEN. The REAL route, over a real socket: `app` from the test
// seam is started on an ephemeral port and POSTed to. The model and every
// outbound fetch are replaced, so nothing leaves the machine and nothing is
// spent. A helper-level test would pass while the handler forgot to call the
// helper, which is the exact shape of the defect.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39461';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude } = __test__;
const { computeOverall } = await import('../lib-score.js');

// Teclados, 2026-05-18: 66 70 42 48 58 72, mean 59.333, so 59.
export const PILLARS = {
  cs: { score: 66, label: 'Customer Sentiment', status: 'good' },
  pa: { score: 70, label: 'Pricing & Accessibility', status: 'good' },
  es: { score: 42, label: 'Employee Sentiment', status: 'bad' },
  sm: { score: 48, label: 'Social Media Impact', status: 'warn' },
  cp: { score: 58, label: 'Competitive Positioning', status: 'warn' },
  bg: { score: 72, label: 'Brand Experience & Growth', status: 'good' },
};

// Every outbound request answers empty. The searches then report "no data",
// which the handler already tolerates, and every table write is swallowed.
const emptyFetch = async () => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({}), text: async () => '{}',
});

function fakeModel(pillars) {
  return async (prompt, opts) => {
    const label = (opts && opts.label) || '';
    if (label === 'diagnose-p1') return { cuisineDetected: 'italian', priceDetected: '$$', pillars };
    if (label === 'diagnose-p2') return { strengths: ['a'], risks: ['b'], competitors: [], actions: [] };
    if (label === 'diagnose-summary') return { executiveSummary: 'A clean summary that names no band.' };
    return {};
  };
}

export async function postDiagnose(pillars) {
  const restoreFetch = setFetch(emptyFetch);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = emptyFetch;
  const restoreClaude = setClaude(fakeModel(pillars));
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const res = await realGlobal('http://127.0.0.1:' + port + '/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Teclados', location: 'Santiago, Chile' }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
    globalThis.fetch = realGlobal;
    restoreClaude();
    restoreFetch();
  }
}

test('THE /diagnose RESPONSE CARRIES A NUMERIC healthCheckScore AND SIX PILLARS', async () => {
  const { status, body } = await postDiagnose(PILLARS);
  assert.equal(status, 200, 'the handler did not complete: ' + JSON.stringify(body).slice(0, 200));
  assert.equal(Object.keys(body.pillars || {}).length, 6, 'six pillars on the response');
  assert.equal(typeof body.healthCheckScore, 'number',
    'healthCheckScore is ' + JSON.stringify(body.healthCheckScore) + '; Analytics rejects that peer');
});

test('and it IS the score the cover computes from those pillars, not a model number', async () => {
  const { body } = await postDiagnose(PILLARS);
  assert.equal(body.healthCheckScore, computeOverall(body.pillars).score);
  assert.equal(body.healthCheckScore, 59);
});

test('CONTROL: five pillars means NO number, so Analytics refuses rather than being fed a guess', async () => {
  const five = Object.fromEntries(Object.entries(PILLARS).filter(([k]) => k !== 'es'));
  const { status, body } = await postDiagnose(five);
  assert.equal(status, 200);
  assert.notEqual(typeof body.healthCheckScore, 'number',
    'a score was invented for a report with five pillars: ' + body.healthCheckScore);
});
