// ════════════════════════════════════════════════════════════════════════════
// THE SIGNED PLACE TOKEN (overnight 2026-09-26). The construction of SVP's and
// EVP's lib-identity-token.js, carrying a Google Places record instead of an
// institution: HMAC-SHA256 over a base64url JSON body, 30 minute expiry.
//
// WHY CARRIED, NOT RE-RESOLVED. /diagnose used to resolve "name, location" to
// the top Places candidate itself, and nobody saw which. Re-resolving after a
// confirmation could land on a different business from the one approved. The
// token makes /diagnose assess exactly the record on the screen.
//
// WHY SIGNED. The page posts it back, so it is requester-controlled. Without
// the signature a requester could approve one restaurant and submit another's
// place id, or raise the review count past the gate.
//
// NOTHING PERSONAL. The Places record only; never the requester's address.
// ════════════════════════════════════════════════════════════════════════════
import crypto from 'crypto';

export const PLACE_TOKEN_TTL_MS = 30 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const str = (v) => (typeof v === 'string' ? v : null);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function payload(place, issuedAt, ttlMs) {
  const p = (place && typeof place === 'object') ? place : {};
  const issued = Number(issuedAt);
  return {
    p: str(p.placeId), n: str(p.name), a: str(p.address),
    s: numOrNull(p.rating), r: numOrNull(p.reviewCount),
    la: numOrNull(p.lat), ln: numOrNull(p.lng),
    i: issued, x: issued + (typeof ttlMs === 'number' ? ttlMs : PLACE_TOKEN_TTL_MS),
  };
}

const mac = (secret, body) => b64url(crypto.createHmac('sha256', String(secret)).update(body).digest());

export function signPlaceToken({ place, secret, issuedAt, ttlMs }) {
  if (!secret) throw new Error('no signing secret');
  const body = b64url(JSON.stringify(payload(place, Number.isFinite(Number(issuedAt)) ? issuedAt : Date.now(), ttlMs)));
  return body + '.' + mac(secret, body);
}

export function verifyPlaceToken({ token, secret, now }) {
  try {
    if (!secret) return { ok: false, reason: 'no-secret' };
    const parts = String(token == null ? '' : token).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
    const [body, sig] = parts;
    const a = Buffer.from(sig), b = Buffer.from(mac(secret, body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
    const p = JSON.parse(unb64url(body).toString('utf8'));
    if (!p || typeof p.x !== 'number' || typeof p.p !== 'string') return { ok: false, reason: 'malformed-payload' };
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (t > p.x) return { ok: false, reason: 'expired' };
    return {
      ok: true,
      place: { placeId: p.p, name: p.n, address: p.a, rating: p.s, reviewCount: p.r, lat: p.la, lng: p.ln },
      issuedAt: p.i, expiresAt: p.x,
    };
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
}
