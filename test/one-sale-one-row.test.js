// ════════════════════════════════════════════════════════════════════════════
// RVP PACKAGE ITEM 2: ONE SALE, ONE ROW.
//
// Every delivery path goes through deliverPaidReport, and deliverPaidReport
// calls createCustomer, and createCustomer INSERTS A SUBSCRIBER ROW. The
// webhook does it once for the sale. THE RECOVERY AND SWAP PATHS DO IT AGAIN,
// for the same sale, because they run the same flow.
//
// Measured against the live table on 2026-09-21: 100 subscriber rows, and the
// program has already recorded that the 2026-09-20 double delivery was caused
// by the ORDER ROW LOOKUP picking the newest row for an address, which is a
// problem that only exists because there is more than one row per sale.
//
// THIS FILE DOES NOT FIX IT. The fix needs the subscriber row to carry the
// order identity it was minted for, and subscribers HAS NO SUCH COLUMN, so
// the fix is a migration and is out of scope for an overnight branch.
//
// What this file does is make the defect COUNTABLE, and pin the count, so that
// when the migration lands the fix has a test that was red first. Before this
// there was no seam at all: RVP had no injectable fetch anywhere, so no test
// had ever observed a write.
//
// ── 2026-09-22, v8.11.49: THAT IS NO LONGER WHERE THINGS STAND ────────────
//
// Migration 004 landed, server.js can be imported without serving, and
// test/swap-row-accounting.test.js counts the REAL createCustomer,
// findOrderRow, recordSwapOnOrderRow and deleteDuplicateSubscriberRow.
// Go there for the rule. What is left below is the contract written out
// against a fake this file drives itself, which is worth keeping as a
// statement of intent and is worth nothing as evidence, so nothing below
// should be quoted as proof that the code does anything.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { countingSupabase } from '../lib-testdb.js';

// ── The counting fake ─────────────────────────────────────────────────────

test('the fake counts an insert and answers like PostgREST', async () => {
  const db = countingSupabase();
  const res = await db.fetch('https://x.invalid/rest/v1/subscribers', {
    method: 'POST', headers: {}, body: JSON.stringify({ email: 'a@b.invalid' }),
  });
  assert.equal(res.ok, true);
  assert.equal(db.inserts('subscribers'), 1);
  assert.equal(db.rows('subscribers').length, 1);
});

test('CONTROL: a SELECT is not counted as an insert', async () => {
  const db = countingSupabase();
  await db.fetch('https://x.invalid/rest/v1/subscribers?select=*', { method: 'GET', headers: {} });
  assert.equal(db.inserts('subscribers'), 0);
});

test('CONTROL: an insert into a different table is counted separately', async () => {
  const db = countingSupabase();
  await db.fetch('https://x.invalid/rest/v1/rvp_outcomes', {
    method: 'POST', headers: {}, body: JSON.stringify({ kind: 'recover' }),
  });
  assert.equal(db.inserts('subscribers'), 0);
  assert.equal(db.inserts('rvp_outcomes'), 1);
});

test('CONTROL: the counter can be wrong about a table it never saw', async () => {
  const db = countingSupabase();
  assert.equal(db.inserts('no_such_table'), 0);
  assert.deepEqual(db.rows('no_such_table'), []);
});

// ── The rule, stated as a test ────────────────────────────────────────────
//
// These pin the CONTRACT. They are written against the counting fake rather
// than against deliverPaidReport, because deliverPaidReport cannot be imported
// without starting a listener, and because the fix that makes them meaningful
// is blocked on a migration.

test('ONE SALE, ONE ROW: the rule, stated', async () => {
  const db = countingSupabase();
  // A sale: the webhook delivers once.
  await db.fetch('https://x.invalid/rest/v1/subscribers', {
    method: 'POST', headers: {}, body: JSON.stringify({ email: 'buyer@example.invalid', report_token: 'tok1' }),
  });
  assert.equal(db.inserts('subscribers'), 1, 'the sale itself must write exactly one row');
});

test('A SWAP OR RECOVERY FOR THE SAME SALE MUST NOT WRITE A SECOND ROW', async () => {
  const db = countingSupabase();
  const sale = () => db.fetch('https://x.invalid/rest/v1/subscribers', {
    method: 'POST', headers: {}, body: JSON.stringify({ email: 'buyer@example.invalid', report_token: 'tok1' }),
  });
  const swapReusingTheRow = () => db.fetch(
    'https://x.invalid/rest/v1/subscribers?report_token=eq.tok1',
    { method: 'PATCH', headers: {}, body: JSON.stringify({ baseline_report: { swapped: true } }) },
  );
  await sale();
  await swapReusingTheRow();
  assert.equal(db.inserts('subscribers'), 1,
    'a swap for an existing sale inserted a second subscriber row');
  assert.equal(db.patches('subscribers'), 1,
    'a swap must UPDATE the row the sale minted, not create another');
});

test('THE SHAPE THE CURRENT CODE PRODUCES, pinned so the fix has a red', async () => {
  // deliverPaidReport calls createCustomer on EVERY path, so a swap inserts.
  //
  // v8.11.49: STILL 2, AND DELIBERATELY SO. The swap path was not changed to
  // stop inserting. deliverPaidReport mints the report token the delivery
  // email links to, and the row has to exist before that email goes out;
  // patching the order row in place instead would let the email be sent while
  // the patch had failed, leaving a live link to a report with no row. The
  // rule is a NET count of 1, and swap-row-accounting.test.js asserts it
  // against the real functions.
  const db = countingSupabase();
  const deliverLikeToday = () => db.fetch('https://x.invalid/rest/v1/subscribers', {
    method: 'POST', headers: {}, body: JSON.stringify({ email: 'buyer@example.invalid' }),
  });
  await deliverLikeToday();   // the webhook
  await deliverLikeToday();   // the swap, same sale
  assert.equal(db.inserts('subscribers'), 2,
    'if this is no longer 2, the swap path has stopped inserting and the rule '
    + 'test above should be wired to the real code');
});
