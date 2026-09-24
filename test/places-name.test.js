// ════════════════════════════════════════════════════════════════════════════
// A CONFIRMED PLACE IS NAMED BY GOOGLE ON EVERY CUSTOMER-FACING LINE, AND THE
// OWNER'S TYPED NAME STAYS THE ALIAS FOR QUERIES (Simon, 2026-09-24, Q5).
//
// The owner types "Teclados" and says Yes to the Places record "Casa Teclados
// SpA". From then on:
//   customer-facing  the Places name: the model prompts that write the prose
//                    (diagnose-p1, diagnose-p2, the executive summary), the
//                    limited note and the refusal copy, the report's subject,
//                    and (through the saved survey) the delivered report and
//                    the purchase email
//   queries          the typed name: every Serper search, every Places text
//                    query, and the subject sent to Analytics' peer comparison
//                    (Analytics uses it as a Places query; see _0924_rvp.md)
// Analytics' own call ({name, location, placeId}, no token) is unchanged: no
// subject block, and its name reaches the prompts as sent.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39473';
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
const { app, setFetch, setClaude, handlePaymentWebhook } = __test__;
const { signPlaceToken } = await import('../lib-place-token.js');

const TYPED = 'Teclados';
const GOOGLE = 'Casa Teclados SpA';
// The peer comparison request contract (identical in diagnostix-analytics/test/fixtures).
const PEER_CONTRACT = JSON.parse((await import('node:fs')).readFileSync(new URL('../contract/peer-comparison-request.contract.json', import.meta.url), 'utf8'));
const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };
const place = (reviewCount) => ({ placeId: 'ChIJ-teclados', name: GOOGLE, address: 'Av. Italia 1234', rating: 4.4, reviewCount, lat: -33.4, lng: -70.6 });

