// ════════════════════════════════════════════════════════════════════════════
// Webhook logging helpers. Pure, no I/O, no env. ESM, to match server.js.
//
// COPIED VERBATIM FROM diagnostix-evp/lib-webhook-log.js, which is the tested
// one: 12 checks in diagnostix-evp/test/webhook-log.test.js. The only
// differences permitted here are this header and `export` in place of
// `module.exports`. If the two ever diverge in logic, this copy is wrong.
//
// There is no test harness in this repo, so these are verified here by a
// throwaway script that runs the EVP test file's own cases against this copy,
// not by anything that runs on every change. Stated, not glossed.
//
// SVP carries the same functions inline at v0.19.13. Three copies across three
// repos is a drift risk and a shared package is the right answer.
// ════════════════════════════════════════════════════════════════════════════

const SHAPE_MAX_DEPTH = 4;
const SHAPE_MAX_KEYS = 40;
const SHAPE_EMAILISH = /[^\s@]+@[^\s@]+\.[^\s@]+/;

// ── describeShape ───────────────────────────────────────────────────────────
// KEY NAMES AND VALUE TYPES. Never a value.
//
// The v1.4.5 debug log wrote the entire Wix payload, up to 2,000 characters,
// into the platform log on every purchase. v1.8.9(d) removed it for exactly
// that reason and replaced it with event type, order id and a masked email.
// This is the other half: the payload STRUCTURE, which is what tells you
// whether the automation emits contactEmail, "Contact Email", or
// data.contact.email, without carrying a single value.
//
// The one route by which a value could escape through a key name is an object
// keyed BY email address, so an email-shaped key is redacted.
//
// Bounded in depth, array length and key count, and total-failure safe: this
// runs inside a request handler, where a throw would turn a 401 into a 500 and
// that would be a behaviour change. JSON.stringify throws on a circular body;
// this does not.
export function describeShape(v, depth = 0, seen = null) {
  try {
    if (depth > SHAPE_MAX_DEPTH) return '…';
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';

    const t = typeof v;
    if (t !== 'object') return t;

    seen = seen || new Set();
    if (seen.has(v)) return '<circular>';
    seen.add(v);

    if (Array.isArray(v)) {
      return v.length ? `array[${v.length}] of ${describeShape(v[0], depth + 1, seen)}` : 'array[0]';
    }
    if (v instanceof Date) return 'Date';

    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const shown = keys.slice(0, SHAPE_MAX_KEYS);
    const parts = shown.map(k => shapeKey(k) + ':' + describeShape(v[k], depth + 1, seen));
    const more = keys.length > shown.length ? ',…+' + (keys.length - shown.length) : '';
    return '{' + parts.join(',') + more + '}';
  } catch (_) {
    return '<undescribable>';
  }
}

function shapeKey(k) {
  const s = String(k);
  if (SHAPE_EMAILISH.test(s)) return '<redacted-key>';
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

// ── emailDomainOnly ─────────────────────────────────────────────────────────
// Domain only. Enough to match a log line to a person already on screen, not
// enough to be a mailing list.
//
// TOTAL. It cannot throw, and that is not decoration: String() itself throws
// on a value with no prototype, so the first version of this threw inside a
// request handler, after the response had already been sent. In RVP the same
// helper sits ahead of the whole purchase flow, where a throw would mean a
// paying customer gets no report because a LOG LINE failed.
//
// "(unmaskable)" rather than "(none)", because "(none)" reads like an
// address-free payload and this is a different thing.
export function emailDomainOnly(email) {
  try {
    const s = String(email == null ? '' : email);
    const i = s.lastIndexOf('@');
    if (i < 0 || i === s.length - 1) return '(none)';
    return '@' + s.slice(i + 1);
  } catch (_) {
    return '(unmaskable)';
  }
}

// ── webhookOutcomeLine ──────────────────────────────────────────────────────
// ONE LINE PER CALL, ON EVERY EXIT.
//
// payment_reference cannot answer "did a webhook authenticate". It records
// which path marked a report paid FIRST, and in EVP the browser redirect wins
// that race: the cookie path at GET / marks the row within seconds, and a
// valid webhook arriving later calls lookupUnpaidReportByEmail, finds nothing
// unpaid, returns 404 and leaves no trace. An accepted webhook and a rejected
// one are indistinguishable in the table, which is why the question "has any
// EVP webhook ever been accepted" is UNMEASURABLE from rows.
//
// `secret` is accepted and deliberately never rendered.
export function webhookOutcomeLine({ source, valid, outcome, email }) {
  return `WEBHOOK_OUTCOME [webhook] source=${source} secret=${valid ? 'valid' : 'invalid'}`
    + ` outcome=${outcome} domain=${emailDomainOnly(email)}`;
}
