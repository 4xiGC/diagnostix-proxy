// ════════════════════════════════════════════════════════════════════════════
// /diagnose ASSESSES ONLY A CONFIRMED PLACE, AND ANALYTICS' REQUEST STILL
// WORKS (overnight 2026-09-26, Item 4).
//
//   survey path   a signed place token from /resolve-place is REQUIRED; a
//                 missing, edited or expired one is a 400 with a code the page
//                 reads, and nothing is spent
//   reuse         the confirmed record's coordinates and count are used; the
//                 focal findplacefromtext call is NOT repeated
//   Analytics     contract/diagnose-request.contract.json: {name, location,
//                 placeId}, no token, is accepted and assessed ungated
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.PORT = '39471';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.RVP_IDENTITY_SECRET = 'test-identity-secret';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude } = __test__;
const { signPlaceToken } = await import('../lib-place-token.js');
const REQUEST = JSON.parse(readFileSync(new URL('../contract/diagnose-request.contract.json', import.meta.url), 'utf8'));
const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };
const PLACE = { placeId: 'ChIJ-teclados', name: 'Teclados', address: 'Av. Italia 1234', rating: 4.4, reviewCount: 900, lat: -33.4, lng: -70.6 };

async function diagnose(body) {
  const seen = { places: [], model: 0 };
  const fake = async (url) => {
    const u = String(url);
    if (u.includes('maps.googleapis.com')) seen.places.push(u);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
  };
  const restoreFetch = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  const restoreClaude = setClaude(async (prompt, opts) => {
    seen.model++;
    const label = (opts && opts.label) || '';
    if (label === 'diagnose-p1') return { cuisineDetected: 'italian', priceDetected: '$$', pillars: PILLARS };
    if (label === 'diagnose-p2') return { strengths: ['a'], risks: ['b'], competitors: [], actions: [] };
    if (label === 'diagnose-summary') return { executiveSummary: 'A clean summary that names no band.' };
    return {};
  });
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const res = await realGlobal('http://127.0.0.1:' + server.address().port + '/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), seen };
  } finally { server.close(); globalThis.fetch = realGlobal; restoreClaude(); restoreFetch(); }
}

test('THE SURVEY PATH REQUIRES A CONFIRMATION: no token and no placeId is a 400, nothing spent', async () => {
  const { status, body, seen } = await diagnose({ name: 'Teclados', location: 'Santiago, Chile' });
  assert.equal(status, 400);
  assert.equal(body.code, 'confirmation-required');
  assert.equal(seen.model + seen.places.length, 0);
});

test('an expired token and an edited token are 400s with their own codes', async () => {
  const old = signPlaceToken({ place: PLACE, secret: 'test-identity-secret', issuedAt: Date.now() - 31 * 60 * 1000 });
  const a = await diagnose({ name: 'Teclados', location: 'Santiago', placeToken: old });
  assert.equal(a.status, 400); assert.equal(a.body.code, 'confirmation-expired');
  const forged = signPlaceToken({ place: PLACE, secret: 'someone-else', issuedAt: Date.now() });
  const b = await diagnose({ name: 'Teclados', location: 'Santiago', placeToken: forged });
  assert.equal(b.status, 400); assert.equal(b.body.code, 'confirmation-invalid');
  assert.equal(a.seen.model + b.seen.model, 0);
});

test('A CONFIRMED TOKEN IS ASSESSED WITH ITS OWN RECORD: no second focal Find Place call', async () => {
  const tok = signPlaceToken({ place: PLACE, secret: 'test-identity-secret', issuedAt: Date.now() });
  const { status, body, seen } = await diagnose({ name: 'Teclados', location: 'Santiago, Chile', placeToken: tok });
  assert.equal(status, 200);
  assert.equal(typeof body.healthCheckScore, 'number');
  assert.equal(body.coverage.state, 'pass');
  const focalFinds = seen.places.filter((u) => /findplacefromtext/.test(u) && /Teclados/.test(decodeURIComponent(u)));
  assert.equal(focalFinds.length, 0, 'the confirmed record is reused, not re-resolved');
  assert.ok(seen.places.some((u) => /nearbysearch/.test(u) && u.includes('-33.4') && u.includes('-70.6')),
    'nearby search runs from the confirmed coordinates');
});

test('THE ANALYTICS REQUEST CONTRACT: the example is accepted with no token and not gated', async () => {
  assert.deepEqual(Object.keys(REQUEST.example).sort(), Object.keys(REQUEST.required).sort());
  const { status, body } = await diagnose(REQUEST.example);
  assert.equal(status, 200);
  assert.equal(typeof body.healthCheckScore, 'number');
  assert.equal(body.refused, undefined);
  assert.equal(body.coverage, undefined);
});
