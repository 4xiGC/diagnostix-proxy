// ════════════════════════════════════════════════════════════════════════════
// v8.11.17 [A1]: a delivered survey stops being a candidate
//
// THE BUG. A memory hit delivered the report and never touched the table, so
// the pending_reports row stayed unclaimed. It then remained a live candidate
// for somebody else:
//
//   11:30  Y finishes a survey
//   12:00  X finishes a survey, pays from the SAME address, memory hit,
//          delivered, row left UNCLAIMED
//   12:05  Y pays from a DIFFERENT address. The window holds exactly one
//          unclaimed row: X's. Y is delivered X's report.
//
// The matcher was right at every step. The row was never retired.
//
// THE PURE PART is what decides whether a row is still a candidate, and that
// is what is tested here: selectRowToClaim names the row a delivery must
// retire, for every decision including the memory hit that has no row object
// in hand.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRowToClaim, matchPendingReport } from '../lib-pending.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const min = (n) => n * 60 * 1000;
const X = 'x.payer@example.com';
const Y = 'y.payer@example.org';

const row = (o) => Object.assign({ id: 'r1', email_normalized: X, saved_at: NOW - min(5), claimed_at: null }, o);

test('a memory hit still names a row to claim, found by exact address', () => {
  const r = selectRowToClaim({
    decision: 'memory-exact', matchedRow: null, payingEmail: X,
    candidates: [row({ id: 'xrow' }), row({ id: 'other', email_normalized: Y })],
  });
  assert.equal(r.id, 'xrow', 'a memory hit left the table row unclaimed, which is the A1 bug');
});

test('a memory hit names the NEWEST unclaimed row for that address', () => {
  const r = selectRowToClaim({
    decision: 'memory-exact', matchedRow: null, payingEmail: X,
    candidates: [
      row({ id: 'old', saved_at: NOW - min(25) }),
      row({ id: 'new', saved_at: NOW - min(1) }),
    ],
  });
  assert.equal(r.id, 'new');
});

test('a memory hit never claims a row belonging to another address', () => {
  const r = selectRowToClaim({
    decision: 'memory-exact', matchedRow: null, payingEmail: X,
    candidates: [row({ id: 'someone-else', email_normalized: Y })],
  });
  assert.equal(r, null, 'a memory hit claimed a row for a different address');
});

test('a memory hit never claims an already claimed row', () => {
  const claimed = [row({ id: 'spent', claimed_at: '2026-09-19T11:00:00Z' })];
  assert.equal(selectRowToClaim({ decision: 'memory-exact', matchedRow: null, payingEmail: X, candidates: claimed }), null);
  // Control: unclaimed, the same row IS selected.
  assert.equal(selectRowToClaim({
    decision: 'memory-exact', matchedRow: null, payingEmail: X, candidates: [row({ id: 'spent' })],
  }).id, 'spent');
});

test('when the matcher supplied a row, that row is the one claimed', () => {
  const matched = row({ id: 'the-matched-one', email_normalized: Y });
  const r = selectRowToClaim({
    decision: 'exact', matchedRow: matched, payingEmail: X,
    candidates: [row({ id: 'a-different-one' })],
  });
  assert.equal(r.id, 'the-matched-one', 'the matcher’s own row must win over any re-derivation');
});

test('no candidates and no matched row means nothing to claim, not a throw', () => {
  for (const c of [undefined, null, [], 'nonsense', 42]) {
    let r;
    assert.doesNotThrow(() => { r = selectRowToClaim({ decision: 'memory-exact', matchedRow: null, payingEmail: X, candidates: c }); });
    assert.equal(r, null);
  }
  assert.equal(selectRowToClaim({ decision: 'memory-exact', matchedRow: null, payingEmail: '', candidates: [row({})] }), null);
});

test('the scenario end to end: X is delivered, and Y no longer sees X’s row', () => {
  // Y pays from their WIX ACCOUNT address, which is not the address they typed
  // into the survey. That is the whole reason inference exists, and the first
  // version of this test got it wrong by having Y pay from their own survey
  // address, which exact-matches and never reaches the window rule.
  const Y_WIX = 'y.wixaccount@example.org';
  const xRow = row({ id: 'X', email_normalized: X, saved_at: NOW });
  const yRow = row({ id: 'Y', email_normalized: Y, saved_at: NOW - min(30) });
  const pool = [xRow, yRow];

  // 12:00, X pays from the same address. Memory would hit; the row to retire:
  const toClaim = selectRowToClaim({ decision: 'memory-exact', matchedRow: null, payingEmail: X, candidates: pool });
  assert.equal(toClaim.id, 'X');

  // Before the fix, nothing was claimed. At 12:05 Y's own row is 35 minutes
  // old and out of the window, so the window holds exactly one unclaimed row,
  // X's, and Y would have been delivered X's report.
  const before = matchPendingReport({ payingEmail: Y_WIX, candidates: pool, now: NOW + min(5) });
  assert.equal(before.decision, 'inferred');
  assert.equal(before.match.id, 'X', 'control: this is the wrong delivery the fix prevents');

  // After claiming X's row, nothing is left in the window, so Y gets none and
  // goes to recovery, which is the correct outcome.
  xRow.claimed_at = new Date(NOW).toISOString();
  const after = matchPendingReport({ payingEmail: Y_WIX, candidates: pool, now: NOW + min(5) });
  assert.equal(after.decision, 'none', 'Y was still offered a delivered survey');
  assert.equal(after.match, null);
});
