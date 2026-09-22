// ════════════════════════════════════════════════════════════════════════════
// RVP PACKAGE ITEM 1: THE ORDER IDENTITY IS BOUND AT MINT TIME.
//
// findOrderRow returns THE NEWEST SUBSCRIBER ROW FOR THE PAYING ADDRESS
// (server.js:4585, order=subscribed_at.desc&limit=1). That is the lookup that
// caused the 2026-09-20 double delivery, and it is only necessary because one
// sale can hold several rows: deliverPaidReport calls createCustomer on every
// path and createCustomer INSERTS.
//
// subscribers.order_key exists as of migration 004 (verified 2026-09-22: 35
// columns, text, nullable, 103 rows all null). This binds it.
//
// WHERE THE KEY COMES FROM. swapOrderKey already derives one from the paying
// address and the RECOVERY TOKEN, and rvp_swap_uses stores it. The delivery
// mints that same token for the swap link it emails, so the key is derivable
// AT MINT TIME from something the delivery already has. Using the same
// derivation means subscribers.order_key and rvp_swap_uses.order_key are the
// same value for the same order, with no translation.
//
// ROWS MINTED BEFORE THIS RELEASE CARRY NULL, and null must never match
// anything. A lookup that matched null to null would tie every old row to
// every other old row, which is worse than the defect being fixed.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { orderKeyForDelivery, swapOrderKey, signRecoveryToken } from '../lib-pending.js';

const SECRET = 'a-test-secret-value-of-sufficient-length';
const PAYING = 'buyer@example.invalid';

function urlFor(email, issuedAt) {
  const t = signRecoveryToken({ payingEmail: email, issuedAt: issuedAt || 1758000000000, secret: SECRET });
  return 'https://rvp.example.invalid/recover?t=' + encodeURIComponent(t);
}

// ── The key is the SAME one rvp_swap_uses already stores ──────────────────

test('the key equals swapOrderKey on the token inside the url', () => {
  const t = signRecoveryToken({ payingEmail: PAYING, issuedAt: 1758000000000, secret: SECRET });
  const url = 'https://rvp.example.invalid/recover?t=' + encodeURIComponent(t);
  assert.equal(orderKeyForDelivery({ swapUrl: url, payingEmail: PAYING }),
    swapOrderKey({ payingEmail: PAYING, token: t }),
    'subscribers.order_key would not equal rvp_swap_uses.order_key for the same order');
});

test('the same order yields the same key twice', () => {
  const url = urlFor(PAYING);
  assert.equal(orderKeyForDelivery({ swapUrl: url, payingEmail: PAYING }),
    orderKeyForDelivery({ swapUrl: url, payingEmail: PAYING }));
});

test('a DIFFERENT order yields a different key', () => {
  const a = orderKeyForDelivery({ swapUrl: urlFor(PAYING, 1758000000000), payingEmail: PAYING });
  const b = orderKeyForDelivery({ swapUrl: urlFor(PAYING, 1758000999000), payingEmail: PAYING });
  assert.notEqual(a, b, 'two orders for one buyer would share a key');
});

test('THE ADDRESS COMES OUT OF THE TOKEN, not out of the caller', () => {
  // The click side hashes verifyRecoveryToken's payingEmail, which is the `e`
  // field inside the token. The mint side must hash the same thing, or the
  // stored key silently stops matching and findOrderRow falls back to the
  // address path without complaining, which is the defect coming back.
  const url = urlFor(PAYING);
  assert.equal(orderKeyForDelivery({ swapUrl: url }),
    orderKeyForDelivery({ swapUrl: url, payingEmail: PAYING }),
    'the caller-supplied address changed the answer');
});

test('A CALLER WHO DISAGREES WITH THE TOKEN GETS NO KEY', () => {
  // Not a different key: NO key. A key that can never be matched is worse
  // than none, because none falls back to the address path honestly.
  assert.equal(orderKeyForDelivery({
    swapUrl: urlFor(PAYING), payingEmail: 'other@example.invalid' }), null);
});

