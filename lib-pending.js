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

// ── selectRowToClaim (v8.11.17) [A1] ────────────────────────────────────────
//
// WHICH ROW A DELIVERY MUST RETIRE.
//
// A memory hit used to deliver without touching the table, so the
// pending_reports row stayed unclaimed and remained a live candidate for
// somebody else:
//
//   11:30  Y finishes a survey
//   12:00  X finishes a survey, pays from the SAME address, memory hit,
//          delivered, row left UNCLAIMED
//   12:05  Y pays from a DIFFERENT address. The window holds exactly one
//          unclaimed row, X's, so Y is delivered X's report.
//
// Every step of the matcher was right. The row was never retired. A delivered
// survey has to stop being a candidate, whichever path delivered it.
//
// When the matcher supplied a row, that row is the answer and no re-derivation
// is allowed to disagree with it. When the delivery came from memory there is
// no row object in hand, so the newest unclaimed row for the PAYING address is
// named: a memory hit is an exact address match by construction, because
// /save-report keys the Map by the normalized survey address.
export function selectRowToClaim({ decision, matchedRow, payingEmail, candidates }) {
  if (matchedRow && matchedRow.id) return matchedRow;
  const paying = normalizeEmail(payingEmail);
  if (!paying || paying.indexOf('@') < 1) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  const mine = list
    .filter(c => c && typeof c === 'object' && c.claimed_at == null
      && normalizeEmail(c.email_normalized) === paying)
    .sort((a, b) => Number(b.saved_at) - Number(a.saved_at));
  return mine.length ? mine[0] : null;
}

// ── Shadow mode (v8.11.18) [A2] ─────────────────────────────────────────────
//
// INFERENCE SHIPS SWITCHED OFF.
//
// The matcher still computes "inferred". Nothing is ever delivered on it. The
// buyer goes down the recovery path exactly as if the answer had been "none",
// and the alert still fires, so the rule can be watched running against real
// orders before anything depends on it.
//
// The rule has never been right or wrong about a real customer, and the only
// corpus available to judge it is 86 percent batch testing. Delivering on it
// unmeasured would be trusting a rule whose failure mode is handing one
// customer another customer's report.
//
// HOW IT GETS MEASURED. When a buyer later recovers, they type the address
// they used, which names the row that was actually theirs. Comparing that to
// the row inference would have chosen turns the question into a count:
// INFERENCE_CHECK would-have-been=right|wrong|no-inference.
//
// Only the exact string 'true' turns delivery on. Any other value, including
// 'TRUE', '1' and 'yes', leaves it off: a flag that controls who receives
// somebody's business data should not be switched by a typo.
export function applyShadowMode({ result, deliverInferred }) {
  const on = deliverInferred === true || deliverInferred === 'true';
  if (!result || result.decision !== 'inferred') {
    return {
      decision: result ? result.decision : 'none',
      match: result ? result.match : null,
      reason: result ? result.reason : 'no-result',
      logDecision: result ? result.decision : 'none',
      wouldHaveInferredId: null,
      alert: false,
    };
  }
  if (on) {
    return {
      decision: 'inferred', match: result.match, reason: result.reason,
      logDecision: 'inferred',
      wouldHaveInferredId: (result.match && result.match.id) || null,
      alert: true,
    };
  }
  return {
    decision: 'none', match: null, reason: result.reason,
    logDecision: 'would-infer',
    wouldHaveInferredId: (result.match && result.match.id) || null,
    alert: true,
  };
}

// Was the row inference would have chosen the row the buyer actually owned?
// "wrong" covers the case where inference named a row and recovery produced a
// different one OR none at all: both mean inference was not right.
export function inferenceVerdict({ wouldHaveInferredId, recoveredId } = {}) {
  if (!wouldHaveInferredId) return 'no-inference';
  return wouldHaveInferredId === recoveredId ? 'right' : 'wrong';
}

