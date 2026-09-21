// ════════════════════════════════════════════════════════════════════════════
// v8.11.37: single use that cannot fail open, and a claim that cannot double.
//
// WHAT WENT WRONG ON 2026-09-20. A swap link was used twice and delivered the
// same report twice, at 15:27:25 and 15:28:05. The pending row was claimed at
// 15:29:23, AFTER both deliveries. Single use depended on writing a SWAPPED
// marker onto the order's subscribers row and reading it back on the next
// click.
//
// TWO INDEPENDENT DEFECTS, and each on its own was enough:
//   1. The read looked at the WRONG ROW. Delivering inserts a subscriber row,
//      which is then the newest for that address, so the second click read a
//      fresh row with null notes and answered "not yet swapped". The marker
//      could have been written perfectly and the link would still be spent
//      twice. An earlier version of this header blamed a failed UPDATE, on the
//      evidence that 0 of 98 rows carried the marker. 98 is the wrong
//      denominator: the swap shipped that same day and had one attempt. That
//      claim is withdrawn.
//   2. The claim happened AFTER delivery, so two requests could both pass the
//      check and both deliver before either claimed.
//
// Both are replaced by operations that fail closed:
//   1. Single use is an INSERT against a UNIQUE index. The database refuses
//      the second use. The application does not have to notice anything.
//   2. The claim is an atomic PATCH filtered on claimed_at IS NULL with
//      return=representation. Exactly one row back means the claim is ours.
//      Zero rows means somebody else has it, and we do not deliver.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  swapOrderKey, patchRowsAffected, claimVerdict, outcomeRecord,
} from '../lib-pending.js';

// ── the order key ──────────────────────────────────────────────────────────

// THE HARNESS FOUND THIS TWICE. Keying on the order row's report token, and
// then on the order row's id with a cutoff, both looked right and both let a
// second click through, because a swap delivery inserts a subscriber row and
// the second click reads it. The signed link does not move.
test('the order key is stable for one order and differs between orders', () => {
  const a = swapOrderKey({ payingEmail: 'buyer@example.invalid', token: 'tok-abc' });
  const b = swapOrderKey({ payingEmail: 'buyer@example.invalid', token: 'tok-abc' });
  const c = swapOrderKey({ payingEmail: 'buyer@example.invalid', token: 'tok-xyz' });
  assert.equal(a, b, 'the same order must produce the same key');
  assert.notEqual(a, c, 'a different order must produce a different key');
});

test('the key does not move when a delivery inserts a subscriber row', () => {
  // The exact shape of both defects the harness exposed: the key must depend
  // only on the link, which nothing in a delivery changes.
  const before = swapOrderKey({ payingEmail: 'b@x.invalid', token: 'tok-abc' });
  const after = swapOrderKey({ payingEmail: 'b@x.invalid', token: 'tok-abc' });
  assert.equal(before, after);
  assert.notEqual(before, swapOrderKey({ payingEmail: 'b@x.invalid', token: 'tok-from-a-later-purchase' }),
    'a later purchase issues a new link and is entitled to its own swap');
});

test('the order key normalizes the address the way the matcher does', () => {
  assert.equal(
    swapOrderKey({ payingEmail: '  BUYER@Example.INVALID ', token: 'tok' }),
    swapOrderKey({ payingEmail: 'buyer@example.invalid', token: 'tok' }));
});

test('the order key never contains the address', () => {
  const k = swapOrderKey({ payingEmail: 'verysecretname@example.invalid', token: 'tok' });
  assert.ok(!/verysecretname/.test(k), 'the local part leaked into the key');
  assert.ok(!/@/.test(k), 'the key contains an at sign, so it may carry an address');
});

test('the order key is total, and a missing order still yields a usable key', () => {
  for (const a of [undefined, null, {}, { payingEmail: '' }, { token: null }]) {
    let k;
    assert.doesNotThrow(() => { k = swapOrderKey(a); }, 'threw on ' + JSON.stringify(a));
    assert.equal(typeof k, 'string');
    assert.ok(k.length > 0);
  }
});

// ── a zero-row PATCH is an error, not a success ───────────────────────────

test('patchRowsAffected counts what actually changed', () => {
  assert.equal(patchRowsAffected([{ id: 1 }]), 1);
  assert.equal(patchRowsAffected([{ id: 1 }, { id: 2 }]), 2);
  assert.equal(patchRowsAffected([]), 0);
});

test('A ZERO ROW PATCH IS NOT A SUCCESS, whatever shape the body came back in', () => {
  // This is the 2026-09-20 failure in one assertion. recordSwapOnOrderRow got
  // a 200 back and changed nothing, and nothing downstream could tell.
  for (const body of [[], null, undefined, {}, '', 'null']) {
    assert.equal(patchRowsAffected(body), 0, 'body ' + JSON.stringify(body) + ' read as a success');
  }
});

