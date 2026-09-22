// ════════════════════════════════════════════════════════════════════════════
// ONE SALE, ONE ROW, ACROSS PURCHASE, SWAP AND RECOVERY.
//
// THIS FILE ARGUED THE OPPOSITE UNTIL v8.11.51, AND THE ARGUMENT IS WORTH
// RECORDING BECAUSE IT WAS RIGHT ABOUT ITS PREMISE AND WRONG ABOUT ITS
// CONCLUSION.
//
// It said insert-then-delete was chosen BECAUSE the row must exist before the
// delivery email goes out, and that patching the order row in place instead
// would let the email be sent while the patch had failed, leaving a live link
// to a report with no row.
//
// The premise still holds. The conclusion does not. The row DOES exist before
// the email, because it was PATCHED, and the email is now gated on that patch
// having changed exactly one row and read back correctly. THE EMAIL MOVED, NOT
// THE ROW.
//
// What the old design cost, measured: createCustomer inserted a row holding
// the new report token, then the bookkeeping tried to write that same token
// onto the order row, and report_token is guarded twice. Every swap and every
// recovery was refused with 23505, and because the duplicate delete was gated
// on that write, the refusal cancelled the cleanup too. Four sales on
// 2026-09-22 hold two rows each.
//
// THE THREE FUNCTIONS THIS FILE USED TO DRIVE ARE GONE:
// recordSwapOnOrderRow, supersedePlaceholderRow, deleteDuplicateSubscriberRow.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39321';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const { writeOrderRow, findOrderRow, setFetch } = __test__;