// ── The secret gate (v8.11.18) [A3] ─────────────────────────────────────────
//
// THE WEBHOOK IS STILL UNAUTHENTICATED. v8.11.10 reads a secret and enforces
// nothing, deliberately, because requiring one would break every genuine Wix
// call while the automation posts to the bare URL.
//
// A recovery link is a BEARER CREDENTIAL that fetches a report. Anyone can
// POST to /payment-webhook naming any address; if that earned a link, an
// attacker would post their own address, receive a link, and use it to guess
// at other people's surveys. The placeholder subscriber row is the same
// problem in a smaller way: a forged post would write a fake sale into the
// revenue table.
//
// So both are created ONLY when the call carried a VALID secret. Everything
// else on a cache miss behaves exactly as v8.11.10 did.
export function recoveryAllowed(secretStatus) {
  return secretStatus === 'valid';
}

// ── C1: a memory hit must still be for sale (v8.11.21) ──────────────────────
//
// PRODUCTION, 2026-09-19 20:29Z. A buyer who had bought the Zulu report at
// 18:09Z saved a FarmShop survey under a different address and paid again from
// the SAME address as before. The process had not restarted, the Map still
// held Zulu under the paying address, memory-exact hit, and Zulu was delivered
// a second time. FarmShop was never considered. PENDING_CLAIM correctly
// refused to retire the FarmShop row, because its address was not the paying
// address, and logged "nothing to claim ... candidates=1".
//
// Every rule downstream of the Map was right. The Map is a cache with no
// invalidation, consulted ahead of the table that has invalidation.
//
// THE RULE. A memory entry is believed only when the pending row it came from
// is still unclaimed. Two independent signals retire it:
//
//   1. spentAt, set on THIS process after any successful delivery
//   2. the row being claimed, which also covers a delivery by another process
//
// Either alone is enough, and spentAt is checked first so that an unreachable
// table cannot resurrect a report this process has already sold.
//
// THE DELIBERATE HOLE. When the table cannot answer, or when the entry never
// got a row id because PENDING_WRITE was skipped or failed, memory is trusted
// exactly as before and the trust is LOGGED. Memory is then the only copy of
// that report, and a report cannot be regenerated without re-running the
// assessment. Refusing here would convert a wrong-report bug into a no-report
// bug, which is worse for the buyer and harder to notice.
export function markSpent(entry, { at, token } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  // A Wix retry must not move the timestamp. The first sale is the sale.
  if (entry.spentAt) return entry;
  return Object.assign({}, entry, {
    spentAt: typeof at === 'number' ? at : Date.now(),
    spentToken: token == null ? null : String(token),
  });
}

// rowState is what the table said about entry.pendingId:
//   { reachable: false }                        the query failed or was skipped
//   { reachable: true, found: false }           no such row
//   { reachable: true, found: true, claimed: b} the row, and whether it is spent
export function memoryHitVerdict({ entry, rowState } = {}) {
  if (!entry || typeof entry !== 'object') {
    return { trust: false, reason: 'no-entry' };
  }
  // Checked before anything else on purpose: see THE DELIBERATE HOLE above.
  if (entry.spentAt) {
    return { trust: false, reason: 'spent' };
  }
  if (!entry.pendingId) {
    return { trust: true, trusted: true, reason: 'no-pending-id' };
  }
  if (!rowState || rowState.reachable !== true) {
    return { trust: true, trusted: true, reason: 'table-unreachable' };
  }
  if (rowState.found !== true) {
    // A reachable table saying the row is gone. Retention is not scheduled and
    // nothing else deletes these, so this is a hand edit or a wrong id. Refuse
    // rather than resell: the buyer still reaches the report by recovery.
    return { trust: false, reason: 'row-missing' };
  }
  if (rowState.claimed === true) {
    return { trust: false, reason: 'row-claimed' };
  }
  return { trust: true, reason: 'row-unclaimed' };
}

// ── C2 and C3: one alert per ten minutes, never a flood ─────────────────────
//
// A rejected webhook and a misrouted path are both "the Wix URL is wrong",
// which is a condition that repeats on every order until a human fixes it. One
// alert has to be loud enough to notice and quiet enough that a misconfigured
// automation, or someone probing the endpoint, cannot turn the alert mailbox
// into the outage.
export const ALERT_THROTTLE_MS = 10 * 60 * 1000;

