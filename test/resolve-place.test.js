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

// 2026-11-18 (fix 2): /resolve-place geocodes the City (and State) before the Find Place call.
const SANTIAGO_GEO = { status: 'OK', results: [{ geometry: { location: { lat: -33.45, lng: -70.66 },
  viewport: { northeast: { lat: -33.35, lng: -70.50 }, southwest: { lat: -33.60, lng: -70.80 } } } }] };
async function post(path, body, places, geocode) {
  const seen = { outcomes: [], emails: [], placesCalls: [], geocodeCalls: [], other: [], model: 0 };
  const fake = async (url, init) => {
    const u = String(url);
    const ok = (j) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.includes('/geocode/json')) { seen.geocodeCalls.push(u); return typeof geocode === 'function' ? geocode(u) : ok(geocode || SANTIAGO_GEO); }
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
  const { body } = await post('/resolve-place', { name: 'Teclados', location: 'Santiago, Chile' },
    { status: 'OK', candidates: [Object.assign({}, CANDIDATE, { business_status: 'CLOSED_PERMANENTLY' })] });
  assert.equal(body.place.closed, true);
});

test('NO MATCH: a row, a LEAD alert without the requester address, and the copy; no token', async () => {
  const { status, body, seen } = await post('/resolve-place', { name: 'Nowhere Bistro', location: 'Atlantis, Ocean', email: 'owner@example.org' },
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
  const { status, body, seen } = await post('/resolve-place', { name: 'Teclados', location: 'Santiago, Chile' },
    { status: 'REQUEST_DENIED', error_message: 'x' });
  assert.equal(status, 503);
  assert.match(body.error, /try again/);
  assert.equal(seen.outcomes.length + seen.emails.length, 0);
});

test('a missing name is a 400 and calls nothing', async () => {
  const { status, seen } = await post('/resolve-place', { name: '  ', location: 'Santiago, Chile' }, {});
  assert.equal(status, 400);
  assert.equal(seen.placesCalls.length, 0);
});

test('DECLINED: "No" writes declined-by-user with the shown place id', async () => {
  const found = await post('/resolve-place', { name: 'Teclados', location: 'Santiago, Chile' }, { status: 'OK', candidates: [CANDIDATE] });
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

// ── 2026-11-18 (Simon, fix 2): the search is biased to where the restaurant is ──────────────────
const ORLANDO_GEO = { status: 'OK', results: [{ geometry: { location: { lat: 28.54, lng: -81.38 },
  viewport: { northeast: { lat: 28.62, lng: -81.22 }, southwest: { lat: 28.35, lng: -81.51 } } },
  address_components: [{ long_name: 'Orlando', short_name: 'Orlando', types: ['locality', 'political'] },
    { long_name: 'United States', short_name: 'US', types: ['country', 'political'] }] }] };
const ATACAMA_GEO = { status: 'OK', results: [{ geometry: { location: { lat: -27.37, lng: -70.33 },
  viewport: { northeast: { lat: -26.0, lng: -68.0 }, southwest: { lat: -29.0, lng: -71.0 } } } }] };
const okJson = (j) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });

test('NO CITY OR NO COUNTRY: asked for, and nothing is searched', async () => {
  for (const body of [{ name: 'Olive Garden Italian Restaurant', location: '' },
    { name: 'Olive Garden', location: 'Santiago' },
    { name: 'Olive Garden', city: 'Orlando', state: 'Florida', country: '' }]) {
    const r = await post('/resolve-place', body, { status: 'OK', candidates: [CANDIDATE] });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'location-required');
    assert.equal(r.body.error, 'Please add the city and country so we can find the right restaurant.');
    assert.equal(r.seen.placesCalls.length + r.seen.geocodeCalls.length, 0, 'no geocode and no Places call');
  }
});

test('STATE NAMES THE TYPED CITY: City, State and Country place a circle, and the input is the name and City', async () => {
  const { body, seen } = await post('/resolve-place', { name: 'Olive Garden', city: 'Orlando', state: 'Florida', country: 'United States' },
    { status: 'OK', candidates: [CANDIDATE] }, ORLANDO_GEO);
  assert.equal(body.status, 'found');
  assert.equal(seen.geocodeCalls.length, 2);
  assert.ok(seen.geocodeCalls.some((u) => decodeURIComponent(u).includes('address=Orlando, Florida, United States&')));
  const call = decodeURIComponent(seen.placesCalls[0]);
  assert.match(call, /locationbias=circle:\d+@28\.54,-81\.38&/);
  assert.match(call, /input=Olive Garden, Orlando&/);
});

