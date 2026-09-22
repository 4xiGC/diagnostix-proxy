// ════════════════════════════════════════════════════════════════════════════
// ONE SALE, ONE ROW, COUNTED AGAINST THE REAL WRITE FUNCTIONS.
//
// test/one-sale-one-row.test.js states the rule against a fake it drives
// itself: it posts to the fake and asserts the fake counted the post. That
// cannot fail on the real code being wrong. This file calls createCustomer,
// findOrderRow, recordSwapOnOrderRow and deleteDuplicateSubscriberRow out of
// server.js and counts what THEY do.
//
// THE MECHANISM IS INSERT-THEN-DELETE, NOT NEVER-INSERT, and that is a
// deliberate choice rather than an unfinished one. deliverPaidReport builds
// the report token that the delivery email links to, and the row has to exist
// before that email goes out. Making the swap path patch the order row in
// place instead would mean the email could be sent while the patch had failed,
// leaving a live link to a report with no row. Inserting and then removing the
// duplicate keeps the row present for the whole window in which it is needed.
// So the rule is a NET count, and that is what is asserted.
//
// WHAT THIS FILE CANNOT REACH. POST /recover is an Express handler; driving it
// would mean generating a report and sending mail, which costs money and is
// out of scope. The ORDER of the four calls is therefore stated by this test,
// not proved by it. Each call is real; the sequence is not. That limit is
// real and is recorded rather than glossed.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { swapOrderKey, signRecoveryToken } from '../lib-pending.js';

process.env.PORT = '39231';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const { setFetch, createCustomer, findOrderRow,
        recordSwapOnOrderRow, deleteDuplicateSubscriberRow } = __test__;

