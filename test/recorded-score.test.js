// ════════════════════════════════════════════════════════════════════════════
// EVERY PLACE THAT RECORDS A SCORE RECORDS THE COMPUTED ONE, NEVER 0.
//
// WHY THIS EXISTS. 8.11.52 stopped the model writing healthCheckScore, and
// seven readers still took the score from that field with `|| 0`. The B2 test
// sale on 2026-09-23 stored baseline_score 0, sent the internal summary email
// as "Score 0" in red, and pushed 0 with a blank verdict to HubSpot. Every row
// before 8.11.52 carried its real score.
//
// THE READERS, each driven through its real function with the transport
// replaced so the exact value sent can be read back:
//
//   subscribers.baseline_score   createCustomer, writeOrderRow
//   internal summary email       sendInternalSummaryEmail (subject and body)
//   HubSpot                      saveToHubSpot (score AND verdict),
//                                markPurchasedAndEmail (the note),
//                                pushReportContextToHubSpot (latest, baseline)
//
// TWO PAYLOAD SHAPES, both with six pillars whose mean rounds to 59:
//   NO_FIELD   no healthCheckScore at all, the 8.11.52 shape. Old code: 0.
//   TYPED_72   the model's typed 72, the shape of every older payload. Old
//              code: 72, the inflated number the page stopped printing.
// The recorded score must be 59 for both.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39463';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.HUBSPOT_TOKEN = 'test-not-a-token';

const { __test__ } = await import('../server.js');
const { setFetch, createCustomer, writeOrderRow, sendInternalSummaryEmail,
        saveToHubSpot, markPurchasedAndEmail, pushReportContextToHubSpot } = __test__;

const PILLARS = {
  cs: { score: 66, label: 'Customer Sentiment' }, pa: { score: 70, label: 'Pricing & Accessibility' },
  es: { score: 42, label: 'Employee Sentiment' }, sm: { score: 48, label: 'Social Media Impact' },
  cp: { score: 58, label: 'Competitive Positioning' }, bg: { score: 72, label: 'Brand Experience & Growth' },
};
const SHAPES = {
  NO_FIELD: { pillars: PILLARS },
  TYPED_72: { pillars: PILLARS, healthCheckScore: 72, scoreVerdict: 'Good' },
};
const EXPECT = 59, BAND = 'Fair';

