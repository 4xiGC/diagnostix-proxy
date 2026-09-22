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
// v8.11.46 CORRECTS A CLAIM MADE HERE AT v8.11.43. This file said the Annual
// branches were unreachable because nothing live sets product === 'annual'.
// THAT WAS WRONG, and the ship gate caught it by rendering all 99 stored
// reports: ONE SUBSCRIBER ROW ALREADY HAS plan_type = 'annual', written on
// 2026-05-20. Nothing new can reach those branches, but that row can, and any
// redelivery or swap for it would send "Welcome to DiagnostiX Annual".
//
// Reachability is a property of the DATA as well as the code, and the code
// alone was read. The branches are now collapsed: every delivery uses the
// one-off copy, because the progress-report product they described was
// retired in v8.10.0 and cannot produce report 2 or report 3 either.
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
// v8.11.50: THE SIX REAL PILLARS, because the email now computes the score
// from them. This fixture carried two pillars under invented keys (food,
// service), which no RVP payload has ever had, and the email took its number
// from healthCheckScore so nothing noticed. Once the score was computed,
// computeOverall correctly refused this payload and the score block vanished,
// and the test below failed on a fixture that did not model a real report.
// 74 + 68 + 70 + 72 + 71 + 71 = 426, over 6 is exactly 71, so the number this
// file has always asserted is still the right one and is now the computed one.
const REPORT = {
  healthCheckScore: 71,
  scoreVerdict: 'Solid foundation, uneven execution',
  pillars: {
    cs: { score: 74, label: 'Customer Sentiment', status: 'good' },
    pa: { score: 68, label: 'Pricing & Accessibility', status: 'good' },
    es: { score: 70, label: 'Employee Sentiment', status: 'good' },
    sm: { score: 72, label: 'Social Media Impact', status: 'good' },
    cp: { score: 71, label: 'Competitive Positioning', status: 'good' },
    bg: { score: 71, label: 'Brand Experience & Growth', status: 'good' },
  },
};
const SURVEY = { savedAt: '2026-09-20T10:00:00Z' };

// The first version of this helper spread `over` AFTER the merged subscriber,
// so an override of { subscriber: { plan_type: 'annual' } } replaced the whole
// subscriber and dropped the restaurant name. The test then failed on a
// difference the helper had created. Overrides are applied per field.
const build = (over = {}) => {
  const { subscriber: subOver, ...rest } = over;
  return buildCustomerReportEmail({
    subscriber: { ...SUBSCRIBER, ...(subOver || {}) },
    report: REPORT,
    reportNumber: 1,
    survey: SURVEY,
    baseUrl: BASE,
    ...rest,
  });
};

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

test('CONTROL: the 71 above is the COMPUTED score, not the typed one', () => {
  // They are deliberately equal in this fixture so the assertion above did not
  // have to change. That makes it useless as evidence about WHICH number is
  // rendered, so the point is made here instead: move one pillar and the
  // rendered number moves with it.
  const moved = { ...REPORT, pillars: { ...REPORT.pillars,
    cs: { score: 44, label: 'Customer Sentiment', status: 'bad' } } };
  const e = build({ report: moved });
  assert.match(String(e.html), /66/, 'the email did not follow the pillars');
  assert.doesNotMatch(String(e.html), />71</, 'the email is still showing the typed 71');
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

// ── The stored annual row, which the gate found ───────────────────────────

test('A STORED plan_type=annual ROW ALSO GETS AN EMAIL NAMING NO ANNUAL', () => {
  const e = build({ subscriber: { plan_type: 'annual' } });
  for (const field of ['subject', 'html', 'text']) {
    const v = String(e[field] == null ? '' : e[field]);
    for (const re of FORBIDDEN) {
      assert.doesNotMatch(v, re, field + ' still carries ' + re + ' for an annual row: '
        + JSON.stringify((v.match(new RegExp('.{0,70}' + re.source + '.{0,70}')) || [''])[0]));
    }
  }
});

test('the annual row gets the SAME copy as everyone else', () => {
  const a = build({ subscriber: { plan_type: 'annual' } });
  const o = build();
  assert.equal(a.subject, o.subject, 'two customers get two different subjects for one product');
  assert.match(String(a.html), /Thank you for purchasing the DiagnostiX Full Report/);
});

test('report 2 and report 3 numbers cannot resurrect the retired copy', () => {
  // generateProgressReport went with the plan in v8.10.0, so nothing produces
  // these any more. If anything ever calls with reportNumber 2 or 3, it must
  // not promise a progress product that does not exist.
  for (const n of [2, 3]) {
    const e = build({ subscriber: { plan_type: 'annual' }, reportNumber: n });
    for (const re of [...FORBIDDEN, /progress report/i, /8-month mark/, /Month 4/, /Month 8/]) {
      assert.doesNotMatch(String(e.html), re, 'reportNumber ' + n + ' still carries ' + re);
    }
  }
});
