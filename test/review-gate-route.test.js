// ════════════════════════════════════════════════════════════════════════════
// THE REVIEW GATE ON THE REAL /diagnose ROUTE (overnight 2026-09-26, Item 3).
//
// Drives POST /diagnose over a socket with every outbound call replaced: the
// focal findplacefromtext answers with a scripted user_ratings_total, Serper
// and the other Places calls answer empty, the model is a fake that counts its
// calls, and rvp_outcomes and Resend writes are captured, not sent.
//
//   refused-coverage  no model call at all, an outcome row with the reason, a
//                     lead alert, and the standard's refusal copy returned
//   limited           the assessment runs, carries the limited note, a row
//   pass              the assessment runs, a row
//   ANALYTICS         a caller that supplies placeId (Analytics' peer runs) is
//                     NOT gated: a peer with few reviews is still a peer, and
//                     refusing it would silently shrink the cohort. No row.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39468';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude } = __test__;

const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };

async function run({ reviews, body }) {
  const seen = { outcomes: [], emails: [], modelCalls: 0 };
  const fake = async (url, init) => {
    const u = String(url);
    const ok = (j) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.includes('findplacefromtext') && !seen.focalDone) {
      seen.focalDone = true;
      return ok({ status: 'OK', candidates: [{ place_id: 'ChIJ-teclados', name: 'Teclados', rating: 4.4,
        user_ratings_total: reviews, geometry: { location: { lat: -33.4, lng: -70.6 } } }] });
    }
    if (u.includes('/rest/v1/rvp_outcomes')) { seen.outcomes.push(JSON.parse(init.body)); return { ok: true, status: 201, text: async () => '' }; }
    if (u.includes('api.resend.com')) { seen.emails.push(JSON.parse(init.body)); return ok({ id: 'x' }); }
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
      body: JSON.stringify(Object.assign({ name: 'Teclados', location: 'Santiago, Chile', email: 'owner@example.org' }, body || {})),
    });
    return { status: res.status, body: await res.json(), seen };
  } finally {
    server.close(); globalThis.fetch = realGlobal; restoreClaude(); restoreFetch();
  }
}

test('REFUSED: 12 reviews, no model call, a row with the reason, a lead alert, the standard copy', async () => {
  const { status, body, seen } = await run({ reviews: 12 });
  assert.equal(status, 200);
  assert.equal(body.refused, true);
  assert.equal(body.coverage.state, 'refused-coverage');
  assert.equal(body.coverage.copy.heading, 'We cannot assess Teclados yet');
  assert.match(body.coverage.copy.body[0], /Google lists 12 reviews for Teclados\. The rule requires at least 50\./);
  assert.ok(!('healthCheckScore' in body) && !body.pillars, 'no score on a refusal');
  assert.equal(seen.modelCalls, 0, 'nothing spent on the model');
  assert.equal(seen.outcomes.length, 1);
  const o = seen.outcomes[0];
  assert.equal(o.kind, 'coverage');
  assert.equal(o.decision, 'refused');
  assert.equal(o.coverage_verdict, 'refused-coverage');
  assert.equal(o.subject_review_count, 12);
  assert.equal(o.place_id, 'ChIJ-teclados');
  assert.match(o.reason, /subject-reviews-below-minimum/);
  assert.equal(o.survey_addr_domain, '@example.org');
  assert.equal(seen.emails.length, 1);
  assert.match(seen.emails[0].subject, /^LEAD, review coverage refused: Teclados$/);
  assert.doesNotMatch(JSON.stringify(seen.emails[0]), /owner@/, 'no requester address in the alert');
});

test('LIMITED: 120 reviews, the assessment runs and carries the note', async () => {
  const { status, body, seen } = await run({ reviews: 120 });
  assert.equal(status, 200);
  assert.equal(typeof body.healthCheckScore, 'number');
  assert.equal(body.coverage.state, 'limited');
  assert.match(body.coverage.note, /^Google lists 120 reviews for Teclados, fewer than 300\./);
  assert.equal(seen.outcomes.length, 1);
  assert.equal(seen.outcomes[0].decision, 'limited');
  assert.equal(seen.emails.filter((e) => /^LEAD/.test(e.subject)).length, 0);
});

test('PASS: 900 reviews, the assessment runs with no note', async () => {
  const { body, seen } = await run({ reviews: 900 });
  assert.equal(typeof body.healthCheckScore, 'number');
  assert.equal(body.coverage.state, 'pass');
  assert.equal(body.coverage.note, null);
  assert.equal(seen.outcomes[0].coverage_verdict, 'pass');
  assert.equal(seen.outcomes[0].subject_review_count, 900);
});

test('ANALYTICS: a caller with a placeId is not gated, even at 12 reviews', async () => {
  const { body, seen } = await run({ reviews: 12, body: { placeId: 'ChIJ-teclados', email: undefined } });
  assert.equal(body.refused, undefined);
  assert.equal(typeof body.healthCheckScore, 'number');
  assert.equal(body.coverage, undefined);
  assert.equal(seen.outcomes.length, 0);
  assert.ok(seen.modelCalls > 0);
});
