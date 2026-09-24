// ════════════════════════════════════════════════════════════════════════════
// v8.11.42: the alert says what actually happened, the page knows which mode
// it is in, and a PostgREST failure names its constraint without quoting a
// credential.
//
// All four came out of the 2026-09-21 swap retest:
//
//   1. The subscribers-update-noop alert opened with "A call reached
//      /payment-webhook and was not processed ... no sale is being delivered"
//      and closed with the 2026-09-19 missing-slash paragraph. Both are false
//      for that kind: a sale WAS delivered and no URL is broken.
//   2. The 409 that finally explained the whole thing was logged as a bare
//      status. code=23505 and the constraint name were sitting in the response
//      body and nobody looked.
//   3. A buyer whose order HAD delivered was shown the recovery copy, "we
//      could not match it to a finished HealthCheck", which is untrue for a
//      swap.
//   4. Two of the three failed attempts typed the PAYING address. The page
//      answered with a generic not-found, which does not tell them the one
//      thing they need to know.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertCopyFor, ALERT_DEFAULT_OPENING, ALERT_DEFAULT_CLOSING,
  pgErrorFields, redactPgDetails,
  recoveryCopy, recoveryNotFound,
} from '../lib-pending.js';

// ── the alert, per kind ─────────────────────────────────────────────────────

test('subscribers-update-noop gets its own opening and NO closing', () => {
  const c = alertCopyFor('subscribers-update-noop');
  assert.equal(c.opening, 'A write to the sale record changed nothing. The report was '
    + 'delivered and the customer is unaffected. The order row still shows the original report.');
  assert.equal(c.closing, '', 'the missing-slash paragraph is about a different failure');
  assert.ok(!/payment-webhook/.test(c.opening), 'no sale was blocked, so do not say one was');
  assert.ok(!/no sale is being delivered/.test(c.opening));
});

test('every other kind keeps today s webhook text, unchanged', () => {
  for (const kind of ['webhook-misrouted', 'unorderable-candidates', 'claim-release-failed',
                      'swap-table-missing', 'recovery-locked', 'something-new']) {
    const c = alertCopyFor(kind);
    assert.equal(c.opening, ALERT_DEFAULT_OPENING, kind + ' must not have been changed');
    assert.equal(c.closing, ALERT_DEFAULT_CLOSING, kind + ' must keep the missing-slash note');
  }
  // 2026-09-24: summary-gate-failed is NOT a webhook kind. It left this default
  // after the alert told Simon no sale was being delivered when one had been.
  const s = alertCopyFor('summary-gate-failed');
  assert.notEqual(s.opening, ALERT_DEFAULT_OPENING);
  assert.equal(s.closing, '');
  assert.equal(s.requestNote, false);
});

test('alertCopyFor never throws on junk and falls back to the default', () => {
  for (const junk of [undefined, null, 0, {}, [], 'ok']) {
    const c = alertCopyFor(junk);
    assert.equal(typeof c.opening, 'string');
    assert.equal(typeof c.closing, 'string');
  }
});

// ── the PostgREST error, without the credential ─────────────────────────────

// THE REAL 409 BODY from 2026-09-21. Note what is in `details`: the report
// TOKEN, which is the credential that opens the paid report. The brief asked
// for details to be logged. The value inside it must not be.
const REAL_409 = {
  code: '23505',
  details: 'Key (report_token)=(6f2a9c1e-88b4-4d7a-9a21-0f3c5d2e7b10) already exists.',
  hint: null,
  message: 'duplicate key value violates unique constraint "subscribers_report_token_key"',
};

test('the constraint name is recovered even though PostgREST does not return a constraint field', () => {
  assert.equal(REAL_409.constraint, undefined, 'the fixture must match the real shape');
  const f = pgErrorFields(REAL_409);
  assert.equal(f.code, '23505');
  assert.equal(f.constraint, 'subscribers_report_token_key');
});

test('the report token NEVER reaches the log', () => {
  const f = pgErrorFields(REAL_409);
  assert.ok(!/6f2a9c1e/.test(f.details), 'the colliding value is a credential');
  assert.ok(!/6f2a9c1e/.test(JSON.stringify(f)), 'and it must not survive anywhere in the result');
  assert.ok(/report_token/.test(f.details), 'the COLUMN name is the diagnostic and must survive');
});

