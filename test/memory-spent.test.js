// ════════════════════════════════════════════════════════════════════════════
// v8.11.21 [C1]: A MEMORY HIT MUST STILL BE FOR SALE
//
// WHAT HAPPENED IN PRODUCTION, 2026-09-19 20:29Z.
//
//   18:08  survey Zulu saved under address B
//   18:09  paid from B. Map hit. Zulu delivered. Row claimed. CORRECT.
//   20:26  survey FarmShop saved under address A
//   20:29  paid from B again, SAME PROCESS, no restart
//          Map still held Zulu under B, so memory-exact hit, and Zulu was
//          delivered a SECOND time. FarmShop was never looked at.
//
// PENDING_CLAIM refused to retire the FarmShop row, correctly, because its
// address is not the paying address. Every rule downstream was right. The
// defect is that the Map is a cache with no invalidation and it is consulted
// ahead of the table that does have invalidation.
//
// THE RULE THIS FILE PINS. A memory entry is believed only when the pending
// row it came from is still unclaimed. If that row is claimed, the report has
// already been sold and the entry must be ignored. If the table cannot answer,
// memory is trusted as before and the trust is logged, because turning a
// wrong-report bug into a no-report bug is not an improvement.
//
// WHY THESE TESTS ASSERT ON REPORT IDENTITY. A test that asserts "a delivery
// happened" passes on the bug: a delivery did happen, of the wrong report.
// Every assertion below names WHICH report, or refuses to accept one.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { markSpent, memoryHitVerdict, ALERT_THROTTLE_MS, alertThrottle } from '../lib-pending.js';

const R1 = { healthCheckScore: 58, subject: 'Zulu' };
const R2 = { healthCheckScore: 72, subject: 'FarmShop' };

const entry = (over) => Object.assign(
  { report: R1, survey: { name: 'Zulu' }, product: 'full', savedAt: 1000, pendingId: 'row-1' },
  over || {});

// ── markSpent ───────────────────────────────────────────────────────────────

test('markSpent records the time and the token', () => {
  const out = markSpent(entry(), { at: 5000, token: 'tok-abc' });
  assert.equal(out.spentAt, 5000);
  assert.equal(out.spentToken, 'tok-abc');
});

test('markSpent does not delete the report, so a retry can still be answered', () => {
  const out = markSpent(entry(), { at: 5000, token: 't' });
  assert.deepEqual(out.report, R1);
  assert.equal(out.pendingId, 'row-1');
  assert.equal(out.savedAt, 1000);
});

test('markSpent does not mutate the entry it was given', () => {
  const e = entry();
  markSpent(e, { at: 5000, token: 't' });
  assert.equal(e.spentAt, undefined, 'the original entry must be untouched');
});

test('markSpent on a null entry returns null rather than throwing', () => {
  assert.equal(markSpent(null, { at: 1, token: 't' }), null);
});

test('markSpent keeps the FIRST spend when called twice', () => {
  // A Wix retry must not move the timestamp, or the audit trail lies about
  // when the report was actually sold.
  const once = markSpent(entry(), { at: 5000, token: 'first' });
  const twice = markSpent(once, { at: 9000, token: 'second' });
  assert.equal(twice.spentAt, 5000);
  assert.equal(twice.spentToken, 'first');
});

// ── memoryHitVerdict: the four cases from the brief ─────────────────────────

test('no entry is not a hit', () => {
  const v = memoryHitVerdict({ entry: null, rowState: null });
  assert.equal(v.trust, false);
  assert.equal(v.reason, 'no-entry');
});

test('THE BUG: a spent entry is not a candidate, whatever the table says', () => {
  const sold = markSpent(entry(), { at: 5000, token: 't' });
  const v = memoryHitVerdict({ entry: sold, rowState: { reachable: true, found: true, claimed: false } });
  assert.equal(v.trust, false, 'a report already sold must never be sold again from memory');
  assert.equal(v.reason, 'spent');
});

test('THE BUG, second form: the row is claimed, so the entry is spent', () => {
  // This is what production actually looked like at 20:29Z. The entry was not
  // flagged, because nothing flagged it, but its row had been claimed at
  // 18:11Z. Either signal alone has to be enough.
  const v = memoryHitVerdict({ entry: entry(), rowState: { reachable: true, found: true, claimed: true } });
  assert.equal(v.trust, false);
  assert.equal(v.reason, 'row-claimed');
});

test('an unclaimed row means the entry is still for sale', () => {
  const v = memoryHitVerdict({ entry: entry(), rowState: { reachable: true, found: true, claimed: false } });
  assert.equal(v.trust, true);
  assert.equal(v.reason, 'row-unclaimed');
  assert.equal(v.trusted, undefined, 'a verified hit is not a TRUSTED-without-checking hit');
});

test('table unreachable: trust memory, and say that you did', () => {
  const v = memoryHitVerdict({ entry: entry(), rowState: { reachable: false } });
  assert.equal(v.trust, true, 'a wrong-report bug must not become a no-report bug');
  assert.equal(v.trusted, true, 'this is the flag that makes MEMORY_TRUSTED log');
  assert.equal(v.reason, 'table-unreachable');
});

