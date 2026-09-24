// ════════════════════════════════════════════════════════════════════════════
// THE NEWEST REVIEW DATE IS READ AT INTAKE, AND THE RECENCY RULE USES IT.
//
// Simon approved the paid Place Details call on 2026-09-24 once the published
// pricing showed it inside the existing plan. Until now RVP fetched no review
// date, so subject_newest_review_at (migration 005) was null on every row and
// MAX_DAYS_SINCE_NEWEST_REVIEW (180) could never fire.
//
// WHERE: POST /diagnose, after the place token is verified and before the
// review gate, for a CONFIRMED survey only. Not at /resolve-place: that would
// pay for every "No" and every candidate shown. Not for Analytics' peers: they
// are not gated. Not when the count alone already refuses: a refused subject
// needs no date.
//
// THE CALL: legacy Place Details, fields=reviews, reviews_sort=newest, the
// confirmed place_id. The newest review time goes to the coverage row and the
// benchmark row. A failed call NEVER blocks the sale: recency is unknown.
//
// The Places response is CONSTRUCTED from Google's documentation
// (fixtures/place-details-reviews.constructed.json), not recorded: recording
// one is a paid call, which tonight's rules stop.
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
process.env.BENCHMARK_WRITE_ENABLED = 'true';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude } = __test__;
const { signPlaceToken } = await import('../lib-place-token.js');
const DETAILS = JSON.parse(readFileSync(new URL('./fixtures/place-details-reviews.constructed.json', import.meta.url), 'utf8'));
const DAY = 86400;

const tokenFor = (reviews) => signPlaceToken({ secret: 'test-identity-secret', issuedAt: Date.now(),
  place: { placeId: 'ChIJ-teclados', name: 'Teclados', address: 'Av. Italia 1234', rating: 4.4,
    reviewCount: reviews, lat: -33.4, lng: -70.6 } });
const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };

// details: 'days:N' (newest review N days ago), 'error' (HTTP 500), 'denied'
// (status REQUEST_DENIED), 'throw' (network failure).
async function run({ reviews, details, body }) {
  const seen = { outcomes: [], benchmarks: [], detailsUrls: [], modelCalls: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const fake = async (url, init) => {
    const u = String(url);
    const ok = (j, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.includes('/maps/api/place/details/')) {
      seen.detailsUrls.push(u);
      if (details === 'throw') throw new Error('network down');
      if (details === 'error') return ok({ error: 'x' }, 500);
      if (details === 'denied') return ok({ status: 'REQUEST_DENIED', error_message: 'x' });
      const days = Number(String(details).split(':')[1]);
      const r = JSON.parse(JSON.stringify(DETAILS));
      r.result.reviews = r.result.reviews.map((rv, i) => ({ ...rv, time: nowSec - (days + i * 10) * DAY }));
      return ok(r);
    }
    if (u.includes('findplacefromtext') && !seen.focalDone) {
      seen.focalDone = true;
      return ok({ status: 'OK', candidates: [{ place_id: 'ChIJ-teclados', name: 'Teclados', rating: 4.4,
        user_ratings_total: reviews, geometry: { location: { lat: -33.4, lng: -70.6 } } }] });
    }
    if (u.includes('/rest/v1/rvp_outcomes')) { seen.outcomes.push(JSON.parse(init.body)); return { ok: true, status: 201, text: async () => '' }; }
    if (u.includes('/rest/v1/benchmarks') && String((init && init.method) || 'GET').toUpperCase() === 'POST') {
      seen.benchmarks.push(JSON.parse(init.body)); return { ok: true, status: 201, text: async () => '', json: async () => [] };
    }
    return ok({});
  };
  const restoreFetch = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  const restoreClaude = setClaude(async (prompt, opts) => {
    seen.modelCalls++;
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ name: 'Teclados', location: 'Santiago, Chile', email: 'owner@example.org',
        placeToken: tokenFor(reviews) }, body || {})),
    });
    const out = { status: res.status, body: await res.json(), seen };
    // The benchmark row is written after the response.
    for (let i = 0; i < 100 && !seen.benchmarks.length && out.body && out.body.healthCheckScore != null; i++) await new Promise((r) => setTimeout(r, 20));
    return out;
  } finally {
    server.close(); globalThis.fetch = realGlobal; restoreClaude(); restoreFetch();
  }
}

test('A RECENT NEWEST REVIEW: one Details call for the confirmed place, the date on the coverage row and the benchmark row, pass', async () => {
  const { body, seen } = await run({ reviews: 900, details: 'days:12' });
  assert.equal(seen.detailsUrls.length, 1, 'exactly one Place Details call');
  const u = new URL(seen.detailsUrls[0]);
  assert.equal(u.searchParams.get('place_id'), 'ChIJ-teclados');
  assert.equal(u.searchParams.get('fields'), 'reviews');
  assert.equal(u.searchParams.get('reviews_sort'), 'newest');
  assert.equal(body.coverage.state, 'pass');
  const o = seen.outcomes.find((x) => x.kind === 'coverage');
  assert.ok(o.subject_newest_review_at, 'the coverage row carries the newest review date');
  const ageDays = (Date.now() - Date.parse(o.subject_newest_review_at)) / 86400000;
  assert.ok(ageDays > 11 && ageDays < 13, 'the NEWEST of the reviews, not another: ' + ageDays);
  assert.match(o.reason, /recency=recent/);
  assert.ok(seen.benchmarks.length >= 1, 'no benchmark row written');
  assert.equal(seen.benchmarks[0].subject_newest_review_at, o.subject_newest_review_at);
});

test('AN OLD NEWEST REVIEW (200 days): limited with the recency note, and the assessment still runs', async () => {
  const { body, seen } = await run({ reviews: 900, details: 'days:200' });
  assert.equal(body.coverage.state, 'limited');
  assert.equal(body.coverage.reason, 'newest-review-old');
  assert.match(body.coverage.note, /more than 180 days old/);
  assert.equal(typeof body.healthCheckScore, 'number', 'limited is still assessed');
  assert.ok(seen.modelCalls > 0);
});

test('A FAILED CALL NEVER BLOCKS THE SALE: HTTP 500, REQUEST_DENIED, or a network error leave recency unknown and the gate on the count', async () => {
  for (const details of ['error', 'denied', 'throw']) {
    const { status, body, seen } = await run({ reviews: 900, details });
    assert.equal(seen.detailsUrls.length, 1, details + ': the call was attempted, so this exercises its failure');
    assert.equal(status, 200, details);
    assert.equal(body.coverage.state, 'pass', details);
    assert.equal(typeof body.healthCheckScore, 'number', details);
    const o = seen.outcomes.find((x) => x.kind === 'coverage');
    assert.equal(o.subject_newest_review_at, null, details);
    assert.match(o.reason, /recency=unknown/, details);
  }
});

test('NO CALL when the count alone refuses, and none for an Analytics peer (placeId, no token)', async () => {
  const refused = await run({ reviews: 12, details: 'days:12' });
  assert.equal(refused.body.coverage.state, 'refused-coverage');
  assert.equal(refused.seen.detailsUrls.length, 0, 'a refused subject needs no date');
  const peer = await run({ reviews: 900, details: 'days:12', body: { placeToken: undefined, placeId: 'ChIJ-peer' } });
  assert.equal(peer.seen.detailsUrls.length, 0, 'peers are not gated, so no date is bought for them');
});
