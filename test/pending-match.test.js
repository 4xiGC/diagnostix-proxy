// ════════════════════════════════════════════════════════════════════════════
// v8.11.12: the matcher
//
// THE FIRST TESTS IN THIS REPO. package.json gains "test": "node --test".
// Only the PURE functions are covered: server.js is 5,200 lines, has no
// exports and binds a port at module scope.
//
// WHY THIS RULE IS NOT THE ONE v8.9.37 REMOVED. That rule took the most recent
// report saved by anyone within five minutes and REDIRECTED delivery to the
// survey address on it, so when it latched onto the wrong report the payer got
// nothing and a stranger got an unlock. Two inversions here, and the tests
// below pin both:
//
//   EXACTLY ONE, not newest of many. Two candidates is a refusal.
//   DELIVERY GOES TO THE PAYER, never redirected. The matcher returns a row;
//   it never returns an address to deliver to.
//
// MEASURED, and the reason the "exactly one" guard is load-bearing: across the
// 136 RVP assessments on record, 86 percent of 30 minute windows contain two
// or more. That corpus is dominated by batch testing (93 of 136 on one day, 26
// distinct subjects for 136 runs) so it does not describe customer traffic,
// but it does say plainly that "one in the window" cannot be assumed.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPendingReport, INFER_WINDOW_MS, normalizeEmail } from '../lib-pending.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const min = (n) => n * 60 * 1000;
const PAYER = 'buyer.account@example.com';
const SURVEY = 'front.desk@example.com';

const row = (o) => Object.assign({
  id: 'r1', email_normalized: SURVEY, saved_at: NOW - min(5), claimed_at: null,
}, o);

test('an exact normalized email match wins', () => {
  const r = matchPendingReport({
    payingEmail: PAYER,
    candidates: [row({ id: 'other' }), row({ id: 'mine', email_normalized: PAYER })],
    now: NOW,
  });
  assert.equal(r.decision, 'exact');
  assert.equal(r.match.id, 'mine');
  assert.equal(r.reason, 'exact-email-match');
});

test('exact matching normalizes case and surrounding space on both sides', () => {
  const r = matchPendingReport({
    payingEmail: '  Buyer.Account@Example.COM ',
    candidates: [row({ id: 'mine', email_normalized: PAYER })],
    now: NOW,
  });
  assert.equal(r.decision, 'exact', 'normalization is not applied to both sides');
  assert.equal(normalizeEmail('  Buyer.Account@Example.COM '), PAYER);
});

test('the NEWEST exact match is taken when there are several', () => {
  const r = matchPendingReport({
    payingEmail: PAYER,
    candidates: [
      row({ id: 'older', email_normalized: PAYER, saved_at: NOW - min(20) }),
      row({ id: 'newer', email_normalized: PAYER, saved_at: NOW - min(2) }),
    ],
    now: NOW,
  });
  assert.equal(r.match.id, 'newer');
});

test('an exact match is preferred over a newer inferred candidate', () => {
  const r = matchPendingReport({
    payingEmail: PAYER,
    candidates: [
      row({ id: 'exact-but-older', email_normalized: PAYER, saved_at: NOW - min(25) }),
    ],
    now: NOW,
  });
  assert.equal(r.decision, 'exact');
  assert.equal(r.match.id, 'exact-but-older');
});

test('exactly one unclaimed candidate in the window is an inferred match', () => {
  const r = matchPendingReport({
    payingEmail: PAYER,
    candidates: [row({ id: 'only-one' })],
    now: NOW,
  });
  assert.equal(r.decision, 'inferred');
  assert.equal(r.match.id, 'only-one');
  assert.equal(r.reason, 'single-candidate-in-window');
});

test('TWO candidates in the window must return none, never a choice', () => {
  const r = matchPendingReport({
    payingEmail: PAYER,
    candidates: [row({ id: 'a', saved_at: NOW - min(20) }), row({ id: 'b', saved_at: NOW - min(2) })],
    now: NOW,
  });
  assert.equal(r.decision, 'none', 'the matcher picked one of two candidates; this is the v8.9.37 failure');
  assert.equal(r.match, null);
  assert.match(r.reason, /ambiguous-2-candidates/);
});

test('one candidate at 31 minutes is outside the window and returns none', () => {
  const justIn = matchPendingReport({
    payingEmail: PAYER, candidates: [row({ saved_at: NOW - (INFER_WINDOW_MS - 1000) })], now: NOW,
  });
  assert.equal(justIn.decision, 'inferred', 'control: a candidate just inside the window does match');

  const r = matchPendingReport({
    payingEmail: PAYER, candidates: [row({ saved_at: NOW - min(31) })], now: NOW,
  });
  assert.equal(r.decision, 'none');
  assert.equal(r.reason, 'no-candidate-in-window');
});

test('a candidate saved in the future is not in the window', () => {
  const r = matchPendingReport({
    payingEmail: PAYER, candidates: [row({ saved_at: NOW + min(5) })], now: NOW,
  });
  assert.equal(r.decision, 'none');
});

test('an already claimed row never matches, by either rule', () => {
  const claimedExact = matchPendingReport({
    payingEmail: PAYER,
    candidates: [row({ id: 'x', email_normalized: PAYER, claimed_at: '2026-09-19T11:00:00Z' })],
    now: NOW,
  });
  assert.equal(claimedExact.decision, 'none', 'a claimed row matched on exact email');

  const claimedWindow = matchPendingReport({
    payingEmail: PAYER,
    candidates: [row({ id: 'y', claimed_at: '2026-09-19T11:00:00Z' })],
    now: NOW,
  });
  assert.equal(claimedWindow.decision, 'none', 'a claimed row matched on the window');

  assert.equal(matchPendingReport({
    payingEmail: PAYER, candidates: [row({ id: 'x', email_normalized: PAYER })], now: NOW,
  }).decision, 'exact', 'control: unclaimed, the same row does match exactly');
  assert.equal(matchPendingReport({
    payingEmail: PAYER, candidates: [row({ id: 'y' })], now: NOW,
  }).decision, 'inferred', 'control: unclaimed, the same row does match on the window');
});

test('a claimed row does not count toward the ambiguity check', () => {
  const r = matchPendingReport({
    payingEmail: PAYER,
    candidates: [row({ id: 'live' }), row({ id: 'spent', claimed_at: 'x', saved_at: NOW - min(3) })],
    now: NOW,
  });
  assert.equal(r.decision, 'inferred');
  assert.equal(r.match.id, 'live');
});

test('the matcher never throws and never invents a match', () => {
  for (const c of [undefined, null, [], [null], [{}], 'not an array', 42]) {
    let r;
    assert.doesNotThrow(() => { r = matchPendingReport({ payingEmail: PAYER, candidates: c, now: NOW }); },
      'threw on ' + JSON.stringify(c));
    assert.equal(r.decision, 'none');
    assert.equal(r.match, null);
  }
  for (const e of [undefined, null, '', '   ', {}, 12345]) {
    const r = matchPendingReport({ payingEmail: e, candidates: [row({})], now: NOW });
    assert.equal(r.decision, 'none', 'a blank paying address produced a match');
    assert.equal(r.reason, 'no-paying-email');
  }
});

test('the matcher never returns an address to deliver to', () => {
  const r = matchPendingReport({ payingEmail: PAYER, candidates: [row({})], now: NOW });
  assert.deepEqual(Object.keys(r).sort(), ['decision', 'match', 'reason']);
});
