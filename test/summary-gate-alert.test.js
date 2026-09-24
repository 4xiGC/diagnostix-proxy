// ════════════════════════════════════════════════════════════════════════════
// THE summary-gate-failed ALERT SAYS WHAT HAPPENED: THE SALE WAS DELIVERED,
// WITHOUT AN EXECUTIVE SUMMARY.
//
// 2026-09-24: the alert sent when the summary failed the gate twice opened with
// "A call reached /payment-webhook and was not processed. If this is the Wix
// automation, no sale is being delivered until the URL is fixed.", closed with
// the 2026-09-19 missing-slash paragraph, and ended "a rejected call is not
// trusted enough to quote". All three are false for this kind: nothing was
// rejected and the sale was delivered. alertCopyFor gave its own copy only to
// subscribers-update-noop and the webhook default to everything else.
//
// Driven through the REAL path: writeExecutiveSummary with a model that fails
// the gate twice, and the module's fetch capturing the Resend call. No network,
// no model: both are replaced through the seam.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39381';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.RESEND_API_KEY = 'test-key-not-real';

const { __test__ } = await import('../server.js');
const { writeExecutiveSummary, setClaude, setFetch } = __test__;
const { alertCopyFor, ALERT_DEFAULT_OPENING } = await import('../lib-pending.js');

const REPORT = {
  pillars: {
    cs: { score: 66, label: 'Customer Sentiment' }, pa: { score: 70, label: 'Pricing' },
    es: { score: 42, label: 'Employee' }, sm: { score: 48, label: 'Social' },
    cp: { score: 58, label: 'Competitive' }, bg: { score: 72, label: 'Brand' },
  },
  strengths: ['Strong kitchen'], risks: ['Thin staffing'],
};

test('THE summary-gate-failed ALERT SAYS THE SALE WAS DELIVERED WITHOUT A SUMMARY, AND NOTHING ABOUT THE WEBHOOK', async () => {
  const sent = [];
  const restoreFetch = setFetch(async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'test' }) };
    }
    throw new Error('unexpected fetch ' + url);
  });
  // The band is Fair; "strong" and "excellent" contradict it, twice.
  const restoreClaude = setClaude(async () => ({ executiveSummary: 'Teclados is a strong and excellent restaurant.' }));
  try {
    const r = await writeExecutiveSummary({ name: 'Teclados', location: 'Santiago', report: REPORT, score: 59, band: 'Fair' });
    assert.equal(r.reason, 'gate-failed-twice');
  } finally { restoreClaude(); restoreFetch(); }

  const alert = sent.find((m) => /summary-gate-failed/.test(m.subject));
  assert.ok(alert, 'the alert was sent');
  assert.match(alert.html, /delivered without an executive summary/i);
  assert.doesNotMatch(alert.html, /payment-webhook/, 'no webhook call was involved');
  assert.doesNotMatch(alert.html, /no sale is being delivered/);
  assert.doesNotMatch(alert.html, /missing|glued on with no slash/, 'the 2026-09-19 slash paragraph is about a different failure');
  assert.doesNotMatch(alert.html, /rejected call/, 'nothing was rejected');
});

test('CONTROL: a webhook kind keeps the webhook opening', () => {
  assert.equal(alertCopyFor('webhook-misrouted').opening, ALERT_DEFAULT_OPENING);
  assert.notEqual(alertCopyFor('webhook-misrouted').requestNote, false);
});
