// ════════════════════════════════════════════════════════════════════════════
// Pending reports: normalization, size limits, matching and recovery links.
//
// PURE. No I/O, no env, no clock of its own: every function that needs the
// time takes it as an argument, so the rules can be tested at a fixed instant
// rather than at whatever moment the suite runs.
//
// B1 ships the limits and normalization only. The matcher arrives in B2 and
// the recovery links in B3.
// ════════════════════════════════════════════════════════════════════════════

// ── Limits ──────────────────────────────────────────────────────────────────
// Measured on the 88 stored reports in subscribers.baseline_report:
//   min 5,994  median 13,047  mean 12,397  p90 16,713  max 21,469 bytes.
// The cap is ~12x the largest report ever stored, so it cannot reject a real
// one, and it stops /save-report being an open door to a database.
import crypto from 'crypto';

export const MAX_SAVE_BYTES = 262144;          // 256 KiB

export function normalizeEmail(email) {
  try {
    return String(email == null ? '' : email).toLowerCase().trim();
  } catch (_) {
    return '';
  }
}

export function emailDomain(email) {
  const s = normalizeEmail(email);
  const i = s.lastIndexOf('@');
  return i > 0 && i < s.length - 1 ? '@' + s.slice(i + 1) : '(none)';
}

// Byte length of what would be persisted. Total-safe: an unserializable body
// is "too large" rather than an exception inside a request handler.
export function saveSizeBytes(report, survey) {
  try {
    return Buffer.byteLength(JSON.stringify({ report, survey }), 'utf8');
  } catch (_) {
    return Number.MAX_SAFE_INTEGER;
  }
}

export const INFER_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ── The matcher ─────────────────────────────────────────────────────────────
//
// WHAT v8.9.37 REMOVED, AND WHY THIS IS NOT THAT.
//
// Removed rule 2 matched any stored email sharing an @ local part, so
// info@restaurant-a.com resolved to info@restaurant-b.com. Nothing here
// compares local parts.
//
// Removed rule 3 took the MOST RECENT report saved by ANYONE within five
// minutes, matched on nothing at all, and then REDIRECTED delivery to the
// survey email on the report it found. When it latched onto the wrong report
// the payer got nothing and a stranger got an unlock. Two things made that
// catastrophic rather than merely wrong, and both are inverted here:
//
//   1. It picked the NEWEST OF MANY. This requires EXACTLY ONE. Two candidates
//      in the window is a refusal, not a coin toss. Rule 3's whole failure was
//      that it could not tell "same person, different address" from "different
//      person, same window" and answered both identically. This answers the
//      second with "none" and hands it to a human and to the recovery link.
//   2. It REDIRECTED DELIVERY to the survey address. This returns a ROW and
//      never an address. The caller delivers to the PAYING address, so even a
//      wrong inferred match cannot send a report to someone who did not pay.
//
// The window is 30 minutes where rule 3's was 5. Longer is safe here precisely
// because the failure mode changed: a longer window raises the chance of two
// candidates, and two candidates is a refusal.
//
// candidates: [{ id, email_normalized, saved_at (ms), claimed_at (null|any) }]
// returns { decision: 'exact'|'inferred'|'none', match: candidate|null, reason }
export function matchPendingReport({ payingEmail, candidates, now, windowMs }) {
  const w = typeof windowMs === 'number' ? windowMs : INFER_WINDOW_MS;
  const list = Array.isArray(candidates) ? candidates : [];
  const unclaimed = list.filter(c => c && typeof c === 'object' && c.claimed_at == null);

  const paying = normalizeEmail(payingEmail);
  if (!paying || paying.indexOf('@') < 1) {
    return { decision: 'none', match: null, reason: 'no-paying-email' };
  }

  // (a) exact, newest first
  const exact = unclaimed
    .filter(c => normalizeEmail(c.email_normalized) === paying)
    .sort((a, b) => Number(b.saved_at) - Number(a.saved_at));
  if (exact.length) {
    return { decision: 'exact', match: exact[0], reason: 'exact-email-match' };
  }

  // (b) exactly one unclaimed inside the window
  const inWindow = unclaimed.filter(c => {
    const t = Number(c.saved_at);
    return Number.isFinite(t) && t <= now && (now - t) <= w;
  });
  if (inWindow.length === 1) {
    return { decision: 'inferred', match: inWindow[0], reason: 'single-candidate-in-window' };
  }
  if (inWindow.length > 1) {
    return { decision: 'none', match: null, reason: 'ambiguous-' + inWindow.length + '-candidates-in-window' };
  }
  return { decision: 'none', match: null, reason: 'no-candidate-in-window' };
}

export const RECOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const RECOVERY_MAX_ATTEMPTS = 5;

// ── Recovery links ──────────────────────────────────────────────────────────
//
// HMAC-SHA256 over the paying address and an expiry, base64url. It proves the
// link came from us and has not been edited.
//
// IT DOES NOT PROVE SINGLE USE. A token cannot know it has been spent, so
// single use lives on the row (claimed_at) and the attempt counter lives on
// the row too (recovery_attempts, recovery_locked). Anything else would be a
// claim the token is not able to make.
const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signRecoveryToken({ payingEmail, issuedAt, secret, ttlMs }) {
  const issued = Number(issuedAt);
  const payload = {
    e: normalizeEmail(payingEmail),
    i: issued,
    x: issued + (typeof ttlMs === 'number' ? ttlMs : RECOVERY_TTL_MS),
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', String(secret)).update(body).digest());
  return body + '.' + sig;
}

export function verifyRecoveryToken({ token, secret, now }) {
  try {
    const parts = String(token == null ? '' : token).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
    const [body, sig] = parts;
    const expect = b64url(crypto.createHmac('sha256', String(secret)).update(body).digest());
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad-signature' };
    }
    const payload = JSON.parse(unb64url(body).toString('utf8'));
    if (!payload || typeof payload.x !== 'number') return { ok: false, reason: 'malformed-payload' };
    if (Number(now) > payload.x) return { ok: false, reason: 'expired' };
    return { ok: true, payingEmail: payload.e, issuedAt: payload.i, expiresAt: payload.x };
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
}