test('rowState missing entirely is treated as unreachable, not as absent', () => {
  const v = memoryHitVerdict({ entry: entry(), rowState: null });
  assert.equal(v.trust, true);
  assert.equal(v.trusted, true);
  assert.equal(v.reason, 'table-unreachable');
});

test('no pending id, because the write was skipped or failed: trust memory', () => {
  // PENDING_WRITE skipped by the size cap or the rate limit, or failed with a
  // 404 as in A7e. Memory is then the ONLY copy of that report.
  const v = memoryHitVerdict({ entry: entry({ pendingId: null }), rowState: { reachable: true, found: false } });
  assert.equal(v.trust, true);
  assert.equal(v.trusted, true);
  assert.equal(v.reason, 'no-pending-id');
});

test('a spent entry with no pending id is STILL not for sale', () => {
  // Ordering matters: spent beats the trust-memory fallback. Otherwise the
  // table being unreachable would resurrect an already-sold report.
  const sold = markSpent(entry({ pendingId: null }), { at: 5000, token: 't' });
  const v = memoryHitVerdict({ entry: sold, rowState: { reachable: false } });
  assert.equal(v.trust, false);
  assert.equal(v.reason, 'spent');
});

test('the row is gone from a reachable table: not for sale', () => {
  const v = memoryHitVerdict({ entry: entry(), rowState: { reachable: true, found: false } });
  assert.equal(v.trust, false);
  assert.equal(v.reason, 'row-missing');
});

// ── report identity, the assertion that would have caught this ──────────────
//
// These compose the verdict the way the server does. They are not a substitute
// for the harness, which runs the real server twice against one process; they
// exist so the rule cannot be changed without someone naming a report.

function whatWouldBeDelivered({ memory, rowState, tableCandidates }) {
  const v = memoryHitVerdict({ entry: memory, rowState });
  if (v.trust) return { report: memory.report, via: 'memory-exact' };
  const unclaimed = (tableCandidates || []).filter(c => c.claimed_at == null);
  if (!unclaimed.length) return { report: null, via: 'cache-miss' };
  return { report: null, via: 'shadow-would-infer', wouldBe: unclaimed[0].report };
}

test('purchase 1 from B delivers R1', () => {
  const out = whatWouldBeDelivered({
    memory: entry({ report: R1 }),
    rowState: { reachable: true, found: true, claimed: false },
    tableCandidates: [{ id: 'row-1', claimed_at: null, report: R1 }],
  });
  assert.deepEqual(out.report, R1);
  assert.equal(out.via, 'memory-exact');
});

test('purchase 2 from B on the same process is NEVER R1 again', () => {
  // Same Map entry, now spent. R2 sits unclaimed in the table under another
  // address. Shadow mode is on, so nothing is delivered and R2 is named.
  const sold = markSpent(entry({ report: R1 }), { at: 5000, token: 't' });
  const out = whatWouldBeDelivered({
    memory: sold,
    rowState: { reachable: true, found: true, claimed: true },
    tableCandidates: [{ id: 'row-2', claimed_at: null, report: R2 }],
  });
  assert.notDeepEqual(out.report, R1, 'THE REGRESSION: R1 must not be resold');
  assert.equal(out.report, null, 'shadow mode delivers nothing on an inferred match');
  assert.equal(out.via, 'shadow-would-infer');
  assert.deepEqual(out.wouldBe, R2, 'the would-infer line must name R2s row, not R1s');
});

test('purchase 2 with the table unreachable still does not resell R1', () => {
  // The spent flag is the only surviving signal here, and it has to be enough.
  const sold = markSpent(entry({ report: R1 }), { at: 5000, token: 't' });
  const out = whatWouldBeDelivered({ memory: sold, rowState: { reachable: false }, tableCandidates: [] });
  assert.notDeepEqual(out.report, R1);
  assert.equal(out.via, 'cache-miss');
});

test('an unsold entry with an unreachable table IS still delivered', () => {
  // The other side of the same comparison. Without this, the test above would
  // pass on a rule that simply never trusts memory.
  const out = whatWouldBeDelivered({
    memory: entry({ report: R1, pendingId: null }),
    rowState: { reachable: false }, tableCandidates: [],
  });
  assert.deepEqual(out.report, R1);
  assert.equal(out.via, 'memory-exact');
});

// ── alertThrottle, used by C2 and C3 ────────────────────────────────────────

test('the first alert always sends', () => {
  const r = alertThrottle({ lastSentAt: 0, now: 1_000_000 });
  assert.equal(r.send, true);
});

test('a second alert inside the window is suppressed', () => {
  const now = 1_000_000;
  const r = alertThrottle({ lastSentAt: now - 60_000, now });
  assert.equal(r.send, false);
});

test('an alert after the window sends again', () => {
  const now = 1_000_000;
  const r = alertThrottle({ lastSentAt: now - ALERT_THROTTLE_MS - 1, now });
  assert.equal(r.send, true);
});

test('the window is ten minutes', () => {
  assert.equal(ALERT_THROTTLE_MS, 10 * 60 * 1000);
});

test('a clock that goes backwards does not unlock the throttle', () => {
  // lastSentAt in the future would make (now - lastSentAt) negative, which is
  // less than the window, so it must suppress rather than send.
  const r = alertThrottle({ lastSentAt: 2_000_000, now: 1_000_000 });
  assert.equal(r.send, false);
});
