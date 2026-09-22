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

  // v8.11.29: saved_at MUST ALREADY BE A NUMBER, and this says so out loud.
  //
  // Both rules below do arithmetic on saved_at. The conversion that makes that
  // arithmetic valid, Date.parse, happens in fetchPendingCandidates, in
  // another file, and nothing anywhere states that it has to. Hand this
  // function a raw PostgREST row and saved_at is the string
  // "2026-09-19T20:26:50+00:00": Number() of that is NaN, the comparator
  // returns NaN, and a comparator that returns NaN leaves the array untouched.
  // The sort becomes a silent no-op, element zero of the caller's ordering
  // wins, and the unit tests stay green because they pass numbers by hand.
  //
  // Refusing loudly is the whole point. A matcher that cannot order its
  // candidates must not pick one, and it must not be possible to discover that
  // from a delivered report.
  //
  // Only rows still in play are checked: a CLAIMED row with a bad timestamp is
  // filtered out above and is nobody's problem, and failing a live purchase
  // over it would be the guard doing more harm than the bug.
  for (const c of unclaimed) {
    if (!Number.isFinite(Number(c.saved_at))) {
      throw new Error('matchPendingReport: saved_at is not a finite number on row '
        + (c && c.id != null ? c.id : '(no id)')
        + ' (got ' + JSON.stringify(c && c.saved_at) + '). '
        + 'Candidates must come from fetchPendingCandidates, which converts with Date.parse.');
    }
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

// ── deliveryProvenanceLines (v8.11.30) ──────────────────────────────────────
//
// WHAT THE BUYER IS TOLD ABOUT WHICH SURVEY THEY JUST BOUGHT.
//
// On 2026-09-20 a buyer paid and received FarmShop, a survey completed the
// previous evening, while the survey they had finished four minutes earlier
// sat unclaimed under a different address. The delivery email named neither
// the restaurant nor the date, so the substitution was only discoverable by
// opening the report and reading it.
//
// The rule chosen is NOT "refuse when unsure". An age limit does not work
// here: 24 hours would not have excluded a 17 hour old row, and it would
// refuse a legitimate buyer coming back two days later. The rule is never
// refuse, always say what was delivered, always offer one correction.
//
// PURE, so the exact customer sentences are tested without sending anything.
//
// THE DATE IS UTC ON PURPOSE. saved_at is a timestamptz and the server runs in
// UTC, but "the date" is otherwise a function of whichever machine rendered
// the email, and a report that names a different day depending on where it was
// formatted is worse than one that names a fixed one.
export function deliveryProvenanceLines(args) {
  // A destructuring default catches undefined and not null, and this is called
  // from a delivery path where a throw would cost a paid customer their email.
  const a = (args && typeof args === 'object') ? args : {};
  const { restaurantName, surveySavedAt, otherWaitingCount } = a;
  const lines = [];

  const name = String(restaurantName == null ? '' : restaurantName).trim();
  // Never emit a sentence with a hole in it. A blank name is rarer than a
  // wrong one and "the restaurant in your survey" is still true.
  const subject = name || 'the restaurant in your survey';

  const t = Number(surveySavedAt);
  let dateText = '';
  if (Number.isFinite(t) && t > 0) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) {
      const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
      dateText = MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
    }
  }

  lines.push(dateText
    ? 'This report covers ' + subject + ', from the survey completed on ' + dateText + '.'
    : 'This report covers ' + subject + '.');

  const n = Number(otherWaitingCount);
  if (Number.isFinite(n) && n >= 1) {
    const k = Math.floor(n);
    lines.push('You have ' + k + ' other completed survey' + (k === 1 ? '' : 's')
      + ' waiting under this address. '
      + 'Reply to this email and we will help you with those.');
  }

  return lines;
}

// ── The swap (v8.11.31) ─────────────────────────────────────────────────────
//
// ONE CORRECTION PER ORDER, OFFERED TO EVERYBODY.
//
// The recovery link already existed, and was only ever sent when NOTHING
// matched a payment. On 2026-09-20 something DID match, it was the wrong
// survey, and the buyer had no route at all. The same link now goes out with
// every paid delivery, and it does two jobs:
//
//   recovery   the order delivered nothing; the subscriber row is a placeholder
//   swap       the order delivered something; the buyer wants a different one
//
// SINGLE USE IS THE POINT. The attempt counter only counts FAILURES, so it
// cannot stop a successful replay: without this, one signed link would hand
// out one more report every time somebody named another address that happened
// to have an unclaimed survey. The marker lives on the order's subscriber row
// rather than in the token, because a token cannot know it has been spent.
export const SWAP_NOTE_PREFIX = 'SWAPPED:';

