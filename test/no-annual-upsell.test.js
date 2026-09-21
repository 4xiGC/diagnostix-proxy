// ════════════════════════════════════════════════════════════════════════════
// v8.11.43: THE DELIVERY EMAIL STOPS ADVERTISING A PRODUCT THAT CANNOT BE
// BOUGHT.
//
// The one_off delivery email, the one every paying customer receives, ended
// with: "If you would like ongoing progress tracking, DiagnostiX Annual gives
// you two additional reports, at the 4-month and 8-month marks, to measure
// what is changing year over year."
//
// DiagnostiX Annual was retired in v8.10.0 and is hidden in Wix. There is no
// way to buy it. One subscriber ever bought it, on 2026-05-20, and that was
// the operator's business partner testing the product. The sentence asks a
// customer to want something nobody can sell them.
//
// The Annual branches of this builder are unreachable for the same reason:
// they need plan_type other than one_off, which needs product === 'annual',
// which only unlockAnnual() sets, and nothing live calls it. They are left
// alone here. This commit removes the sentence a real customer reads.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerReportEmail } from '../lib-email.js';

const BASE = 'https://rvp.example.invalid';

// A stored report, in the Supabase snake_case shape the delivery path uses.
const SUBSCRIBER = {
  report_token: 'tok0123456789abcdef',
  restaurant_name: 'The Example Grill',
  first_name: 'Sam',
  plan_type: 'one_off',
  email: 'buyer@example.invalid',
};
const REPORT = {
  healthCheckScore: 71,
  scoreVerdict: 'Solid foundation, uneven execution',
  pillars: {
    food: { score: 74, name: 'Food' },
    service: { score: 68, name: 'Service' },
  },
};
const SURVEY = { savedAt: '2026-09-20T10:00:00Z' };

const build = (over = {}) => buildCustomerReportEmail({
  subscriber: { ...SUBSCRIBER, ...(over.subscriber || {}) },
  report: REPORT, reportNumber: over.reportNumber || 1, survey: SURVEY,
  baseUrl: BASE, ...over,
});

const FORBIDDEN = [/\bAnnual\b/, /\bannual\b/, /99\.99/];

// ── The email a real customer receives ────────────────────────────────────

test('THE DELIVERY EMAIL NAMES NO ANNUAL PRODUCT AND NO 99.99', () => {
  const e = build();
  for (const field of ['subject', 'html', 'text']) {
    const v = String(e[field] == null ? '' : e[field]);
    for (const re of FORBIDDEN) {
      assert.doesNotMatch(v, re, field + ' still carries ' + re + ': '
        + JSON.stringify((v.match(new RegExp('.{0,70}' + re.source + '.{0,70}')) || [''])[0]));
    }
  }
});

test('the specific sentence is gone', () => {
  const e = build();
  assert.doesNotMatch(String(e.html), /ongoing progress tracking/);
  assert.doesNotMatch(String(e.text || ''), /ongoing progress tracking/);
  assert.doesNotMatch(String(e.html), /4-month and 8-month marks/);
});

test('everything else the buyer needs is still there', () => {
  const e = build();
  assert.match(String(e.subject), /Your DiagnostiX Full Report is ready/);
  assert.match(String(e.subject), /The Example Grill/);
  assert.match(String(e.html), /Thank you for purchasing the DiagnostiX Full Report/);
  assert.match(String(e.html), /permanently available/);
  assert.match(String(e.html), /Bookmark it/);
  // The link itself must not move.
  assert.match(String(e.html), new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '/report\\?token=tok0123456789abcdef'));
});

test('the score and the restaurant still render', () => {
  const e = build();
  assert.match(String(e.html), /71/);
  assert.match(String(e.html), /The Example Grill/);
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the forbidden patterns do match when the words are present', () => {
  // All three patterns, in one sample. The first version of this control used
  // a sample with no standalone lowercase "annual" and failed, which is the
  // control doing its job on itself.
  const sample = 'DiagnostiX Annual is an annual plan at $99.99/year.';
  let hits = 0;
  for (const re of FORBIDDEN) if (re.test(sample)) hits += 1;
  assert.equal(hits, 3, 'the patterns cannot detect the copy they are meant to forbid');
});

test('CONTROL: the assertion reads the real builder output, not an empty string', () => {
  const e = build();
  assert.ok(String(e.html).length > 500, 'the builder returned almost nothing: ' + String(e.html).length);
  assert.ok(String(e.subject).length > 10);
});

test('CONTROL: a subscriber with no plan_type still builds an email', () => {
  const e = build({ subscriber: { plan_type: undefined } });
  assert.ok(String(e.html).length > 500);
});
