// ════════════════════════════════════════════════════════════════════════════
// v8.11.13: the recovery link
//
// When the matcher answers "none", the buyer currently gets "We could not
// locate your DiagnostiX report" and a dead end. They have paid. The link in
// that email lets them name the address they used in the survey.
//
// WHAT THE TOKEN IS AND IS NOT. HMAC-SHA256 over the paying address and an
// expiry, signed with RVP_RECOVERY_SECRET. It proves the link came from us and
// has not been edited.
//
// IT DOES NOT PROVE SINGLE USE. A token cannot know it has been spent, so
// single use lives on the row (claimed_at) and the attempt counter lives on
// the row too (recovery_attempts, recovery_locked). Anything else would be a
// claim the token cannot make.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { signRecoveryToken, verifyRecoveryToken, RECOVERY_TTL_MS } from '../lib-pending.js';

const SECRET = 'a-test-secret-value-not-a-real-one';
const OTHER  = 'a-different-secret-value-entirely';
const NOW    = Date.parse('2026-09-19T12:00:00Z');
const PAYER  = 'buyer.account@example.com';
const day    = (n) => n * 24 * 60 * 60 * 1000;

test('a freshly signed token verifies and carries the paying address back', () => {
  const t = signRecoveryToken({ payingEmail: PAYER, issuedAt: NOW, secret: SECRET });
  const v = verifyRecoveryToken({ token: t, secret: SECRET, now: NOW });
  assert.equal(v.ok, true, 'a token we just signed did not verify: ' + v.reason);
  assert.equal(v.payingEmail, PAYER);
  assert.equal(v.expiresAt, NOW + RECOVERY_TTL_MS);
});

test('the token is normalized, so case and space cannot fork a link', () => {
  const a = signRecoveryToken({ payingEmail: '  Buyer.Account@Example.COM ', issuedAt: NOW, secret: SECRET });
  const b = signRecoveryToken({ payingEmail: PAYER, issuedAt: NOW, secret: SECRET });
  assert.equal(a, b, 'the same address in two spellings produced two different links');
});

test('a TAMPERED token is rejected', () => {
  const t = signRecoveryToken({ payingEmail: PAYER, issuedAt: NOW, secret: SECRET });
  const [body, sig] = t.split('.');

  // Control: untouched, it verifies.
  assert.equal(verifyRecoveryToken({ token: t, secret: SECRET, now: NOW }).ok, true, 'control');

  // Edit the payload, keep the signature.
  const edited = Buffer.from(JSON.stringify({ e: 'attacker@example.com', i: NOW, x: NOW + day(14) }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r1 = verifyRecoveryToken({ token: edited + '.' + sig, secret: SECRET, now: NOW });
  assert.equal(r1.ok, false, 'an edited payload passed with the old signature');
  assert.equal(r1.reason, 'bad-signature');

  // Edit the signature, keep the payload.
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
  const r2 = verifyRecoveryToken({ token: body + '.' + flipped, secret: SECRET, now: NOW });
  assert.equal(r2.ok, false, 'an edited signature passed');

  // A different secret must not verify it.
  const r3 = verifyRecoveryToken({ token: t, secret: OTHER, now: NOW });
  assert.equal(r3.ok, false, 'a token signed with one secret verified under another');
  assert.equal(r3.reason, 'bad-signature');
});

test('an EXPIRED token is rejected, and the boundary is checked on both sides', () => {
  const t = signRecoveryToken({ payingEmail: PAYER, issuedAt: NOW, secret: SECRET });

  const justBefore = verifyRecoveryToken({ token: t, secret: SECRET, now: NOW + RECOVERY_TTL_MS });
  assert.equal(justBefore.ok, true, 'control: a token is still valid at the instant it expires');

  const justAfter = verifyRecoveryToken({ token: t, secret: SECRET, now: NOW + RECOVERY_TTL_MS + 1 });
  assert.equal(justAfter.ok, false, 'an expired token verified');
  assert.equal(justAfter.reason, 'expired');

  const wayAfter = verifyRecoveryToken({ token: t, secret: SECRET, now: NOW + day(30) });
  assert.equal(wayAfter.ok, false);
  assert.equal(wayAfter.reason, 'expired');
});

test('the default expiry is 14 days', () => {
  assert.equal(RECOVERY_TTL_MS, day(14));
});

test('malformed input is rejected and never throws', () => {
  for (const t of [undefined, null, '', 'no-dot', 'a.b.c', '.', 'a.', '.b',
                   'not-base64!.also-not', {}, 42, 'x'.repeat(10000)]) {
    let v;
    assert.doesNotThrow(() => { v = verifyRecoveryToken({ token: t, secret: SECRET, now: NOW }); },
      'threw on ' + JSON.stringify(t));
    assert.equal(v.ok, false, 'malformed token accepted: ' + JSON.stringify(t));
    assert.equal(typeof v.reason, 'string');
  }
});

test('a token never carries the secret', () => {
  const t = signRecoveryToken({ payingEmail: PAYER, issuedAt: NOW, secret: SECRET });
  assert.ok(!t.includes(SECRET), 'the secret is in the token');
  const decoded = Buffer.from(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(!decoded.includes(SECRET), 'the secret is in the decoded payload');
  assert.ok(decoded.includes(PAYER), 'control: the payload really is readable, so the check above means something');
});