test('redactPgDetails masks every parenthesised value, not just the first', () => {
  const out = redactPgDetails('Key (a, b)=(secret-one) conflicts with (c)=(secret-two).');
  assert.ok(!/secret-one/.test(out));
  assert.ok(!/secret-two/.test(out));
});

test('pgErrorFields never throws and answers null when there is nothing to say', () => {
  for (const junk of [undefined, null, 'a string', 42, []]) {
    const f = pgErrorFields(junk);
    assert.equal(f.code, null);
    assert.equal(f.constraint, null);
    assert.equal(f.details, null);
  }
});

// ── the page, per mode ──────────────────────────────────────────────────────

test('swap mode says the order delivered, and names the restaurant', () => {
  const c = recoveryCopy({ mode: 'swap', restaurant: 'Gordon Ramsey at Trianon' });
  assert.equal(c.heading, 'Send me a different report');
  assert.equal(c.intro, 'Your order delivered the report for Gordon Ramsey at Trianon. '
    + 'If you completed another survey under a different email address, enter that address '
    + 'and we will send that report instead. Each order includes one swap.');
  assert.equal(c.label, 'The email you typed into the other survey (not the one you paid with)');
  assert.ok(!/could not match/.test(c.intro), 'that sentence is false for a swap');
});

test('recovery mode keeps today s copy and gains only the clearer label', () => {
  const c = recoveryCopy({ mode: 'recovery' });
  assert.equal(c.heading, 'Find your DiagnostiX report');
  assert.ok(/could not match it to a finished/.test(c.intro), 'recovery copy is unchanged');
  assert.equal(c.label, 'The email you typed into the survey (not the one you paid with)');
});

test('swap mode with no restaurant name falls back to recovery copy', () => {
  // The conservative option. Swap copy asserts "your order delivered the
  // report for X", and with no X there is no honest way to say it.
  for (const r of [undefined, null, '', '   ']) {
    const c = recoveryCopy({ mode: 'swap', restaurant: r });
    assert.equal(c.heading, 'Find your DiagnostiX report');
  }
});

test('recoveryCopy never throws on junk', () => {
  for (const junk of [undefined, null, 0, 'swap', []]) {
    const c = recoveryCopy(junk);
    assert.equal(typeof c.heading, 'string');
    assert.equal(typeof c.intro, 'string');
    assert.equal(typeof c.label, 'string');
  }
});

// ── the not-found line ──────────────────────────────────────────────────────

test('typing the PAYING address is named, not answered generically', () => {
  const msg = recoveryNotFound({ mode: 'swap', typed: 'buyer@example.invalid',
                                 payingEmail: 'buyer@example.invalid' });
  assert.equal(msg, 'That is the address you paid with. Enter the address you typed '
    + 'into the other survey.');
});

test('the paying-address check normalizes the way the matcher does', () => {
  const msg = recoveryNotFound({ mode: 'swap', typed: '  BUYER@Example.INVALID ',
                                 payingEmail: 'buyer@example.invalid' });
  assert.ok(/address you paid with/.test(msg), 'case and spacing must not defeat it');
});

test('swap mode not-found says survey, recovery mode keeps today s line', () => {
  const swap = recoveryNotFound({ mode: 'swap', typed: 'other@example.invalid',
                                  payingEmail: 'buyer@example.invalid' });
  assert.equal(swap, 'We have no unfinished survey waiting under that address. '
    + 'Check the spelling, or reply to your receipt and we will help.');
  const rec = recoveryNotFound({ mode: 'recovery', typed: 'other@example.invalid',
                                 payingEmail: 'buyer@example.invalid' });
  assert.equal(rec, 'We have no unclaimed report for that address.');
});

test('an empty typed address is not treated as matching the paying address', () => {
  // Guards the normalize-both-to-empty trap: '' === '' would otherwise tell a
  // buyer who typed nothing that they had typed their own address.
  const msg = recoveryNotFound({ mode: 'swap', typed: '', payingEmail: '' });
  assert.ok(!/address you paid with/.test(msg));
});