async function diagnose(body) {
  const seen = { prompts: {}, serper: [], placesInputs: [], outcomes: [] };
  const fake = async (url, init) => {
    const u = String(url);
    const i = init || {};
    if (u.includes('google.serper.dev')) { try { seen.serper.push(JSON.parse(i.body).q); } catch { /* not json */ } }
    if (u.includes('maps.googleapis.com')) { const m = /[?&]input=([^&]*)/.exec(u); if (m) seen.placesInputs.push(decodeURIComponent(m[1])); }
    if (u.includes('/rest/v1/rvp_outcomes') && i.body) seen.outcomes.push(JSON.parse(i.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
  };
  const restoreFetch = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  const restoreClaude = setClaude(async (prompt, opts) => {
    const label = (opts && opts.label) || '';
    seen.prompts[label] = String(prompt);
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

// The value on the prompt's own "Restaurant:" line (p1 and p2 write
// "Restaurant:X", the summary writes "Restaurant: X").
const restaurantLine = (p) => { const m = /Restaurant: ?([^\n]*)/.exec(p || ''); return m ? m[1].trim() : null; };

test('CONFIRMED PLACE: the prose prompts name the restaurant by its Places name', async () => {
  const token = signPlaceToken({ place: place(900), secret: 'test-identity-secret', issuedAt: Date.now() });
  const { status, body, seen } = await diagnose({ name: TYPED, location: 'Santiago, Chile', placeToken: token });
  assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
  for (const label of ['diagnose-p1', 'diagnose-p2', 'diagnose-summary']) {
    assert.ok(seen.prompts[label], label + ' was never called, so this proves nothing');
    assert.equal(restaurantLine(seen.prompts[label]), GOOGLE, label + ' names the restaurant as typed');
  }
  assert.deepEqual(body.subject, { name: GOOGLE, typedName: TYPED, placeId: 'ChIJ-teclados' });
});

test('CONFIRMED PLACE: every search still uses the TYPED name, never the Places name', async () => {
  const token = signPlaceToken({ place: place(900), secret: 'test-identity-secret', issuedAt: Date.now() });
  const { seen } = await diagnose({ name: TYPED, location: 'Santiago, Chile', placeToken: token });
  const subjectQueries = seen.serper.filter((q) => /Teclados/.test(q));
  assert.ok(subjectQueries.length >= 3, 'too few subject searches to read: ' + JSON.stringify(seen.serper));
  for (const q of seen.serper.concat(seen.placesInputs)) assert.doesNotMatch(q, /Casa Teclados SpA/, 'a query used the Places name: ' + q);
});

test('A THIN CONFIRMED PLACE: the refusal copy and its outcome row carry the Places name', async () => {
  const token = signPlaceToken({ place: place(12), secret: 'test-identity-secret', issuedAt: Date.now() });
  const { body, seen } = await diagnose({ name: TYPED, location: 'Santiago, Chile', placeToken: token });
  assert.equal(body.refused, true);
  assert.match(body.coverage.copy.heading || JSON.stringify(body.coverage.copy), /Casa Teclados SpA/);
  const row = seen.outcomes.find((o) => o.kind === 'coverage');
  assert.ok(row, 'no coverage row');
  assert.equal(row.delivered_restaurant, GOOGLE);
});

test('ANALYTICS\' CALL IS UNCHANGED: no subject block, and its own name reaches the prompts', async () => {
  const { status, body, seen } = await diagnose({ name: 'Peer Bistro', location: 'Santiago, Chile', placeId: 'ChIJ-peer' });
  assert.equal(status, 200);
  assert.equal(body.subject, undefined);
  assert.equal(restaurantLine(seen.prompts['diagnose-p1']), 'Peer Bistro');
});

test('THE PURCHASE: the email names the Places name, and the peer comparison queries by the typed name', async () => {
  const email = 'owner@example.test';
  const sent = { resend: [], analytics: [] };
  const fake = async (url, init) => {
    const u = String(url);
    const i = init || {};
    let body = null; try { body = i.body ? JSON.parse(i.body) : null; } catch { body = null; }
    let answer = [];
    if (u.includes('api.resend.com')) { sent.resend.push(body); answer = { id: 'e' }; }
    else if (u.startsWith('https://analytics.invalid/peer-comparison')) {
      sent.analytics.push(body);
      answer = { ok: true, html: '<div class="peer-cmp">x</div>', runId: 'r', stats: { named: 1, resolved: 1, assessed: 1, excluded: 0 } };
    } else if (u.includes('/rest/v1/subscribers') && String(i.method || 'GET').toUpperCase() !== 'GET') {
      answer = [{ id: 'row-1', report_token: (body && body.report_token) || 'tok', email }];
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  const restoreFetch = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    // The survey as the page saves it after a confirmed report.
    await realGlobal('http://127.0.0.1:' + server.address().port + '/save-report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, product: 'full',
        report: { pillars: PILLARS, executiveSummary: 'A clean summary.', competitors: [{ name: 'Peer One' }] },
        survey: { name: GOOGLE, typedName: TYPED, location: 'Santiago, Chile', email, contactName: 'Ana' } }) });
    const res = { status() { return res; }, json() { return res; }, send() { return res; }, setHeader() { return res; } };
    await handlePaymentWebhook({ params: { secret: 'a-test-webhook-secret' }, body: { email, product: 'full', firstName: 'Ana' } }, res);
  } finally { server.close(); globalThis.fetch = realGlobal; restoreFetch(); }
  assert.ok(sent.analytics.length, 'the delivery never asked for a peer comparison, so this proves nothing');
  assert.equal(sent.analytics[0].subjectName, TYPED);
  // 2026-09-24: the heading Analytics renders is customer-facing, so the confirmed
  // Google name travels as displayName; subjectName stays the typed query alias.
  assert.equal(sent.analytics[0].displayName, GOOGLE, 'the peer heading would show the typed name');
  const keys = Object.keys(sent.analytics[0]).sort();
  for (const k of Object.keys(PEER_CONTRACT.required)) assert.ok(keys.includes(k), 'missing required ' + k);
  for (const k of keys) assert.ok(k in PEER_CONTRACT.required || k in PEER_CONTRACT.optional, 'not in the contract: ' + k);
  const customer = sent.resend.find((m) => [].concat(m && m.to || []).includes(email));
  assert.ok(customer, 'no email reached the customer: ' + JSON.stringify(sent.resend.map((m) => m && m.subject)));
  assert.match(String(customer.subject) + String(customer.html), /Casa Teclados SpA/);
});