// The same ledger as order-row-write.test.js: it applies id and report_token
// filters and ENFORCES THE UNIQUE GUARD, because that guard is the defect.
function ledger(seed) {
  let auto = 0;
  const rows = (seed || []).map((r) => ({ id: r.id || 'seed-' + (++auto), ...r }));
  const calls = [];
  function predicate(query) {
    const tests = [];
    for (const part of String(query).split('&')) {
      if (!part || part.startsWith('select=') || part.startsWith('order=')
          || part.startsWith('limit=') || part.startsWith('on_conflict=')) continue;
      const m = part.match(/^([A-Za-z0-9_]+)=(eq|neq|is)\.(.*)$/);
      if (!m) throw new Error('ledger: filter it cannot evaluate: ' + part);
      const [, col, op, raw] = m;
      const val = decodeURIComponent(raw);
      if (op === 'eq') tests.push((r) => String(r[col]) === val);
      else if (op === 'neq') tests.push((r) => String(r[col]) !== val);
      else tests.push((r) => (val === 'null' ? r[col] == null : String(r[col]) === val));
    }
    return (r) => tests.every((t) => t(r));
  }
  const violates = (cand, selfId) => {
    const tok = cand.report_token;
    if (tok === null || tok === undefined) return false;
    return rows.some((r) => r.id !== selfId && r.report_token === tok);
  };
  const fake = async (url, init) => {
    const i = init || {};
    const method = String(i.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    const table = (u.pathname.match(/\/rest\/v1\/([A-Za-z0-9_]+)/) || [])[1];
    const body = i.body ? JSON.parse(i.body) : null;
    calls.push({ url: String(url), method, table });
    if (table !== 'subscribers') {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    const match = predicate(u.search.replace(/^\?/, ''));
    if (method === 'POST') {
      const added = (Array.isArray(body) ? body : [body]).map((r) => ({ id: 'row-' + (++auto), ...r }));
      for (const r of added) {
        if (violates(r, r.id)) return { ok: false, status: 409, json: async () => ({ code: '23505' }), text: async () => 'dup' };
      }
      rows.push(...added);
      return { ok: true, status: 201, json: async () => added, text: async () => JSON.stringify(added) };
    }
    if (method === 'PATCH') {
      const hit = rows.filter(match);
      for (const r of hit) {
        if (violates({ ...r, ...body }, r.id)) {
          return { ok: false, status: 409, json: async () => ({ code: '23505' }), text: async () => 'dup' };
        }
      }
      for (const r of hit) Object.assign(r, body);
      return { ok: true, status: 200, json: async () => hit, text: async () => JSON.stringify(hit) };
    }
    if (method === 'DELETE') {
      const hit = rows.filter(match);
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return { ok: true, status: 200, json: async () => hit, text: async () => JSON.stringify(hit) };
    }
    let found = rows.filter(match);
    const ord = (u.search.match(/[?&]order=([^&]+)/) || [])[1];
    if (ord) {
      const [col, dir] = decodeURIComponent(ord).split('.');
      found = found.slice().sort((a, b) => {
        const x = String(a[col] == null ? '' : a[col]), y = String(b[col] == null ? '' : b[col]);
        return (dir === 'desc' ? -1 : 1) * (x < y ? -1 : x > y ? 1 : 0);
      });
    }
    const limited = /limit=1(&|$)/.test(u.search) ? found.slice(0, 1) : found;
    return { ok: true, status: 200, json: async () => limited, text: async () => JSON.stringify(limited) };
  };
  return {
    fake, calls, rows: () => rows.slice(), count: () => rows.length,
    inserts: () => calls.filter((c) => c.table === 'subscribers' && c.method === 'POST').length,
    deletes: () => calls.filter((c) => c.table === 'subscribers' && c.method === 'DELETE').length,
  };
}

async function withDb(db, fn) {
  const restore = setFetch(db.fake);
  try { return await fn(); } finally { restore(); }
}

const PAYING = 'buyer@example.invalid';
const base = (over) => ({
  email: PAYING, firstName: 'Sam', restaurantName: 'R', location: 'L', website: '',
  report: { healthCheckScore: 70, pillars: {} }, survey: {}, planType: 'one_off',
  amountPaid: 49.99, orderKey: null, ...over,
});

// ── THE SEQUENCE ──────────────────────────────────────────────────────────

test('A MATCHED PURCHASE LEAVES ONE ROW', async () => {
  const db = ledger();
  const out = await withDb(db, () => writeOrderRow(base({ orderKey: 'k1', restaurantName: 'The Sale' })));
  assert.equal(out.ok, true);
  assert.equal(db.count(), 1);
  assert.equal(db.inserts(), 1);
});

test('A SWAP ON THAT ORDER LEAVES ONE ROW, the same one', async () => {
  const db = ledger();
  await withDb(db, () => writeOrderRow(base({ orderKey: 'k1', restaurantName: 'The Sale' })));
  const orderId = db.rows()[0].id;

  const swap = await withDb(db, () => writeOrderRow(base({
    restaurantName: 'The Swap', targetRowId: orderId, noteText: 'SWAPPED: yes' })));
  assert.equal(swap.ok, true, swap.reason);
  assert.equal(db.count(), 1, 'one sale left ' + db.count() + ' rows');
  assert.equal(db.rows()[0].id, orderId, 'the wrong row survived');
  assert.equal(db.rows()[0].restaurant_name, 'The Swap');
  assert.equal(db.rows()[0].order_key, 'k1', 'the order identity was lost');
  assert.match(String(db.rows()[0].notes), /SWAPPED/);

  assert.equal(db.inserts(), 1, 'the swap inserted a second row');
  assert.equal(db.deletes(), 0, 'something had to be deleted, so something was inserted');
});

test('THE MISMATCHED-ADDRESS CASE: purchase, placeholder, then recovery, ONE ROW', async () => {
  // This is the case that produced three of the four split sales on
  // 2026-09-22: the survey saved under one address, the checkout from
  // another, so the webhook matches nothing and writes a placeholder.
  const db = ledger([{
    id: 'the-placeholder', email: PAYING, report_token: null,
    notes: 'UNMATCHED_AT_PURCHASE: paid, no survey matched.',
    amount_paid: 49.99, subscribed_at: '2026-09-22T12:00:00Z',
  }]);
  assert.equal(db.count(), 1);

  const rec = await withDb(db, () => writeOrderRow(base({
    restaurantName: 'The Recovered', targetRowId: 'the-placeholder',
    noteText: 'RECOVERED: delivered by the recovery link.' })));
  assert.equal(rec.ok, true, rec.reason);

  assert.equal(db.count(), 1, 'the recovery left ' + db.count() + ' rows for one sale');
  const row = db.rows()[0];
  assert.equal(row.id, 'the-placeholder');
  assert.ok(row.report_token, 'the placeholder was never filled in');
  assert.equal(row.amount_paid, 49.99, 'the amount was restated');
  assert.equal(row.subscribed_at, '2026-09-22T12:00:00Z', 'the sale date moved');
  assert.equal(db.inserts(), 0, 'THE RECOVERY INSERTED A SECOND ROW');
});

test('ACROSS THE WHOLE SEQUENCE: one insert, zero deletes', async () => {
  const db = ledger();
  await withDb(db, () => writeOrderRow(base({ orderKey: 'k1' })));
  const id = db.rows()[0].id;
  await withDb(db, () => writeOrderRow(base({ targetRowId: id, restaurantName: 'B' })));
  await withDb(db, () => writeOrderRow(base({ targetRowId: id, restaurantName: 'C' })));
  assert.equal(db.inserts(), 1);
  assert.equal(db.deletes(), 0);
  assert.equal(db.count(), 1);
});

test('THE CLICK FINDS THE ORDER ROW BY ITS KEY, after a swap has rewritten it', async () => {
  const db = ledger();
  await withDb(db, () => writeOrderRow(base({ orderKey: 'k1', restaurantName: 'The Sale' })));
  const id = db.rows()[0].id;
  await withDb(db, () => writeOrderRow(base({ targetRowId: id, restaurantName: 'The Swap' })));
  const found = await withDb(db, () => findOrderRow({ payingEmail: PAYING, orderKey: 'k1' }));
  assert.equal(found && found.id, id);
  assert.equal(found.restaurant_name, 'The Swap');
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the ledger enforces the unique guard', async () => {
  const db = ledger([{ id: 'a', report_token: 't1' }]);
  const res = await db.fake('https://db.invalid/rest/v1/subscribers', {
    method: 'POST', body: JSON.stringify({ report_token: 't1' }) });
  assert.equal(res.status, 409);
});

test('CONTROL: the ledger counts inserts, so "one insert" is measured', async () => {
  const db = ledger();
  assert.equal(db.inserts(), 0);
  await withDb(db, () => writeOrderRow(base()));
  assert.equal(db.inserts(), 1);
  await withDb(db, () => writeOrderRow(base()));
  assert.equal(db.inserts(), 2, 'a second insert was not counted');
});

test('CONTROL: two rows CAN exist in this ledger, so "one row" is not structural', async () => {
  const db = ledger([{ id: 'a' }, { id: 'b' }]);
  assert.equal(db.count(), 2);
});

test('CONTROL: a patch to a row that is not there fails, and inserts nothing', async () => {
  const db = ledger([{ id: 'a' }]);
  const out = await withDb(db, () => writeOrderRow(base({ targetRowId: 'nope' })));
  assert.equal(out.ok, false);
  assert.equal(db.count(), 1);
  assert.equal(db.inserts(), 0);
});
