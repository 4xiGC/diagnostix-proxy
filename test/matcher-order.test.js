// ════════════════════════════════════════════════════════════════════════════
// v8.11.29: the matcher will not sort by NaN.
//
// THE TRAP. matchPendingReport sorts exact candidates newest first with
// Number(b.saved_at) - Number(a.saved_at). Today that works, because
// fetchPendingCandidates converts every row with Date.parse before the matcher
// sees it. That conversion lives in a DIFFERENT FUNCTION, in a different file,
// and nothing states that it must happen.
//
// Hand the matcher raw PostgREST rows, where saved_at is the ISO string
// "2026-09-19T20:26:50+00:00", and Number() of that is NaN. A comparator that
// returns NaN leaves the array in whatever order it arrived, so the sort
// silently becomes a no-op and element zero of the caller's ordering wins. The
// pure tests feed numbers by hand and stay green while the real thing picks an
// arbitrary row.
//
// This was investigated as the cause of the 2026-09-20 misdelivery and was NOT
// the cause: only one row matched the paying address, so ordering could not
// have changed the outcome. It is fixed anyway, because the invariant it
// depends on is undocumented and one refactor away from being violated.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPendingReport } from '../lib-pending.js';

const A = 'buyer@example.com';
const row = (o) => Object.assign({ id: 'r', email_normalized: A, claimed_at: null, saved_at: 0 }, o);
const NOW = 1_700_000_000_000;

test('shuffled input still picks the newest exact match', () => {
  const rows = [
    row({ id: 'old', saved_at: NOW - 18 * 3600e3 }),
    row({ id: 'newest', saved_at: NOW - 60e3 }),
    row({ id: 'middle', saved_at: NOW - 3600e3 }),
  ];
  // Every ordering of the same three rows must give the same answer.
  const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [0, 2, 1], [2, 0, 1], [1, 2, 0]];
  for (const o of orders) {
    const m = matchPendingReport({ payingEmail: A, candidates: o.map(i => rows[i]), now: NOW });
    assert.equal(m.decision, 'exact');
    assert.equal(m.match.id, 'newest', 'order ' + JSON.stringify(o) + ' picked ' + m.match.id);
  }
});

test('a non-numeric saved_at throws instead of sorting by NaN', () => {
  const rows = [
    row({ id: 'iso-old', saved_at: '2026-09-19T20:26:50+00:00' }),
    row({ id: 'iso-new', saved_at: '2026-09-20T13:55:11+00:00' }),
  ];
  assert.throws(
    () => matchPendingReport({ payingEmail: A, candidates: rows, now: NOW }),
    /saved_at/,
    'raw ISO strings must be refused, not silently sorted by NaN');
});

test('the throw names the offending row so an operator can find it', () => {
  try {
    matchPendingReport({ payingEmail: A, candidates: [row({ id: 'bad-row-7', saved_at: 'nonsense' })], now: NOW });
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /bad-row-7/, 'the message does not name the row');
  }
});

test('CONTROL: the same rows with numeric saved_at do not throw', () => {
  const rows = [row({ id: 'a', saved_at: NOW - 1000 }), row({ id: 'b', saved_at: NOW - 2000 })];
  assert.doesNotThrow(() => matchPendingReport({ payingEmail: A, candidates: rows, now: NOW }));
});

test('a claimed row with a bad saved_at is ignored, not thrown on', () => {
  // Claimed rows are filtered out before any arithmetic. A bad timestamp on a
  // row the matcher is not considering must not take down a live purchase.
  const rows = [
    row({ id: 'claimed-bad', saved_at: 'nonsense', claimed_at: '2026-01-01T00:00:00Z' }),
    row({ id: 'good', saved_at: NOW - 1000 }),
  ];
  let m;
  assert.doesNotThrow(() => { m = matchPendingReport({ payingEmail: A, candidates: rows, now: NOW }); });
  assert.equal(m.match.id, 'good');
});

test('a bad saved_at on a DIFFERENT address still throws, because the window rule reads it', () => {
  const rows = [row({ id: 'other-bad', email_normalized: 'someone@else.com', saved_at: 'nonsense' })];
  assert.throws(() => matchPendingReport({ payingEmail: A, candidates: rows, now: NOW }), /saved_at/);
});
