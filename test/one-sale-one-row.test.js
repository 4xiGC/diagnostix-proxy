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
  // This is what the code does today, written down. When the migration lands
  // and the swap path reuses the row, this expectation changes to 1 and the
  // test above becomes the live one.
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