// ── A ledger that can be counted ──────────────────────────────────────────
//
// countingSupabase counts writes but never applies them, so rows() after a
// delete still shows the deleted row and a NET count is not available from it.
// This one applies three filter forms and no others: id=eq., id=neq. and
// report_token=eq. Everything else it refuses loudly rather than matching
// everything, because a filter engine that silently ignores what it does not
// understand turns a delete of one row into a delete of all of them.
//
// IT IS STILL NOT A DATABASE. No unique index, no constraint, no RLS. It
// answers one question: how many rows are left.
function ledger(seed) {
  let auto = 0;
  const rows = (seed || []).map((r) => ({ id: r.id || 'seed-' + (++auto), ...r }));
  const calls = [];

  function predicate(query) {
    const tests = [];
    for (const part of String(query).split('&')) {
      if (!part || part.startsWith('select=') || part.startsWith('order=')
          || part.startsWith('limit=') || part.startsWith('on_conflict=')) continue;
      const eq = part.match(/^([A-Za-z0-9_]+)=(eq|neq|is)\.(.*)$/);
      if (!eq) throw new Error('ledger: filter it cannot evaluate: ' + part);
      const [, col, op, rawVal] = eq;
      const val = decodeURIComponent(rawVal);
      if (op === 'eq') tests.push((r) => String(r[col]) === val);
      else if (op === 'neq') tests.push((r) => String(r[col]) !== val);
      else tests.push((r) => (val === 'null' ? r[col] == null : String(r[col]) === val));
    }
    return (r) => tests.every((t) => t(r));
  }

  const fake = async (url, opts) => {
    const o = opts || {};
    const method = String(o.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    const table = (u.pathname.match(/\/rest\/v1\/([A-Za-z0-9_]+)/) || [])[1];
    const body = o.body ? JSON.parse(o.body) : null;
    calls.push({ url: String(url), method, table, body });

    if (table !== 'subscribers') {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    const match = predicate(u.search.replace(/^\?/, ''));

    if (method === 'POST') {
      const added = (Array.isArray(body) ? body : [body]).map((r) => ({ id: 'row-' + (++auto), ...r }));
      rows.push(...added);
      return { ok: true, status: 201, json: async () => added, text: async () => JSON.stringify(added) };
    }
    if (method === 'PATCH') {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, body);
      return { ok: true, status: 200, json: async () => hit, text: async () => JSON.stringify(hit) };
    }
    if (method === 'DELETE') {
      const hit = rows.filter(match);
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return { ok: true, status: 200, json: async () => hit, text: async () => JSON.stringify(hit) };
    }
    // ORDERING IS APPLIED, and it has to be. Without it this ledger returns
    // rows in insertion order, "the newest row for the address" is never
    // modelled, and the regression test below passes against the very code it
    // exists to catch. Checked by running that test against the commit before
    // the fix: red with ordering, green without it.
    let found = rows.filter(match);
    const ord = (u.search.match(/[?&]order=([^&]+)/) || [])[1];
    if (ord) {
      const [col, dir] = decodeURIComponent(ord).split('.');
      found = found.slice().sort((a, b) => {
        const x = String(a[col] == null ? '' : a[col]);
        const y = String(b[col] == null ? '' : b[col]);
        return (dir === 'desc' ? -1 : 1) * (x < y ? -1 : x > y ? 1 : 0);
      });
    }
    const limited = /limit=1(&|$)/.test(u.search) ? found.slice(0, 1) : found;
    return { ok: true, status: 200, json: async () => limited, text: async () => JSON.stringify(limited) };
  };

  return { fake, calls, rows: () => rows.slice(), count: () => rows.length };
}

async function withFetch(fake, fn) {
  const restore = setFetch(fake);
  try { return await fn(); } finally { restore(); }
}

const PAYING = 'buyer@example.invalid';
const TOKEN = signRecoveryToken({
  payingEmail: PAYING, issuedAt: 1758000000000,
  secret: 'a-test-secret-value-of-sufficient-length',
});
const KEY = swapOrderKey({ payingEmail: PAYING, token: TOKEN });

const sale = (db, orderKey) => withFetch(db.fake, () => createCustomer({
  email: PAYING, firstName: 'A', restaurantName: 'The Sale', location: 'L', website: '',
  report: { healthCheckScore: 61 }, survey: {}, planType: 'one-time',
  amountPaid: 49.99, orderKey,
}));

// ── The rule ──────────────────────────────────────────────────────────────

test('A SALE WRITES EXACTLY ONE ROW', async () => {
  const db = ledger();
  await sale(db, KEY);
  assert.equal(db.count(), 1);
  assert.equal(db.rows()[0].order_key, KEY, 'the row does not carry its order');
});

test('ONE SALE AND ONE SWAP LEAVE ONE ROW', async () => {
  const db = ledger();
  // 1. The webhook delivers the sale and mints the recovery link.
  const order = await sale(db, KEY);
  const orderRow = db.rows()[0];
  assert.equal(db.count(), 1, 'the sale did not write one row');

  // 2. The buyer clicks the link. The handler finds the order row.
  const found = await withFetch(db.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: KEY }));
  assert.equal(found && found.id, orderRow.id, 'the click did not find the order row');

  // 3. deliverPaidReport runs the paid flow again, which inserts.
  const swapped = await withFetch(db.fake, () => createCustomer({
    email: PAYING, firstName: 'A', restaurantName: 'The Swap', location: 'L', website: '',
    report: { healthCheckScore: 74 }, survey: {}, planType: 'one-time', amountPaid: 49.99,
  }));
  assert.equal(db.count(), 2, 'the swap delivery did not insert, so there is nothing to clean up');

  // 4. The swap is folded into the order row and the duplicate is removed.
  const noted = await withFetch(db.fake, () => recordSwapOnOrderRow({
    orderId: orderRow.id, subscriber: swapped,
    report: { healthCheckScore: 74 }, restaurantName: 'The Swap',
  }));
  assert.equal(noted, true, 'the swap note did not land on one row');
  const removed = await withFetch(db.fake, () => deleteDuplicateSubscriberRow({
    reportToken: swapped.reportToken, keepId: orderRow.id,
  }));
  assert.equal(removed, true, 'the duplicate was not removed');

  // THE RULE.
  assert.equal(db.count(), 1, 'one sale left ' + db.count() + ' rows');
  const survivor = db.rows()[0];
  assert.equal(survivor.id, orderRow.id, 'the wrong row survived');
  assert.equal(survivor.order_key, KEY, 'the survivor lost its order identity');
  assert.equal(survivor.report_token, swapped.reportToken, 'the survivor kept the old report');
  assert.equal(survivor.amount_paid, 49.99, 'the sale amount was restated or lost');
  assert.equal(order.email, survivor.email);
});

test('THE SWAP NOTE LANDS ON THE ORDER ROW, NOT ON THE NEWEST ROW', async () => {
  // This is the 2026-09-20 defect, stated as a test. A buyer with a LATER,
  // unrelated row used to have the swap folded into that one, because the
  // lookup took the newest row for the address.
  const db = ledger([
    { id: 'the-order', email: PAYING, order_key: KEY, subscribed_at: '2026-09-01T00:00:00Z' },
    { id: 'a-later-order', email: PAYING, order_key: 'some-other-order', subscribed_at: '2026-09-20T00:00:00Z' },
  ]);
  const found = await withFetch(db.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: KEY }));
  assert.equal(found && found.id, 'the-order',
    'the lookup took the newest row for the address again');
});