// Records every outbound request and answers each plausibly: a contact search
// finds one contact, a table write returns one row.
async function capture(fn) {
  const calls = [];
  const fake = async (url, init) => {
    const i = init || {};
    let body = null;
    try { body = i.body ? JSON.parse(i.body) : null; } catch (_) { body = i.body; }
    calls.push({ url: String(url), method: String(i.method || 'GET').toUpperCase(), body });
    const answer = /\/rest\/v1\//.test(String(url)) ? [{ id: 'row-1', report_token: (body && body.report_token) || null }]
      : { id: 'c1', results: [{ id: 'c1' }] };
    return { ok: true, status: 200, headers: { get: () => null },
             json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  const restore = setFetch(fake);
  const realGlobal = globalThis.fetch;
  globalThis.fetch = fake;
  try { await fn(); } finally { globalThis.fetch = realGlobal; restore(); }
  return calls;
}

const subscriberRow = { email: 'owner@example.test', first_name: 'Ana', restaurant_name: 'Teclados',
  report_token: 'tok', plan_type: 'one_off', subscribed_at: '2026-09-23T12:00:00Z', amount_paid: 24.99 };

for (const [shape, report] of Object.entries(SHAPES)) {
  test(shape + ': createCustomer writes baseline_score ' + EXPECT, async () => {
    const calls = await capture(() => createCustomer({ email: 'owner@example.test', firstName: 'Ana',
      restaurantName: 'Teclados', location: 'Santiago', website: '', report, survey: {},
      planType: 'one_off', amountPaid: 24.99, orderKey: null }));
    const w = calls.find((c) => /\/rest\/v1\/subscribers/.test(c.url) && c.method === 'POST');
    assert.ok(w, 'no subscribers insert was made');
    assert.equal(w.body.baseline_score, EXPECT);
  });

  test(shape + ': writeOrderRow writes baseline_score ' + EXPECT + ', insert and patch', async () => {
    for (const targetRowId of [undefined, 'row-1']) {
      const calls = await capture(() => writeOrderRow({ email: 'owner@example.test', firstName: 'Ana',
        restaurantName: 'Teclados', location: 'Santiago', report, survey: {}, planType: 'one_off',
        amountPaid: 24.99, forceToken: 'tok', targetRowId }));
      const w = calls.find((c) => /\/rest\/v1\/subscribers/.test(c.url) && (c.method === 'POST' || c.method === 'PATCH'));
      assert.ok(w, 'no subscribers write was made (target ' + targetRowId + ')');
      assert.equal(w.body.baseline_score, EXPECT, 'target ' + targetRowId);
    }
  });

  test(shape + ': the internal summary email says Score ' + EXPECT + ' and ' + BAND, async () => {
    const calls = await capture(() => sendInternalSummaryEmail({ subscriber: subscriberRow, report,
      reportNumber: 1, survey: { location: 'Santiago' } }));
    const mail = calls.find((c) => /resend\.com/.test(c.url));
    assert.ok(mail, 'no email was sent');
    assert.match(mail.body.subject, new RegExp('Score ' + EXPECT + '$'));
    assert.match(mail.body.html, new RegExp('>' + EXPECT + ' / 100<'));
    assert.match(mail.body.html, new RegExp('\\(' + BAND + '\\)'));
  });

  test(shape + ': saveToHubSpot sends score ' + EXPECT + ' and verdict ' + BAND, async () => {
    const calls = await capture(() => saveToHubSpot('owner@example.test', 'Ana', 'Teclados', 'Santiago', report));
    const hs = calls.find((c) => /hubapi\.com\/crm\/v3\/objects\/contacts$/.test(c.url));
    assert.ok(hs, 'no HubSpot contact write');
    assert.equal(hs.body.properties.diagnostix_score, EXPECT);
    assert.equal(hs.body.properties.diagnostix_verdict, BAND);
  });

  test(shape + ': the HubSpot purchase note says Score: ' + EXPECT, async () => {
    const calls = await capture(() => markPurchasedAndEmail('owner@example.test', 'Ana', 'Teclados', report, 'full'));
    const note = calls.find((c) => /hubapi\.com\/crm\/v3\/objects\/notes/.test(c.url));
    assert.ok(note, 'no HubSpot note');
    assert.match(note.body.properties.hs_note_body, new RegExp('Score: ' + EXPECT + '\\.'));
  });

  test(shape + ': pushReportContextToHubSpot sends latest and baseline ' + EXPECT, async () => {
    const calls = await capture(() => pushReportContextToHubSpot({ subscriber: subscriberRow, report,
      reportNumber: 1, reportUrl: 'https://x.invalid/report?token=tok', baseline: report }));
    const hs = calls.find((c) => /hubapi\.com/.test(c.url) && c.body && c.body.properties
      && 'diagnostix_latest_score' in c.body.properties);
    assert.ok(hs, 'no HubSpot context push');
    assert.equal(hs.body.properties.diagnostix_latest_score, EXPECT);
    assert.equal(hs.body.properties.diagnostix_baseline_score, EXPECT);
  });
}

test('CONTROL: with five pillars no reader invents a number', async () => {
  const five = { pillars: Object.fromEntries(Object.entries(PILLARS).filter(([k]) => k !== 'es')), healthCheckScore: 72 };
  const calls = await capture(() => saveToHubSpot('owner@example.test', 'Ana', 'Teclados', 'Santiago', five));
  const hs = calls.find((c) => /hubapi\.com\/crm\/v3\/objects\/contacts$/.test(c.url));
  assert.notEqual(hs.body.properties.diagnostix_score, 72, 'the typed score came back');
  assert.equal(hs.body.properties.diagnostix_verdict, '');
});