// v8.11.35: THE SENTENCE NO LONGER CARRIES THE URL.
//
// It printed a signed recovery link as raw text in the middle of a paragraph,
// which is long, ugly, and the shape of a phishing email. The link is now a
// button, and the sentence points at it. The URL still appears once, under the
// button, in the fallback line, because a button that a mail client strips or
// fails to render must still leave a working way through.
export function swapLinkSentence(url) {
  const u = String(url == null ? '' : url).trim();
  if (!u) return '';
  return 'Expected a different restaurant? If you completed the survey under another '
    + 'email address, use the button below within 14 days and we will send that '
    + 'report instead.';
}

export const SWAP_BUTTON_LABEL = 'Send me a different report';
export const RECOVERY_BUTTON_LABEL = 'Find my report';
export const BUTTON_FALLBACK_LINE = 'If the button does not work, copy this link into your browser:';

// A REAL ANCHOR, NEVER AN IMAGE.
//
// Styled to match the primary button already in the delivery email, so the two
// read as one family. Images-off is the default in a large share of mail
// clients and the assumed state in most corporate ones, so the button is an
// anchor with background styling: with images disabled it still renders as a
// coloured block with readable text, and if the styling is stripped entirely
// it degrades to an ordinary underlined link with the same label.
//
// The fallback line under it carries the URL in full. That is the only place
// the URL appears as visible text.
export function renderEmailButton(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const url = String(a.url == null ? '' : a.url).trim();
  const label = String(a.label == null ? '' : a.label).trim();
  if (!url || !label) return '';
  const esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const u = esc(url);
  return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:14px 0 0">'
    + '<tr><td align="center" style="padding:0 0 10px">'
    + '<a href="' + u + '" style="display:inline-block;background:#1B1464;'
    + 'background-image:linear-gradient(135deg,#92278F,#2E3192,#1B1464);color:#ffffff;'
    + 'text-decoration:none;padding:14px 30px;border-radius:8px;'
    + "font-family:'League Spartan',Arial,sans-serif;font-weight:900;font-size:13px;"
    + 'letter-spacing:1.5px;text-transform:uppercase;mso-padding-alt:0">'
    + esc(label) + '</a>'
    + '</td></tr>'
    + '<tr><td align="center" style="font-family:'
    + "'League Spartan'"
    + ',Arial,sans-serif;'
    + 'font-size:11px;color:#999;line-height:1.6;padding:0 6px">'
    + esc(BUTTON_FALLBACK_LINE)
    + '<br><span style="color:#1B1464;word-break:break-all;font-weight:500">' + u + '</span>'
    + '</td></tr></table>';
}

// The plain-text part keeps the URL in full: a text email has no button to
// press, so the link is the only thing that can carry the action.
export function buttonPlainText({ sentence, label, url }) {
  const u = String(url == null ? '' : url).trim();
  if (!u) return '';
  return [String(sentence || ''), '', String(label || '') + ': ' + u].join('\n');
}

// Which mode this link is being used in, and whether it may be used at all.
//
// A MISSING ORDER ROW IS ALLOWED. The table may be unreachable, or the row may
// predate this release. Refusing a paying customer because we cannot find
// their receipt is the wrong failure to choose: the worst case is a recovery
// that behaves exactly as it did before this release.
export function swapEligibility(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const row = (a.orderRow && typeof a.orderRow === 'object') ? a.orderRow : null;
  if (!row) return { allowed: true, mode: 'recovery', reason: 'no-order-row' };

  const notes = String(row.notes == null ? '' : row.notes);
  if (notes.indexOf(SWAP_NOTE_PREFIX) >= 0) {
    return { allowed: false, mode: 'swap', reason: 'already-swapped' };
  }
  // A delivered order has a report token. A placeholder does not.
  if (row.report_token) return { allowed: true, mode: 'swap', reason: 'delivered-order' };
  return { allowed: true, mode: 'recovery', reason: 'placeholder-order' };
}