test('WITH NO KEY IT STILL TAKES THE NEWEST ROW, which is why old orders need the fallback', async () => {
  // Not a defect being left in: it is the only thing that can find the 100
  // stored rows, and it is written down so nobody reads the test above as a
  // claim that the address path changed.
  const db = ledger([
    { id: 'the-order', email: PAYING, subscribed_at: '2026-09-01T00:00:00Z' },
    { id: 'a-later-order', email: PAYING, subscribed_at: '2026-09-20T00:00:00Z' },
  ]);
  const found = await withFetch(db.fake, () => findOrderRow({ payingEmail: PAYING }));
  assert.equal(found && found.id, 'a-later-order',
    'the address path no longer returns the newest row, so the test above is '
    + 'not measuring what it claims to measure');
});

test('THE DUPLICATE DELETE EXCLUDES THE ROW IT MUST KEEP', async () => {
  // recordSwapOnOrderRow writes the same report token onto the order row, so a
  // delete matching only on the token matches BOTH and removes the survivor.
  // The A7d run ended with zero rows for a paid, delivered order exactly here.
  const db = ledger([
    { id: 'the-order', email: PAYING, report_token: 'shared-token' },
    { id: 'the-duplicate', email: PAYING, report_token: 'shared-token' },
  ]);
  await withFetch(db.fake, () => deleteDuplicateSubscriberRow({
    reportToken: 'shared-token', keepId: 'the-order',
  }));
  assert.equal(db.count(), 1, 'the delete removed ' + (2 - db.count()) + ' rows');
  assert.equal(db.rows()[0].id, 'the-order', 'it removed the row it was told to keep');
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the ledger orders descending, or "newest" means nothing', async () => {
  const db = ledger([
    { id: 'old', email: PAYING, subscribed_at: '2026-09-01T00:00:00Z' },
    { id: 'new', email: PAYING, subscribed_at: '2026-09-20T00:00:00Z' },
  ]);
  const r = await db.fake('https://db.invalid/rest/v1/subscribers?select=*'
    + '&email=eq.' + encodeURIComponent(PAYING) + '&order=subscribed_at.desc&limit=1');
  const got = await r.json();
  assert.equal(got[0].id, 'new', 'the ledger ignores order=, so it cannot model the defect');
});

test('CONTROL: WITHOUT keepId the delete takes both rows', async () => {
  // Proves the assertion above is about id=neq and not about the ledger being
  // unable to delete anything.
  const db = ledger([
    { id: 'the-order', email: PAYING, report_token: 'shared-token' },
    { id: 'the-duplicate', email: PAYING, report_token: 'shared-token' },
  ]);
  await withFetch(db.fake, () => deleteDuplicateSubscriberRow({ reportToken: 'shared-token' }));
  assert.equal(db.count(), 0, 'the ledger cannot delete, so the test above proves nothing');
});

test('CONTROL: the ledger really counts rows up and down', async () => {
  const db = ledger();
  assert.equal(db.count(), 0);
  await sale(db, KEY);
  assert.equal(db.count(), 1);
  await sale(db, null);
  assert.equal(db.count(), 2, 'a second insert was not counted');
  await withFetch(db.fake, () => deleteDuplicateSubscriberRow({
    reportToken: db.rows()[1].report_token, keepId: db.rows()[0].id,
  }));
  assert.equal(db.count(), 1, 'a delete was not counted');
});

test('CONTROL: the ledger refuses a filter it cannot evaluate', async () => {
  // A filter engine that ignores what it does not understand matches
  // everything, and a delete of one row becomes a delete of all of them. The
  // real filters in this file would then pass for the wrong reason.
  const db = ledger([{ id: 'a' }]);
  await assert.rejects(
    () => db.fake('https://db.invalid/rest/v1/subscribers?email=like.*x*', { method: 'DELETE' }),
    /cannot evaluate/);
  assert.equal(db.count(), 1);
});

test('CONTROL: the swap note can fail to land', async () => {
  // recordSwapOnOrderRow returns false when the patch changes no row. If it
  // could only ever return true, asserting true in the rule test above would
  // be a reading.
  const db = ledger([{ id: 'the-order', email: PAYING }]);
  const noted = await withFetch(db.fake, () => recordSwapOnOrderRow({
    orderId: 'a-row-that-is-not-there', subscriber: { restaurantName: 'X' },
    report: {}, restaurantName: 'X',
  }));
  assert.equal(noted, false, 'the swap note reports success against a row that does not exist');
});
