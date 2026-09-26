// ════════════════════════════════════════════════════════════════════════════
// THE PLAN RULE IS BEHIND A FLAG, OFF BY DEFAULT (2026-10-01, B1 prompt change).
//
// Through the REAL /diagnose route, with the model and every fetch replaced:
//   - RVP_PLAN_PROMPT unset: diagnose-p2 is sent WITHOUT the plan rule, and the
//     run's provenance records p2's plain id (a push changes nothing);
//   - RVP_PLAN_PROMPT=1: p2 carries PLAN_RULE, the provenance id says so, and a
//     returned `plan` reaches the report.
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39497';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.RVP_IDENTITY_SECRET = 'test-identity-secret';
process.env.RVP_WEBHOOK_SECRET = 'a-test-webhook-secret';
process.env.ANALYTICS_URL = 'https://analytics.invalid';
process.env.ANALYTICS_TEAM_PASSWORD = 'not-a-password';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude } = __test__;
const { signPlaceToken } = await import('../lib-place-token.js');
const { PLAN_RULE, PLAN_PROMPT_VERSION } = await import('../lib-plan-prompt.js');
const { PROMPT_VERSIONS } = await import('../lib-provenance.js');
const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };
const PLAN = [{ title: 'Fix pacing', desc: 'Retrain the floor.', owner: 'General manager', horizon: '2 weeks', indicator: 'Fewer slow-service reviews', finding: 'Reviews cite long waits' }];

async function run(flag) {
  if (flag) process.env.RVP_PLAN_PROMPT = '1'; else delete process.env.RVP_PLAN_PROMPT;
  const prompts = {};
  const fake = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' });
  const restoreFetch = setFetch(fake); const realGlobal = globalThis.fetch; globalThis.fetch = fake;
  const restoreClaude = setClaude(async (prompt, opts) => {
    const label = (opts && opts.label) || ''; prompts[label] = String(prompt);
    if (label === 'diagnose-p1') return { cuisineDetected: 'italian', priceDetected: '$$', pillars: PILLARS };
    if (label === 'diagnose-p2') return { strengths: ['a'], risks: ['b'], competitors: [], actions: [], ...(flag ? { plan: PLAN } : {}) };
    if (label === 'diagnose-summary') return { executiveSummary: 'A clean summary that names no band.' };
    return {};
  });
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const token = signPlaceToken({ place: { placeId: 'ChIJ-x', name: 'Casa Teclados SpA', address: 'Av. Italia 1234', rating: 4.4, reviewCount: 900, lat: -33.4, lng: -70.6 },
      secret: 'test-identity-secret', issuedAt: Date.now() });
    const res = await realGlobal('http://127.0.0.1:' + server.address().port + '/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Teclados', location: 'Santiago, Chile', placeToken: token }) });
    return { status: res.status, body: await res.json(), prompts };
  } finally { server.close(); globalThis.fetch = realGlobal; restoreClaude(); restoreFetch(); delete process.env.RVP_PLAN_PROMPT; }
}

test('FLAG UNSET: p2 carries no plan rule, and the provenance id is the plain p2 id', async () => {
  const r = await run(false);
  assert.equal(r.status, 200);
  assert.ok(r.prompts['diagnose-p2'], 'p2 was never called, so this proves nothing');
  assert.equal(r.prompts['diagnose-p2'].includes(PLAN_RULE), false);
  // The stubbed model bypasses claude()'s recording, so passes is empty; the run's promptVersions map is what records the prompt.
  assert.equal(r.body.provenance.promptVersions['diagnose-p2'], PROMPT_VERSIONS['diagnose-p2']);
  assert.equal(r.body.plan, undefined);
});

test('FLAG ON: p2 carries PLAN_RULE, the provenance id records it, and the plan reaches the report', async () => {
  const r = await run(true);
  assert.equal(r.status, 200);
  assert.ok(r.prompts['diagnose-p2'].includes(PLAN_RULE));
  assert.equal(r.body.provenance.promptVersions['diagnose-p2'], PROMPT_VERSIONS['diagnose-p2'] + '+' + PLAN_PROMPT_VERSION);
  assert.deepEqual(r.body.plan, PLAN);
});