// ── Duplicate submissions (v8.11.33) ──────────────────────────────
//
// On 2026-09-20 The Drum & Monkey was saved twice under one address, three
// minutes and twenty four seconds apart. Both rows are still unclaimed. A
// payment from that address would buy the newer one and strand the older one
// forever, and the buyer would be told "you have 1 other completed survey
// waiting" about a survey that is the same survey.
//
// SAMENESS IS BY PLACES ID WHERE THERE IS ONE. A Places id is the identity of
// a restaurant; a name is not. "The Drum & Monkey" and "Drum and Monkey" are
// one pub, and two branches of a chain share a name and are two subjects.
// Name plus location is the fallback and is a weaker signal, which is why the
// window is short and why two BLANK names never match: two unnamed surveys are
// unknown, not identical.
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
export const DUPLICATE_CLAIM_LABEL = 'superseded-duplicate';

function normName(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isDuplicateSubmission(args) {
  try {
    const a = (args && typeof args === 'object') ? args : {};
    const ex = (a.existing && typeof a.existing === 'object') ? a.existing : null;
    const inc = (a.incoming && typeof a.incoming === 'object') ? a.incoming : null;
    if (!ex || !inc) return false;
    if (ex === inc) return false;
    if (ex.id != null && inc.id != null && ex.id === inc.id) return false;

    // Never relabel a row that has already been sold.
    if (ex.claimed_at != null) return false;

    const w = typeof a.windowMs === 'number' ? a.windowMs : DUPLICATE_WINDOW_MS;
    const te = Number(ex.saved_at), ti = Number(inc.saved_at);
    if (!Number.isFinite(te) || !Number.isFinite(ti)) return false;
    if (Math.abs(ti - te) > w) return false;

    const se = (ex.survey && typeof ex.survey === 'object') ? ex.survey : {};
    const si = (inc.survey && typeof inc.survey === 'object') ? inc.survey : {};

    const pe = String(se.placeId || se.place_id || '').trim();
    const pi = String(si.placeId || si.place_id || '').trim();
    // A Places id on BOTH sides is the whole answer, either way.
    if (pe && pi) return pe === pi;

    const ne = normName(se.name), ni = normName(si.name);
    if (!ne || !ni) return false;
    if (ne !== ni) return false;

    const le = normName(se.location), li = normName(si.location);
    if (!le || !li) return false;
    return le === li;
  } catch (_) {
    return false;
  }
}

// ── Single use, and a claim that cannot double (v8.11.37) ──────────────
//
// On 2026-09-20 a swap link was used twice and delivered the same report
// twice. Two independent defects, each sufficient on its own:
//
//   1. Single use depended on writing a SWAPPED marker with an UPDATE to
//      subscribers and reading it back on the next click. The read looked at
//      the wrong row: delivering INSERTS a subscriber row, which is then the
//      newest for that address, so the second click read a fresh row with null
//      notes and answered "not yet swapped". The marker could have been
//      written perfectly and the link would still have been spent twice.
//   2. The pending row was claimed AFTER delivery, so two requests could both
//      pass the check and both deliver before either claimed.
//
// A NOTE ON A CLAIM THAT WAS MADE HERE AND IS NOT TRUE. An earlier version of
// this comment said no UPDATE to subscribers from this service had ever landed,
// on the evidence that 0 of 98 rows carried the marker. 98 is the wrong
// denominator: the swap shipped that same day and the placeholder supersede
// has never had a placeholder to act on. The real attempt count is at most two.
// The schema was later cleared by hand. The defect above does not need a failed
// UPDATE to explain it, and none is assumed here.
//
// Both are now operations that fail closed. Single use is an INSERT against a
// UNIQUE index, so the database refuses the second use. The claim is an atomic
// PATCH filtered on claimed_at IS NULL, and only the request that gets exactly
// one row back may deliver.

// THE IDENTITY OF AN ORDER, not of a link. A reissued link for the same order
// is the same entitlement, so the key is derived from the order, and it is
// hashed so the table can never hold an address.
//
// IT KEYS ON THE SIGNED LINK, and two earlier attempts were both wrong in the
// same way, both caught by the harness rather than by reading the code.
//
//   keyed on the order row's report token: a swap delivers, which inserts a
//   new subscriber row, so the second click read a different token.
//   keyed on the order row's id, with a cutoff at the request start: the
//   second click's handler does not begin until the first click's delivery
//   has already inserted its row, so the cutoff excludes nothing.
//
// The link IS the entitlement. One paid delivery builds one recovery URL, so
// one link means one order, and every click on that link produces the same
// key. A later purchase sends a new link and is entitled to its own swap,
// which is the behaviour wanted, not a loophole.
export function swapOrderKey(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const email = normalizeEmail(a.payingEmail);
  const token = String(a.token == null ? '' : a.token).trim();
  return crypto.createHash('sha256').update('rvp-order:' + email + ':' + token).digest('hex').slice(0, 40);
}

// ── v8.11.49: THE ORDER IDENTITY, DERIVED AT MINT TIME ─────────────────────
//
// findOrderRow returns THE NEWEST SUBSCRIBER ROW FOR THE PAYING ADDRESS. That
// is the lookup behind the 2026-09-20 double delivery, and it is only needed
// because one sale can hold several rows: deliverPaidReport calls
// createCustomer on every path and createCustomer INSERTS.
//
// subscribers.order_key exists as of migration 004. This derives the value.
//
// THE SAME DERIVATION rvp_swap_uses ALREADY USES, so the two tables carry the
// same value for the same order and join without translation. The delivery
// mints the recovery token for the swap link it emails, so the key is
// available at mint time from something the delivery already has.
//
// NULL WHEN IT CANNOT BE DERIVED, NEVER A GUESS. recoveryAllowed can be false,
// and then no token is minted. A row with no derivable key stores null and
// keeps today's behaviour exactly, which is the safe direction: the fix
// applies to orders minted from this release onward and changes nothing about
// the 103 rows that already exist.
//
// AND NULL MUST NEVER MATCH NULL. A lookup that treated one missing key as
// equal to another would tie every old row to every other old row, which is
// worse than the defect being fixed.
// THE ADDRESS COMES OUT OF THE TOKEN, NOT OUT OF THE CALLER.
//
// The click side derives its key from verifyRecoveryToken's payingEmail,
// which is the `e` field inside the token. The mint side was passing
// deliverPaidReport's destEmail, and those two agree only because the webhook
// happens to set `const destEmail = email`. If destEmail ever became the
// survey address the stored key would stop matching, findOrderRow would fall
// back to the address path without complaining, and the defect this whole
// change exists to fix would come back silently. Reading `e` out of the token
// means the two sides cannot disagree about which address was hashed.
//
// payingEmail stays as a CROSS-CHECK. When it is supplied and does not match
// the token, no key is minted: a key that can never be matched is worse than
// no key, because no key is honest about falling back.
export function orderKeyForDelivery(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const url = typeof a.swapUrl === 'string' ? a.swapUrl.trim() : '';
  if (!url) return null;

  let token = '';
  try {
    token = String(new URL(url).searchParams.get('t') || '').trim();
  } catch (_) {
    return null;
  }
  if (!token) return null;

  // The payload is read, NOT trusted: this service minted the token moments
  // ago and the signature is checked at the click. Reading it here only has to
  // produce the same address the click will.
  let tokenEmail = '';
  try {
    const body = token.split('.')[0];
    if (!body) return null;
    tokenEmail = normalizeEmail(JSON.parse(unb64url(body).toString('utf8')).e);
  } catch (_) {
    return null;
  }
  if (!tokenEmail) return null;

  const claimed = normalizeEmail(a.payingEmail);
  if (claimed && claimed !== tokenEmail) return null;

  return swapOrderKey({ payingEmail: tokenEmail, token });
}


// HOW MANY ROWS A PATCH ACTUALLY CHANGED.
//
// The 2026-09-20 failure in one function. PostgREST answers 200 with an empty
// array when the filter matched nothing, and every caller here used to read
// that as success. An empty body, a null body, a non-array body and a body
// that is not JSON at all are all ZERO, never "probably fine".
export function patchRowsAffected(body) {
  return Array.isArray(body) ? body.length : 0;
}

// MAY THIS REQUEST DELIVER?
//
// Only on exactly one row. Zero rows means another request holds the claim.
// A transport failure means we do not know, and not knowing is not permission:
// delivering twice is worse than delivering late, because the second delivery
// cannot be taken back.
export function claimVerdict(res) {
  const r = (res && typeof res === 'object') ? res : {};
  if (r.ok !== true) {
    return { claimed: false, mayDeliver: false, rows: 0, reason: 'claim-failed' };
  }
  const n = patchRowsAffected(r.rows);
  if (n === 1) return { claimed: true, mayDeliver: true, rows: 1, reason: 'claimed' };
  if (n === 0) return { claimed: false, mayDeliver: false, rows: 0, reason: 'already-claimed' };
  return { claimed: false, mayDeliver: false, rows: n, reason: 'unexpected-row-count-' + n };
}

// The append-only decision record. Domain and local part length, never an
// address, so the table can be read by anybody who can read the logs.
export function outcomeRecord(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const part = (e) => {
    const s = normalizeEmail(e);
    const i = s.lastIndexOf('@');
    return i > 0 ? { d: '@' + s.slice(i + 1), l: i } : { d: null, l: null };
  };
  const p = part(a.payingEmail), q = part(a.surveyEmail);
  return {
    kind: String(a.kind || 'unknown'),
    secret_status: a.secretStatus == null ? null : String(a.secretStatus),
    decision: a.decision == null ? null : String(a.decision),
    reason: a.reason == null ? null : String(a.reason),
    addr_domain: p.d, addr_local_len: p.l,
    survey_addr_domain: q.d, survey_addr_local_len: q.l,
    pending_row_id: a.pendingRowId || null,
    delivered_restaurant: a.deliveredRestaurant == null ? null : String(a.deliveredRestaurant),
    delivered: a.delivered === true,
    claim_rows: Number.isFinite(Number(a.claimRows)) ? Number(a.claimRows) : null,
    swap_used: a.swapUsed === true,
    stranded_count: Number.isFinite(Number(a.strandedCount)) ? Number(a.strandedCount) : null,
    stale_exact: a.staleExact === true,
  };
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

// ── Alert copy, per kind (v8.11.42) ────────────────────────────────────────
//
// alertWebhookProblem wrapped EVERY kind in the same two paragraphs, which
// were written for one failure and are false for others. On 2026-09-21 the
// subscribers-update-noop alert told the reader that a call had not been
// processed and that no sale was being delivered, while the sale had in fact
// been delivered and emailed. Defaulting to today's text keeps every webhook
// alert byte for byte as it was.
export const ALERT_DEFAULT_OPENING = 'A call reached /payment-webhook and was not '
  + 'processed. If this is the Wix automation, no sale is being delivered until the URL is fixed.';
export const ALERT_DEFAULT_CLOSING = 'The correct URL is the bare path plus a slash plus '
  + 'the secret. On 2026-09-19 the secret was glued on with no slash, every sale 404ed, and '
  + 'nothing was logged by the service at all.';

export function alertCopyFor(kind) {
  if (String(kind == null ? '' : kind) === 'subscribers-update-noop') {
    return {
      opening: 'A write to the sale record changed nothing. The report was delivered and '
        + 'the customer is unaffected. The order row still shows the original report.',
      closing: '',
    };
  }
  return { opening: ALERT_DEFAULT_OPENING, closing: ALERT_DEFAULT_CLOSING };
}

// ── A PostgREST failure, named but not quoted (v8.11.42) ───────────────────
//
// The 409 that explained the 2026-09-20 incident was logged as a bare status
// for a day. `code` and the constraint name were in the response body the
// whole time.
//
// POSTGREST DOES NOT RETURN A `constraint` FIELD. The name is only inside
// `message`, which is why this reads it out rather than picking a key.
function constraintFromMessage(msg) {
  const m = /constraint "([^"]+)"/.exec(String(msg == null ? '' : msg));
  return m ? m[1] : null;
}

