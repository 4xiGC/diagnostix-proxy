// ════════════════════════════════════════════════════════════════════════════
// RVP PACKAGE ITEM 3: rvp_outcomes SAYS WHEN THE BUYER TYPED THE ADDRESS THAT
// PAID.
//
// On /recover the buyer types the address their survey was saved under. The
// order row carries the address that PAID. Those are usually different, which
// is the whole reason recovery exists: the survey went to one address and the
// payment came from another.
//
// SOMETIMES THEY ARE THE SAME, and that case means something different. It
// means the buyer did not mistype and did not use a second address; the match
// simply failed for another reason, or they are recovering a report they
// already had. Today rvp_outcomes cannot tell the two apart: the reason column
// records the ELIGIBILITY reason ('delivered-order', 'placeholder-order') and
// nothing about which address was typed.
//
// The row already carries addr_domain and survey_addr_domain, but a domain is
// not an address: two people at one company share a domain and would read as
// the same person.
//
// NO MIGRATION. rvp_outcomes.reason is plain text with no enum and no check
// constraint, confirmed from the PostgREST schema before this was written:
// the table declares only id, created_at and kind as required, and no
// property carries an enum.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryReason, TYPED_THE_PAYING_ADDRESS } from '../lib-pending.js';

// ── The rule ──────────────────────────────────────────────────────────────

test('when the typed address IS the paying address, the reason says so', () => {
  const r = recoveryReason({
    eligibilityReason: 'delivered-order',
    typedEmail: 'buyer@example.invalid',
    payingEmail: 'buyer@example.invalid',
  });
  assert.equal(r, TYPED_THE_PAYING_ADDRESS + ' delivered-order');
  assert.match(r, /typed-the-paying-address/);
});

test('when they DIFFER the reason is unchanged', () => {
  const r = recoveryReason({
    eligibilityReason: 'delivered-order',
    typedEmail: 'survey@example.invalid',
    payingEmail: 'buyer@example.invalid',
  });
  assert.equal(r, 'delivered-order');
  assert.doesNotMatch(r, /typed-the-paying-address/);
});

test('the comparison normalizes case and surrounding space, like the matcher', () => {
  const r = recoveryReason({
    eligibilityReason: 'placeholder-order',
    typedEmail: '  Buyer@Example.Invalid ',
    payingEmail: 'buyer@example.invalid',
  });
  assert.match(r, /typed-the-paying-address/,
    'a capitalised address read as a different person');
});

test('it does NOT normalize anything else, because the matcher does not', () => {
  // Plus-addressing and dots are DIFFERENT addresses to this system. Treating
  // them as equal here would make this reason claim a sameness the matcher
  // itself does not act on.
  const r = recoveryReason({
    eligibilityReason: 'delivered-order',
    typedEmail: 'buyer+survey@example.invalid',
    payingEmail: 'buyer@example.invalid',
  });
  assert.equal(r, 'delivered-order');
});

test('a missing address never claims sameness', () => {
  for (const [typed, paying] of [[null, 'a@b.invalid'], ['a@b.invalid', null], [null, null],
    ['', 'a@b.invalid'], ['a@b.invalid', ''], [undefined, undefined]]) {
    const r = recoveryReason({ eligibilityReason: 'delivered-order', typedEmail: typed, payingEmail: paying });
    assert.equal(r, 'delivered-order',
      'claimed sameness for ' + JSON.stringify([typed, paying]));
  }
});

test('the eligibility reason is always preserved, never replaced', () => {
  for (const er of ['delivered-order', 'placeholder-order', 'no-order-row']) {
    const same = recoveryReason({ eligibilityReason: er, typedEmail: 'x@y.invalid', payingEmail: 'x@y.invalid' });
    assert.ok(same.endsWith(er), 'the eligibility reason was lost: ' + same);
  }
});

test('an absent eligibility reason still yields a usable string', () => {
  const r = recoveryReason({ eligibilityReason: null, typedEmail: 'x@y.invalid', payingEmail: 'x@y.invalid' });
  assert.equal(r, TYPED_THE_PAYING_ADDRESS.trim());
  const n = recoveryReason({ eligibilityReason: null, typedEmail: 'x@y.invalid', payingEmail: 'z@y.invalid' });
  assert.equal(n, '');
});

test('it never throws', () => {
  for (const bad of [undefined, null, 0, '', [], { typedEmail: 5, payingEmail: {} }]) {
    assert.equal(typeof recoveryReason(bad), 'string');
  }
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the marker is not already present in an unrelated reason', () => {
  assert.doesNotMatch('delivered-order', /typed-the-paying-address/);
  assert.doesNotMatch('no-candidate-in-window candidates=1', /typed-the-paying-address/);
});

test('CONTROL: the reason never carries an address', () => {
  const r = recoveryReason({
    eligibilityReason: 'delivered-order',
    typedEmail: 'buyer@example.invalid',
    payingEmail: 'buyer@example.invalid',
  });
  assert.doesNotMatch(r, /@/, 'an address reached the reason column');
  assert.doesNotMatch(r, /buyer/, 'a local part reached the reason column');
});
