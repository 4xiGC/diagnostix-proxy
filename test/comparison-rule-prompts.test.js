// ════════════════════════════════════════════════════════════════════════════
// THE COMPARISON RULE REACHES THE PROSE PROMPTS, THROUGH THE REAL /diagnose
// ROUTE (2026-09-29, recommendation 4). The model and every outbound fetch are
// replaced; nothing leaves the machine and nothing is spent.
//
// diagnose-p2 writes competitiveInsight and the competitor notes (the Orchid
// "648 vs 784"); the executive summary compares too. diagnose-p1 returns
// scores only, so it does not carry the rule.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39495';
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
const { COMPARISON_RULE } = await import('../lib-comparisons.js');
const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };

test('diagnose-p2 and the executive summary carry COMPARISON_RULE; p1 does not', async () => {
  const prompts = {};
  const fake = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' });
  const restoreFetch = setFetch(fake); const realGlobal = globalThis.fetch; globalThis.fetch = fake;
  const restoreClaude = setClaude(async (prompt, opts) => {
    const label = (opts && opts.label) || ''; prompts[label] = String(prompt);
    if (label === 'diagnose-p1') return { cuisineDetected: 'italian', priceDetected: '$$', pillars: PILLARS };
    if (label === 'diagnose-p2') return { strengths: ['a'], risks: ['b'], competitors: [], actions: [] };
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
    assert.equal(res.status, 200);
  } finally { server.close(); globalThis.fetch = realGlobal; restoreClaude(); restoreFetch(); }
  for (const label of ['diagnose-p2', 'diagnose-summary']) {
    assert.ok(prompts[label], label + ' was never called, so this proves nothing');
    assert.ok(prompts[label].includes(COMPARISON_RULE), label + ' does not carry the comparison rule');
  }
  assert.ok(prompts['diagnose-p1'] && !prompts['diagnose-p1'].includes(COMPARISON_RULE), 'p1 (scores only) carries the rule');
});
