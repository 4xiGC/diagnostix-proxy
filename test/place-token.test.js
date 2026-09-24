// ════════════════════════════════════════════════════════════════════════════
// THE SIGNED PLACE TOKEN (overnight 2026-09-26, Item 4). The SVP and EVP
// identity-token construction (lib-identity-token.js): HMAC-SHA256 over a
// base64url body, 30 minute expiry, verified before anything is trusted.
//
// It binds the Places record the requester CONFIRMED: place id, name,
// address, rating, review count and coordinates. /diagnose assesses exactly
// that record and never re-resolves the name, so the approval means what the
// screen said. It carries no address of the requester and nothing personal.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { signPlaceToken, verifyPlaceToken, PLACE_TOKEN_TTL_MS } from '../lib-place-token.js';

const PLACE = { placeId: 'ChIJ-teclados', name: 'Teclados', address: 'Av. Italia 1234, Santiago, Chile',
  rating: 4.4, reviewCount: 765, lat: -33.44, lng: -70.62 };
const SECRET = 'test-secret';
const T0 = Date.parse('2026-09-24T12:00:00Z');

test('a token round-trips the confirmed record', () => {
  const tok = signPlaceToken({ place: PLACE, secret: SECRET, issuedAt: T0 });
  const v = verifyPlaceToken({ token: tok, secret: SECRET, now: T0 + 1000 });
  assert.equal(v.ok, true);
  assert.deepEqual(v.place, PLACE);
});

test('the expiry is 30 minutes and is enforced', () => {
  assert.equal(PLACE_TOKEN_TTL_MS, 30 * 60 * 1000);
  const tok = signPlaceToken({ place: PLACE, secret: SECRET, issuedAt: T0 });
  assert.equal(verifyPlaceToken({ token: tok, secret: SECRET, now: T0 + PLACE_TOKEN_TTL_MS }).ok, true);
  assert.equal(verifyPlaceToken({ token: tok, secret: SECRET, now: T0 + PLACE_TOKEN_TTL_MS + 1 }).reason, 'expired');
});

test('an edited body or a different secret is refused', () => {
  const tok = signPlaceToken({ place: PLACE, secret: SECRET, issuedAt: T0 });
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(body, 'base64').toString()), { p: 'ChIJ-other' })))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(verifyPlaceToken({ token: forged + '.' + sig, secret: SECRET, now: T0 }).reason, 'bad-signature');
  assert.equal(verifyPlaceToken({ token: tok, secret: 'other', now: T0 }).reason, 'bad-signature');
});

test('junk is malformed, never a throw', () => {
  for (const t of [null, undefined, '', 'abc', 'a.b.c', 42, {}]) {
    const v = verifyPlaceToken({ token: t, secret: SECRET, now: T0 });
    assert.equal(v.ok, false, String(t));
  }
});

test('an empty secret cannot sign or verify', () => {
  assert.throws(() => signPlaceToken({ place: PLACE, secret: '', issuedAt: T0 }));
  const tok = signPlaceToken({ place: PLACE, secret: SECRET, issuedAt: T0 });
  assert.equal(verifyPlaceToken({ token: tok, secret: '', now: T0 }).reason, 'no-secret');
});

test('only the record\'s own fields are carried', () => {
  const tok = signPlaceToken({ place: Object.assign({ email: 'owner@example.org', extra: 'x' }, PLACE), secret: SECRET, issuedAt: T0 });
  assert.doesNotMatch(Buffer.from(tok.split('.')[0], 'base64').toString(), /owner|extra/);
});