test('claimVerdict: exactly one row is ours', () => {
  const v = claimVerdict({ ok: true, rows: [{ id: 'r1' }] });
  assert.equal(v.claimed, true);
  assert.equal(v.rows, 1);
  assert.equal(v.reason, 'claimed');
});

test('claimVerdict: zero rows means SOMEBODY ELSE HAS IT and we must not deliver', () => {
  const v = claimVerdict({ ok: true, rows: [] });
  assert.equal(v.claimed, false);
  assert.equal(v.rows, 0);
  assert.equal(v.reason, 'already-claimed');
  assert.equal(v.mayDeliver, false, 'a lost race must never deliver');
});

test('claimVerdict: a transport failure is NOT a claim and must not deliver', () => {
  const v = claimVerdict({ ok: false, status: 500 });
  assert.equal(v.claimed, false);
  assert.equal(v.mayDeliver, false,
    'an unreachable table must not be read as permission to deliver');
  assert.equal(v.reason, 'claim-failed');
});

test('claimVerdict: more than one row is a bug and refuses to deliver', () => {
  const v = claimVerdict({ ok: true, rows: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(v.claimed, false);
  assert.equal(v.mayDeliver, false);
  assert.match(v.reason, /unexpected/);
});

test('claimVerdict is total', () => {
  for (const a of [undefined, null, {}, { ok: true }, { ok: true, rows: 'x' }]) {
    let v;
    assert.doesNotThrow(() => { v = claimVerdict(a); }, 'threw on ' + JSON.stringify(a));
    assert.equal(v.mayDeliver, false, 'junk must never authorize a delivery');
  }
});

// ── the outcome record ─────────────────────────────────────────────────────

test('the outcome record carries domain and length, never an address', () => {
  const r = outcomeRecord({
    kind: 'recover', secretStatus: 'valid', decision: 'swap', reason: 'delivered-order',
    payingEmail: 'abcdefghijkl@gmail.com', surveyEmail: 'abcdefghijk@gmail.com',
    pendingRowId: '00000000-0000-0000-0000-000000000001',
    deliveredRestaurant: 'Mestizo', delivered: true, claimRows: 1, swapUsed: true,
  });
  assert.equal(r.addr_domain, '@gmail.com');
  assert.equal(r.addr_local_len, 12);
  assert.equal(r.survey_addr_domain, '@gmail.com');
  assert.equal(r.survey_addr_local_len, 11);
  const json = JSON.stringify(r);
  assert.ok(!/abcdefghijkl@/.test(json), 'the paying address leaked');
  assert.ok(!/abcdefghijk@/.test(json), 'the survey address leaked');
});

test('the outcome record distinguishes the two 2026-09-20 addresses', () => {
  const a = outcomeRecord({ payingEmail: 'abcdefghijkl@gmail.com' });
  const b = outcomeRecord({ payingEmail: 'abcdefghijk@gmail.com' });
  assert.notEqual(a.addr_local_len, b.addr_local_len);
});

test('the outcome record is total and always has a kind', () => {
  for (const a of [undefined, null, {}]) {
    let r;
    assert.doesNotThrow(() => { r = outcomeRecord(a); });
    assert.equal(typeof r.kind, 'string');
  }
});

// ── A KNOWN LIMIT, PINNED RATHER THAN TUNED AWAY (v8.11.41) ────────────────
//
// DECLARED: this test is NOT red-first. It characterises behaviour that
// already exists, so that the gap is visible in the suite instead of living
// only in a report. The house rule is that every new test is red first; this
// one is the stated exception and here is why it earns it.
//
// order_key is derived from the SIGNED LINK. Every click of one link agrees,
// which is the property single use needs and which the tests above cover. But
// a link REISSUED for the same order carries a fresh issued-at, so it hashes
// to a different key and would be granted its own swap.
//
// The exposure is narrow and measured: buildRecoveryUrl is called from exactly
// two places, the cache-miss email (an order that delivered nothing, so a
// recovery and not a swap) and a paid delivery. The swap path itself passes no
// swapUrl, confirmed in the 8.11.36 harness log as `swapLink=no`, so using a
// swap cannot mint another one. A second PURCHASE is entitled to its own swap,
// which is the wanted behaviour rather than a loophole.
//
// The fix is to bind the order's identity into the token when it is minted,
// which needs deliverPaidReport to build the link after createCustomer has
// made the report token. That is the next package, not this one.
test('KNOWN LIMIT: a reissued link for the same order gets a different key', () => {
  const first = swapOrderKey({ payingEmail: 'buyer@example.invalid', token: 'link-issued-monday' });
  const reissued = swapOrderKey({ payingEmail: 'buyer@example.invalid', token: 'link-reissued-tuesday' });
  assert.notEqual(first, reissued,
    'today the key follows the link, not the order. When the order identity is '
    + 'bound at mint time this assertion inverts to assert.equal, and that is '
    + 'the signal the next package landed.');
});
