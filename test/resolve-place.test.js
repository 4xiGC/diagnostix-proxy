// ════════════════════════════════════════════════════════════════════════════
// CONFIRM THE PLACES RECORD BEFORE ANY ASSESSMENT (overnight 2026-09-26,
// Item 4; SUBJECT_INTEGRITY_STANDARD.md 3.1, RVP_SAFEGUARDS_SPEC.md 2).
//
// POST /resolve-place makes ONE findplacefromtext call and returns what it
// matched (name, address, review count, rating) with a signed place token.
// Nothing else is called: no Serper, no model.
//   found      the record and the token
//   no match   an rvp_outcomes row (no-place-match) and a LEAD alert, and the
//              copy the page shows; no token
//   error      Places failed (not ZERO_RESULTS): a retry message, no row, no
//              alert, because nothing was decided
// POST /decline-place records the requester's "No" as declined-by-user.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39470';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.RVP_IDENTITY_SECRET = 'test-identity-secret';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude } = __test__;
const { verifyPlaceToken } = await import('../lib-place-token.js');

const CANDIDATE = { place_id: 'ChIJ-teclados', name: 'Teclados', formatted_address: 'Av. Italia 1234, Santiago, Chile',
  rating: 4.4, user_ratings_total: 765, business_status: 'OPERATIONAL', geometry: { location: { lat: -33.44, lng: -70.62 } } };

async function post(path, body, places) {
  const seen = { outcomes: [], emails: [], placesCalls: [], other: [], model: 0 };
  const fake = async (url, init) => {
    const u = String(url);
    const ok = (j) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.includes('maps.googleapis.com')) { seen.placesCalls.push(u); return typeof places === 'function' ? places(u) : ok(places); }
    if (u.includes('/rest/v1/rvp_outcomes')) { seen.outcomes.push(JSON.parse(init.body)); return { ok: true, status: 201, text: async () => '' }; }
    if (u.includes('api.resend.com')) { seen.emails.push(JSON.parse(init.body)); return ok({ id: 'x' }); }
    seen.other.push(u); return ok({});
  };
  const restoreFetch = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  const restoreClaude = setClaude(async () => { seen.model++; return {}; });
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const res = await realGlobal('http://127.0.0.1:' + server.address().port + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), seen };
  } finally { server.close(); globalThis.fetch = realGlobal; restoreClaude(); restoreFetch(); }
}

test('FOUND: one Places call, the record, and a token that binds it', async () => {
  const { status, body, seen } = await post('/resolve-place', { name: 'Teclados', location: 'Santiago, Chile', email: 'owner@example.org' },
    { status: 'OK', candidates: [CANDIDATE] });
  assert.equal(status, 200);
  assert.equal(body.status, 'found');
  assert.deepEqual(body.place, { name: 'Teclados', address: 'Av. Italia 1234, Santiago, Chile', rating: 4.4, reviewCount: 765, closed: false });
  const v = verifyPlaceToken({ token: body.placeToken, secret: 'test-identity-secret' });
  assert.equal(v.ok, true);
  assert.equal(v.place.placeId, 'ChIJ-teclados');
  assert.equal(v.place.reviewCount, 765);
  assert.equal(seen.placesCalls.length, 1);
  assert.match(seen.placesCalls[0], /findplacefromtext/);
  assert.match(seen.placesCalls[0], /formatted_address/);
  assert.equal(seen.other.length + seen.model + seen.outcomes.length + seen.emails.length, 0, 'nothing else is called');
});

test('a permanently closed record says so', async () => {
  const { body } = await post('/resolve-place', { name: 'Teclados', location: 'Santiago' },
    { status: 'OK', candidates: [Object.assign({}, CANDIDATE, { business_status: 'CLOSED_PERMANENTLY' })] });
  assert.equal(body.place.closed, true);
});

test('NO MATCH: a row, a LEAD alert without the requester address, and the copy; no token', async () => {
  const { status, body, seen } = await post('/resolve-place', { name: 'Nowhere Bistro', location: 'Atlantis', email: 'owner@example.org' },
    { status: 'ZERO_RESULTS', candidates: [] });
  assert.equal(status, 200);
  assert.equal(body.status, 'no-match');
  assert.equal(body.placeToken, undefined);
  assert.equal(body.copy.heading, 'We could not find Nowhere Bistro on Google');
  assert.match(body.copy.body.join(' '), /You have not been charged/);
  assert.equal(seen.outcomes.length, 1);
  assert.equal(seen.outcomes[0].decision, 'no-place-match');
  assert.equal(seen.outcomes[0].coverage_verdict, 'no-place-match');
  assert.equal(seen.outcomes[0].survey_addr_domain, '@example.org');
  assert.equal(seen.emails.length, 1);
  // The suite runs under the guard's marker, so the subject may carry "[TEST RUN] ".
  assert.equal(String(seen.emails[0].subject).replace(/^\[TEST RUN\] /, ''), 'LEAD, no Places match: Nowhere Bistro');
  assert.doesNotMatch(JSON.stringify(seen.emails[0]), /owner@/);
});

test('PLACES ERROR: a retry message, no row, no alert', async () => {
  const { status, body, seen } = await post('/resolve-place', { name: 'Teclados', location: 'Santiago' },
    { status: 'REQUEST_DENIED', error_message: 'x' });
  assert.equal(status, 503);
  assert.match(body.error, /try again/);
  assert.equal(seen.outcomes.length + seen.emails.length, 0);
});

test('a missing name is a 400 and calls nothing', async () => {
  const { status, seen } = await post('/resolve-place', { name: '  ', location: 'Santiago' }, {});
  assert.equal(status, 400);
  assert.equal(seen.placesCalls.length, 0);
});

test('DECLINED: "No" writes declined-by-user with the shown place id', async () => {
  const found = await post('/resolve-place', { name: 'Teclados', location: 'Santiago' }, { status: 'OK', candidates: [CANDIDATE] });
  const { status, body, seen } = await post('/decline-place', { placeToken: found.body.placeToken, email: 'owner@example.org' }, {});
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(seen.outcomes.length, 1);
  const o = seen.outcomes[0];
  assert.equal(o.decision, 'declined-by-user');
  assert.equal(o.coverage_verdict, 'declined-by-user');
  assert.equal(o.place_id, 'ChIJ-teclados');
  assert.equal(o.place_confirmed, false);
  assert.equal(o.subject_review_count, 765);
  assert.equal(seen.placesCalls.length, 0, 'no second Places call');
});

test('a "No" with a bad token is still recorded, with the reason', async () => {
  const { seen } = await post('/decline-place', { placeToken: 'junk' }, {});
  assert.equal(seen.outcomes.length, 1);
  assert.equal(seen.outcomes[0].place_id, null);
  assert.match(seen.outcomes[0].reason, /token malformed/);
});