export function alertThrottle({ lastSentAt, now, windowMs } = {}) {
  const w = typeof windowMs === 'number' ? windowMs : ALERT_THROTTLE_MS;
  const last = Number(lastSentAt) || 0;
  const t = Number(now) || 0;
  // A negative elapsed time means the clock moved backwards, or lastSentAt is
  // in the future. Either way, suppress: unlocking on a bad clock is how a
  // throttle becomes a loop.
  const elapsed = t - last;
  if (last > 0 && (elapsed < 0 || elapsed < w)) {
    return { send: false, elapsed, windowMs: w };
  }
  return { send: true, elapsed, windowMs: w };
}

// ── C2: the webhook secret is enforced (v8.11.22) ───────────────────────────
//
// WHY THIS IS SAFE NOW AND WAS NOT IN v8.11.10. Enforcement was deliberately
// withheld because the Wix automation posted to the bare URL, and requiring a
// secret would have broken every genuine call the moment it deployed. Two
// production orders have since carried status=valid, 2026-09-19 18:09Z and
// 20:29Z, so the automation is known to send it.
//
// FAIL CLOSED. Only two statuses avoid rejection: 'valid', and
// 'not-configured', which means RVP_WEBHOOK_SECRET is unset and the service
// returns to v8.11.10 behaviour. Anything else, including a value nobody
// planned for, is rejected. The escape hatch is clearing the variable, which
// is a deliberate act, rather than a status string falling through a gap.
//
// 401 RATHER THAN 403 OR A SILENT 200. Wix records the response in its Run
// Log, so a 401 is the difference between "this automation is failing" and a
// log full of successes for sales that never arrived. A silent 200 on a
// rejected call is what let the 2026-09-19 misroute hide for an afternoon.
//
// ONE ARGUMENT, ON PURPOSE. This rule cannot read the body, so it cannot be
// talked into trusting it.
export function webhookEnforcement(secretStatus) {
  if (secretStatus === 'not-configured') {
    return { enforcing: false, reject: false, httpStatus: 200, reason: 'enforcement-off' };
  }
  if (secretStatus === 'valid') {
    return { enforcing: true, reject: false, httpStatus: 200, reason: 'secret-valid' };
  }
  return {
    enforcing: true, reject: true, httpStatus: 401,
    reason: 'secret-' + (typeof secretStatus === 'string' && secretStatus ? secretStatus : 'unknown'),
  };
}

// ── C3: a misrouted webhook path is loud (v8.11.23) ─────────────────────────
//
// On 2026-09-19 the Wix automation was set to /payment-webhook<secret> with no
// slash. Express matched neither route, every sale 404'd at the edge, and the
// service logged nothing at all because the handler was never entered. The
// only trace was in Railway's edge log, which nobody reads until something is
// already known to be wrong. It was invisible for part of an afternoon.
//
// FOUR CHARACTERS AND A LENGTH. The tail of a misrouted path is very often the
// secret itself, glued on wrong. Four characters is enough to tell two
// mistyped URLs apart in a log; the length is enough to say "that looks like
// the 64 character secret" without printing any more of it.
export function misroutedHint(path) {
  const PREFIX = '/payment-webhook';
  const out = { misrouted: false, hint: '', tailLength: 0 };
  if (typeof path !== 'string' || !path.startsWith(PREFIX)) return out;
  const tail = path.slice(PREFIX.length);
  // The two real routes: the bare path, and exactly one more segment.
  if (tail === '' || tail === '/') return out;
  if (tail[0] === '/' && tail.indexOf('/', 1) === -1) return out;
  // Anything else reaches no handler: the no-slash form, and deeper paths.
  const raw = tail[0] === '/' ? tail.slice(1) : tail;
  out.misrouted = true;
  out.hint = raw.slice(0, 4);
  out.tailLength = raw.length;
  return out;
}
