// ════════════════════════════════════════════════════════════════════════════
// PLACES AND SERPER: A TIMEOUT, ONE RETRY, A LOGGED REASON, AN ALERT
// (2026-09-30, B2; recommendation 7, the C4 leftovers).
//
// C4 (2026-09-28): no Places or Serper call in RVP had a timeout, and a failure
// became an empty result nobody was told about. Now every such call has a 15 s
// timeout (RVP_EXTERNAL_TIMEOUT_MS overrides it; 80 ms here), ONE retry on a
// timeout, a network error or a 5xx (never on a 4xx), then the existing empty
// or thin path with the reason logged, and ONE internal alert per service per
// ten minutes. Through the real functions, with the module's fetch replaced:
// no network, no spend.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39497';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.RVP_EXTERNAL_TIMEOUT_MS = '80';

const { __test__ } = await import('../server.js');
const { setFetch } = __test__;

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
const status = (code, body) => ({ ok: false, status: code, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
const hang = (init) => new Promise((_, reject) => {
  if (init && init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
});
const SERPER_OK = { organic: [{ title: 'A', snippet: 'good food' }] };

// Replaces both the module fetch and the global one (Resend goes through the
// module fetch). Records the calls by service.
async function withStub(route, body) {
  const calls = { serper: 0, places: 0, emails: [] };
  const fake = async (url, init) => {
    const u = String(url);
    if (u.includes('api.resend.com')) { calls.emails.push(JSON.parse(init.body)); return ok({ id: 'e' + calls.emails.length }); }
    if (u.includes('serper.dev')) { calls.serper++; return route('serper', calls.serper, init); }
    if (u.includes('maps.googleapis.com')) { calls.places++; return route('places', calls.places, init); }
    return ok({});
  };
  const restore = setFetch(fake); const g = globalThis.fetch; globalThis.fetch = fake;
  __test__.resetExternalAlerts();
  try { return await body(calls); } finally { restore(); globalThis.fetch = g; }
}
const alerts = (calls, service) => calls.emails.filter((e) => new RegExp(service, 'i').test(e.subject || ''));

test('A HUNG SERPER SEARCH ENDS: two attempts, the empty path with its reason, one alert', { timeout: 5000 }, async () => {
  await withStub((s, n, init) => hang(init), async (calls) => {
    const t0 = Date.now();
    const out = await __test__.search('best pasta santiago', { label: 'test' });
    assert.ok(Date.now() - t0 < 2000, 'the search hung');
    assert.match(out, /^err:.*timeout/, 'the empty path does not carry its reason: ' + out);
    assert.equal(calls.serper, 2, 'one retry expected, got ' + calls.serper + ' attempts');
    assert.equal(alerts(calls, 'serper').length, 1, 'no internal alert for the failed search');
  });
});

test('a Serper 5xx is retried once and the second answer is used', { timeout: 5000 }, async () => {
  await withStub((s, n) => (n === 1 ? status(503, {}) : ok(SERPER_OK)), async (calls) => {
    const out = await __test__.search('q', { label: 'test' });
    assert.match(out, /good food/);
    assert.equal(calls.serper, 2);
    assert.equal(alerts(calls, 'serper').length, 0, 'a recovered search is not an alert');
  });
});

test('a Serper 4xx is NOT retried (it would fail the same way twice)', { timeout: 5000 }, async () => {
  await withStub(() => status(403, { message: 'forbidden' }), async (calls) => {
    await __test__.search('q', { label: 'test' });
    assert.equal(calls.serper, 1);
  });
});

test('searchStructured on a hung Serper ends with its reason and no rating invented', { timeout: 5000 }, async () => {
  await withStub((s, n, init) => hang(init), async (calls) => {
    const out = await __test__.searchStructured('q', { label: 'test' });
    assert.match(out.text, /^err:.*timeout/);
    assert.equal(out.rating, null);
    assert.equal(calls.serper, 2);
  });
});

test('A HUNG PLACES CALL ENDS: nearby discovery returns empty with its reason, one alert', { timeout: 5000 }, async () => {
  await withStub((s, n, init) => hang(init), async (calls) => {
    const t0 = Date.now();
    const out = await __test__.fetchPlacesNearby({ name: 'A Restaurant', location: 'Santiago' });
    assert.ok(Date.now() - t0 < 2000, 'Places hung');
    assert.deepEqual(out.places, []);
    assert.equal(calls.places, 2, 'find place: one retry expected');
    assert.equal(alerts(calls, 'places').length, 1);
  });
});

test('a competitor Find Place that hangs returns its reason, never a guess', { timeout: 5000 }, async () => {
  await withStub((s, n, init) => hang(init), async () => {
    const out = await __test__.findPlaceForCompetitor('Some Competitor, Santiago');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'timeout');
  });
});

test('ONE ALERT PER SERVICE PER TEN MINUTES: nine failed searches in a run send one email', { timeout: 8000 }, async () => {
  await withStub(() => status(502, {}), async (calls) => {
    for (let i = 0; i < 3; i++) await __test__.search('q' + i, { label: 'test' });
    assert.equal(alerts(calls, 'serper').length, 1);
  });
});

test('CONTROL: healthy answers make no retry and no alert', { timeout: 5000 }, async () => {
  await withStub((s) => (s === 'serper' ? ok(SERPER_OK) : ok({ status: 'ZERO_RESULTS', candidates: [], results: [] })), async (calls) => {
    assert.match(await __test__.search('q', { label: 'test' }), /good food/);
    assert.equal(calls.serper, 1);
    assert.equal(calls.emails.length, 0);
  });
});

test('searchStructured alerts too when Serper fails twice', { timeout: 5000 }, async () => {
  await withStub(() => status(500, {}), async (calls) => {
    await __test__.searchStructured('q', { label: 'test' });
    assert.equal(alerts(calls, 'serper').length, 1);
  });
});

test('/resolve-place on a hung Places: a 503 the page can say, two attempts, and an internal alert', { timeout: 8000 }, async () => {
  process.env.RVP_IDENTITY_SECRET = process.env.RVP_IDENTITY_SECRET || "test-identity-secret";
  // The route is driven with the real Node fetch; the stub replaces only the
  // module fetch, so it sees the outbound Places and Resend calls.
  const calls = { places: 0, emails: [] };
  const fake = async (url, init) => {
    const u = String(url);
    if (u.includes('api.resend.com')) { calls.emails.push(JSON.parse(init.body)); return ok({ id: 'e' }); }
    if (u.includes('maps.googleapis.com')) { calls.places++; return hang(init); }
    return ok({});
  };
  const restore = setFetch(fake);
  __test__.resetExternalAlerts();
  const server = __test__.app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/resolve-place', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Teclados', location: 'Santiago, Chile', email: 'owner@example.org' }) });
    assert.equal(r.status, 503);
    assert.equal(calls.places, 2, 'one retry expected');
    assert.equal(alerts(calls, 'places').length, 1, 'no internal alert for the failed confirmation');
  } finally { restore(); server.close(); }
});
