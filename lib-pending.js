// ════════════════════════════════════════════════════════════════════════════
// Pending reports: normalization and size limits.
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