// `details` ON A UNIQUE VIOLATION CONTAINS THE COLLIDING VALUE, and on this
// table that value is a report token, which is the credential that opens the
// paid report. The column names are the diagnostic. The values are not, and
// they never reach a log.
export function redactPgDetails(details) {
  const s = String(details == null ? '' : details);
  if (!s) return null;
  return s.replace(/=\([^)]*\)/g, '=(value withheld)');
}

export function pgErrorFields(body) {
  const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
  const pick = (v) => (v == null || v === '') ? null : String(v);
  return {
    code: pick(b.code),
    constraint: pick(b.constraint) || constraintFromMessage(b.message),
    details: redactPgDetails(b.details),
  };
}

// ── The recovery page, per mode (v8.11.42) ─────────────────────────────────
//
// The same page served a buyer whose order delivered nothing and a buyer whose
// order delivered the wrong survey, with the first one's words. "We could not
// match it to a finished HealthCheck" is simply untrue in swap mode.
export function recoveryCopy(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const restaurant = String(a.restaurant == null ? '' : a.restaurant).trim();
  // NO RESTAURANT NAME MEANS NO SWAP COPY. The swap sentence asserts "your
  // order delivered the report for X"; with no X there is no honest way to say
  // it, so this falls back rather than inventing a noun.
  if (a.mode === 'swap' && restaurant) {
    return {
      heading: 'Send me a different report',
      intro: 'Your order delivered the report for ' + restaurant + '. If you completed '
        + 'another survey under a different email address, enter that address and we will '
        + 'send that report instead. Each order includes one swap.',
      label: 'The email you typed into the other survey (not the one you paid with)',
    };
  }
  return {
    heading: 'Find your DiagnostiX report',
    intro: 'Your payment went through and we could not match it to a finished HealthCheck. '
      + 'That happens when the email on your Wix account is not the one you typed into the '
      + 'survey. Tell us the survey email and we will send the report straight away.',
    label: 'The email you typed into the survey (not the one you paid with)',
  };
}