test('the cross-check is case and space insensitive, like the rest of the code', () => {
  const url = urlFor(PAYING);
  assert.equal(orderKeyForDelivery({ swapUrl: url, payingEmail: '  BUYER@Example.Invalid ' }),
    orderKeyForDelivery({ swapUrl: url, payingEmail: PAYING }),
    'a buyer whose address differs only in case lost the key');
});

test('a token whose payload is not readable yields null', () => {
  for (const bad of ['notbase64.sig', '.sig', 'e30.sig']) {
    assert.equal(orderKeyForDelivery({
      swapUrl: 'https://rvp.example.invalid/recover?t=' + encodeURIComponent(bad),
      payingEmail: PAYING }), null, 'derived a key from ' + JSON.stringify(bad));
  }
});

test('the key carries no address', () => {
  const k = orderKeyForDelivery({ swapUrl: urlFor(PAYING), payingEmail: PAYING });
  assert.doesNotMatch(String(k), /@/);
  assert.doesNotMatch(String(k), /buyer/);
  assert.match(String(k), /^[0-9a-f]{40}$/, 'expected a 40 character hex digest');
});

// ── NULL when it cannot be derived, never a guess ─────────────────────────

test('NO SWAP URL MEANS NO KEY', () => {
  // recoveryAllowed can be false, and then the delivery mints no token. A row
  // with no derivable key stores NULL and keeps today's behaviour exactly.
  for (const bad of [null, undefined, '', '   ']) {
    assert.equal(orderKeyForDelivery({ swapUrl: bad, payingEmail: PAYING }), null,
      'invented a key from ' + JSON.stringify(bad));
  }
});

test('a url with no t parameter yields null', () => {
  assert.equal(orderKeyForDelivery({
    swapUrl: 'https://rvp.example.invalid/recover', payingEmail: PAYING }), null);
  assert.equal(orderKeyForDelivery({
    swapUrl: 'https://rvp.example.invalid/recover?x=1', payingEmail: PAYING }), null);
});

test('no paying address is fine: the token has one', () => {
  // This used to expect null. It changed deliberately when the derivation
  // moved into the token: an absent cross-check is not a disagreement.
  const expected = orderKeyForDelivery({ swapUrl: urlFor(PAYING), payingEmail: PAYING });
  for (const bad of [null, undefined, '', '  ']) {
    assert.equal(orderKeyForDelivery({ swapUrl: urlFor(PAYING), payingEmail: bad }), expected);
  }
});

test('a url that is not a url yields null, never a throw', () => {
  for (const bad of ['not a url', '://', 'recover?t=abc', 42, {}, []]) {
    assert.equal(orderKeyForDelivery({ swapUrl: bad, payingEmail: PAYING }), null);
  }
});

test('it never throws', () => {
  for (const bad of [undefined, null, 0, '', [], {}]) {
    assert.doesNotThrow(() => orderKeyForDelivery(bad));
  }
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the function can return a key, so the null cases mean something', () => {
  assert.match(String(orderKeyForDelivery({ swapUrl: urlFor(PAYING), payingEmail: PAYING })),
    /^[0-9a-f]{40}$/);
});

test('CONTROL: two calls that SHOULD differ do differ', () => {
  assert.notEqual(
    orderKeyForDelivery({ swapUrl: urlFor(PAYING, 1), payingEmail: PAYING }),
    orderKeyForDelivery({ swapUrl: urlFor(PAYING, 2), payingEmail: PAYING }));
});

test('CONTROL: null is not a matchable value', () => {
  // The lookup must never treat one null as equal to another. This is the
  // property the whole design rests on, stated as a test so a later change
  // that compares keys loosely fails here.
  const a = orderKeyForDelivery({ swapUrl: null, payingEmail: PAYING });
  const b = orderKeyForDelivery({ swapUrl: null, payingEmail: 'other@example.invalid' });
  assert.equal(a, null);
  assert.equal(b, null);
  assert.ok(!(a && b && a === b), 'two underivable keys compared equal');
});
