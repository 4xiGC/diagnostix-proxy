// ════════════════════════════════════════════════════════════════════════════
// PROVENANCE THROUGH THE REAL /diagnose ROUTE (2026-09-30, B5).
//
// The real claude() runs against a stubbed Anthropic endpoint that returns
// usage blocks, so what is recorded is what the API returned, per pass. Every
// other outbound call is stubbed: nothing leaves the machine, nothing is spent.
// The benchmark write first meets a database WITHOUT the provenance column
// (400 PGRST204) and must be written again without it, so the code can ship
// before its migration.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39494';
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
process.env.BENCHMARK_WRITE_ENABLED = 'true';

const { __test__ } = await import('../server.js');
const { app, setFetch } = __test__;
const { signPlaceToken } = await import('../lib-place-token.js');
const { PROMPT_VERSIONS } = await import('../lib-provenance.js');

const reply = (obj, usage) => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage }),
  json: async () => ({}) });
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const PILLARS = { cs: { score: 66, label: 'Customer Sentiment', status: 'good' }, pa: { score: 70, label: 'Pricing', status: 'good' },
  es: { score: 42, label: 'Employee', status: 'bad' }, sm: { score: 48, label: 'Social', status: 'warn' },
  cp: { score: 58, label: 'Competitive', status: 'warn' }, bg: { score: 72, label: 'Brand', status: 'good' } };

test('A DIAGNOSE RUN CARRIES ITS PROVENANCE, AND THE BENCHMARK ROW SURVIVES A DATABASE WITHOUT THE COLUMN', { timeout: 20000 }, async () => {
  const benchmarkBodies = [];
  const fake = async (url, init) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      const prompt = JSON.parse(init.body).messages[0].content;
      if (/Use WebData for scores/.test(prompt)) return reply({ cuisineDetected: 'italian', priceDetected: '$$', pillars: PILLARS }, { input_tokens: 3100, output_tokens: 920 });
      if (/TWO DISTINCT ACTION LISTS/.test(prompt)) return reply({ strengths: ['a'], risks: ['b'], competitors: [], actions: [] }, { input_tokens: 4500, output_tokens: 1932 });
      return reply({ executiveSummary: 'Teclados holds a loyal local following, and its pricing is where the reviews divide.' }, { input_tokens: 900, output_tokens: 122 });
    }
    if (u.includes('/rest/v1/benchmarks')) {
      const body = JSON.parse(init.body);
      benchmarkBodies.push(body);
      if (benchmarkBodies.length === 1) return { ok: false, status: 400, headers: { get: () => null },
        text: async () => JSON.stringify({ code: 'PGRST204', message: "Could not find the 'provenance' column of 'benchmarks' in the schema cache" }) };
      return { ok: true, status: 201, headers: { get: () => null }, text: async () => '' };
    }
    return ok({});
  };
  const restore = setFetch(fake); const realGlobal = globalThis.fetch; globalThis.fetch = fake;
  const server = app.listen(0);
  let report;
  try {
    await new Promise((r) => server.once('listening', r));
    const token = signPlaceToken({ place: { placeId: 'ChIJ-x', name: 'Casa Teclados SpA', address: 'Av. Italia 1234', rating: 4.4, reviewCount: 900, lat: -33.4, lng: -70.6 },
      secret: 'test-identity-secret', issuedAt: Date.now() });
    const res = await realGlobal('http://127.0.0.1:' + server.address().port + '/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Teclados', location: 'Santiago, Chile', placeToken: token }) });
    assert.equal(res.status, 200);
    report = await res.json();
    for (let i = 0; i < 50 && benchmarkBodies.length < 2; i++) await new Promise((r) => setTimeout(r, 40));
  } finally { server.close(); globalThis.fetch = realGlobal; restore(); }

  const p = report.provenance;
  assert.ok(p, 'the report carries no provenance');
  assert.equal(p.methodVersion, 'rvp-overall-mean-v2');
  const by = Object.fromEntries(p.passes.map((x) => [x.label, x]));
  assert.deepEqual(Object.keys(by).sort(), ['diagnose-p1', 'diagnose-p2', 'diagnose-summary']);
  assert.equal(by['diagnose-p1'].model, 'claude-sonnet-4-5-20250929');
  assert.equal(by['diagnose-p2'].model, 'claude-haiku-4-5-20251001');
  assert.equal(by['diagnose-p1'].inputTokens, 3100);
  assert.equal(by['diagnose-p2'].outputTokens, 1932);
  assert.equal(by['diagnose-summary'].outputTokens, 122);
  assert.equal(by['diagnose-p1'].promptVersion, PROMPT_VERSIONS['diagnose-p1']);
  assert.ok(p.confidence && p.confidence.level, 'no confidence level');
  assert.equal(typeof p.durationMs, 'number');

  assert.equal(benchmarkBodies.length, 2, 'the benchmark write was not retried without the missing column');
  assert.deepEqual(benchmarkBodies[0].provenance, p, 'the first write did not carry the provenance');
  assert.ok(!('provenance' in benchmarkBodies[1]), 'the retry still named the missing column');
  assert.equal(benchmarkBodies[1].id, benchmarkBodies[0].id, 'the retry is a different row');
});