// TWO OF THE THREE FAILED ATTEMPTS ON 2026-09-21 TYPED THE PAYING ADDRESS.
// The page answered "we have no unclaimed report for that address", which is
// true and useless. Naming it is the whole fix.
export function recoveryNotFound(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const typed = normalizeEmail(a.typed);
  const paying = normalizeEmail(a.payingEmail);
  if (typed && paying && typed === paying) {
    return 'That is the address you paid with. Enter the address you typed into the other survey.';
  }
  if (a.mode === 'swap') {
    return 'We have no unfinished survey waiting under that address. Check the spelling, '
      + 'or reply to your receipt and we will help.';
  }
  return 'We have no unclaimed report for that address.';
}

// ── v8.11.48: WHEN THE BUYER TYPED THE ADDRESS THAT PAID ───────────────────
//
// On /recover the buyer types the address their survey was saved under, and
// the order row carries the address that PAID. Those are usually different:
// that difference is the whole reason recovery exists.
//
// When they are the SAME, the case means something else. The buyer did not
// mistype and did not use a second address; the match failed for some other
// reason, or they are recovering a report they already had. rvp_outcomes could
// not tell those apart, because its reason column records the ELIGIBILITY
// reason and nothing about which address was typed. addr_domain and
// survey_addr_domain do not answer it either: two people at one company share
// a domain and would read as the same person.
//
// NO MIGRATION. reason is plain text, no enum, no check constraint, confirmed
// from the PostgREST schema: rvp_outcomes declares only id, created_at and
// kind as required and no property carries an enum.
//
// THE MARKER NEVER CARRIES AN ADDRESS, and a test asserts that.
export const TYPED_THE_PAYING_ADDRESS = 'typed-the-paying-address';

export function recoveryReason(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const er = typeof a.eligibilityReason === 'string' ? a.eligibilityReason : '';
  const typed = typeof a.typedEmail === 'string' ? a.typedEmail : '';
  const paying = typeof a.payingEmail === 'string' ? a.payingEmail : '';
  if (!typed.trim() || !paying.trim()) return er;
  // The SAME normalization the matcher uses, and no more. Plus-addressing and
  // dots are different addresses to this system, so treating them as equal
  // here would claim a sameness the matcher itself does not act on.
  const same = normalizeEmail(typed) === normalizeEmail(paying);
  if (!same) return er;
  return er ? TYPED_THE_PAYING_ADDRESS + ' ' + er : TYPED_THE_PAYING_ADDRESS;
}