test('STATE FROM AUTOFILL, AN ANSWER THAT IS NOT THE CITY: ignored, and City and Country place the circle', async () => {
  const { seen } = await post('/resolve-place', { name: 'Texas Roadhouse', city: 'Orlando', state: 'Atacama', country: 'United States' },
    { status: 'OK', candidates: [CANDIDATE] },
    (u) => okJson(decodeURIComponent(u).includes('Atacama') ? ATACAMA_GEO : ORLANDO_GEO));
  const call = decodeURIComponent(seen.placesCalls[0]);
  assert.match(call, /locationbias=circle:\d+@28\.54,-81\.38&/, 'Orlando, not Atacama');
  assert.doesNotMatch(call, /Atacama/);
});

test('THE JOINED LOCATION from a page loaded before this release is split into its parts', async () => {
  const { seen } = await post('/resolve-place', { name: 'Teclados', location: 'Vitacura, Santiago, Chile' },
    { status: 'OK', candidates: [CANDIDATE] });
  assert.ok(seen.geocodeCalls.some((u) => decodeURIComponent(u).includes('address=Vitacura, Chile&')));
  assert.ok(seen.geocodeCalls.some((u) => decodeURIComponent(u).includes('address=Vitacura, Santiago, Chile&')));
  assert.match(decodeURIComponent(seen.placesCalls[0]), /input=Teclados, Vitacura&locationbias=circle:/);
});

test('THE CITY IS NOT ON THE MAP: the requester is asked to check it, and no place search is sent', async () => {
  const { status, body, seen } = await post('/resolve-place', { name: 'Nowhere Bistro', city: 'Nowhereville', country: 'Atlantis' },
    { status: 'OK', candidates: [CANDIDATE] }, { status: 'ZERO_RESULTS', results: [] });
  assert.equal(status, 400);
  assert.equal(body.code, 'location-not-found');
  assert.equal(body.error, 'We could not find Nowhereville, Atlantis on the map. Please check the city and country.');
  assert.equal(seen.placesCalls.length + seen.outcomes.length + seen.emails.length, 0);
});

// ── 2026-11-18 (Simon, fix 3): the notices reach the page ──────────────────────────────────────
test('NOTICES: a listing with another name, in another country, carries both approved notices', async () => {
  const { body } = await post('/resolve-place', { name: 'Olive Garden', city: 'Orlando', country: 'United States' },
    { status: 'OK', candidates: [CANDIDATE] }, ORLANDO_GEO);
  assert.equal(body.status, 'found');
  assert.deepEqual(body.notices, [
    "Google's listing has a different name from what you typed (Olive Garden). Check the address below before you continue.",
    "Google's listing is in a different country from the one in your survey. Check the address below before you continue.",
  ]);
});

test('NOTICES: none when the listing matches; none for country when the geocode is unavailable', async () => {
  const clean = await post('/resolve-place', { name: 'Teclados', location: 'Santiago, Chile' }, { status: 'OK', candidates: [CANDIDATE] });
  assert.deepEqual(clean.body.notices, []);
  const outage = await post('/resolve-place', { name: 'Teclados', city: 'Orlando', country: 'United States' },
    { status: 'OK', candidates: [CANDIDATE] }, { status: 'REQUEST_DENIED' });
  assert.deepEqual(outage.body.notices, []);
});

test('the page shows the notices as text, above the card, and hides the box when there are none', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="pc-notice"') > 0 && html.indexOf('id="pc-notice"') < html.indexOf('id="pc-card"'), 'above the card');
  assert.match(html, /p\.textContent = String\(t\)/);
  assert.match(html, /pcNotice\.style\.display = pcNotice\.childNodes\.length \? 'block' : 'none'/);
});

test('A GEOCODING OUTAGE never blocks a confirmation: the text search runs as before, unbiased', async () => {
  const { body, seen } = await post('/resolve-place', { name: 'Teclados', location: 'Santiago, Chile' },
    { status: 'OK', candidates: [CANDIDATE] }, { status: 'REQUEST_DENIED', error_message: 'x' });
  assert.equal(body.status, 'found');
  assert.doesNotMatch(seen.placesCalls[0], /locationbias/);
  assert.match(decodeURIComponent(seen.placesCalls[0]), /input=Teclados, Santiago, Chile&/);
});
