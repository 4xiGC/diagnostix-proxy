// ════════════════════════════════════════════════════════════════════════════
// ONE SALE, ONE ROW: THE ORDER ROW IS PATCHED, NOT DUPLICATED.
//
// THE DEFECT, ROOT CAUSED FROM THE LIVE LOG ON 2026-09-22:
//
//   SUBSCRIBERS_WRITE [sale] what=swap-note method=PATCH
//     row=cddfe686-... http=409 rows=0 code=23505
//     constraint=idx_subscribers_report_token
//     details="Key (report_token)=(value withheld) already exists."
//
// createCustomer INSERTS a row holding the new report token. recordSwapOnOrderRow
// and supersedePlaceholderRow then try to write THAT SAME TOKEN onto a second
// row, and report_token is guarded twice, by subscribers_report_token_key and
// by idx_subscribers_report_token. The unique guard refuses it. And because
// deleteDuplicateSubscriberRow is gated on `if (swapped)`, the refusal also
// cancels the cleanup, so BOTH rows survive.
//
// IT IS DETERMINISTIC, NOT A RACE. Every swap and every recovery inserts and
// then patches to the same token, so every one has always failed here. Four
// sales on 2026-09-22 hold two rows each.
//
// THE FIX IS TO REMOVE THE COLLISION AT SOURCE. When a target row is known,
// PATCH it with the new report and token and NEVER INSERT, so no second row
// ever holds the token. The email is sent only when that patch changed exactly
// one row and the row reads back correctly.
//
// THIS REPLACES THE REASONING IN swap-row-accounting.test.js, which argued for
// insert-then-delete BECAUSE the row must exist before the email goes out. It
// still must. It now exists because it was PATCHED. THE EMAIL MOVED, NOT THE
// ROW.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39301';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const { writeOrderRow, setFetch } = __test__;

// A ledger that applies id=eq, id=neq, report_token=eq and report_token=is.null,
// and ENFORCES THE UNIQUE GUARD ON report_token, because that guard is the
// whole defect. Anything else it cannot evaluate, it throws on: a filter engine
// that ignores what it cannot parse matches everything.
function ledger(seed, opts) {
  const o = opts || {};
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

  // THE UNIQUE GUARD, modelled because it is the defect. A UNIQUE constraint
  // permits any number of NULLs, which is why the placeholder rows do not
  // collide with each other.
  const violates = (candidate, selfId) => {
    const tok = candidate.report_token;
    if (tok === null || tok === undefined) return false;
    return rows.some((r) => r.id !== selfId && r.report_token === tok);
  };

  const fake = async (url, init) => {
    const i = init || {};
    const method = String(i.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    const table = (u.pathname.match(/\/rest\/v1\/([A-Za-z0-9_]+)/) || [])[1];
    const body = i.body ? JSON.parse(i.body) : null;
    calls.push({ url: String(url), method, table, body });

    if (table !== 'subscribers') {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    if (o.failPatch && method === 'PATCH') {
      return { ok: false, status: o.failPatch, json: async () => ({ code: '23505' }),
               text: async () => 'forced' };
    }
    const match = predicate(u.search.replace(/^\?/, ''));

    if (method === 'POST') {
      const added = (Array.isArray(body) ? body : [body]).map((r) => ({ id: 'row-' + (++auto), ...r }));
      for (const r of added) {
        if (violates(r, r.id)) {
          return { ok: false, status: 409,
            json: async () => ({ code: '23505', constraint: 'idx_subscribers_report_token' }),
            text: async () => 'duplicate key' };
        }
      }
      rows.push(...added);
      return { ok: true, status: 201, json: async () => added, text: async () => JSON.stringify(added) };
    }
    if (method === 'PATCH') {
      const hit = rows.filter(match);
      for (const r of hit) {
        if (violates({ ...r, ...body }, r.id)) {
          return { ok: false, status: 409,
            json: async () => ({ code: '23505', constraint: 'idx_subscribers_report_token' }),
            text: async () => 'duplicate key' };
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
        const x = String(a[col] == null ? '' : a[col]);
        const y = String(b[col] == null ? '' : b[col]);
        return (dir === 'desc' ? -1 : 1) * (x < y ? -1 : x > y ? 1 : 0);
      });
    }
    const limited = /limit=1(&|$)/.test(u.search) ? found.slice(0, 1) : found;
    return { ok: true, status: 200, json: async () => limited, text: async () => JSON.stringify(limited) };
  };

  return { fake, calls, rows: () => rows.slice(), count: () => rows.length,
           inserts: () => calls.filter((c) => c.table === 'subscribers' && c.method === 'POST').length,
           patches: () => calls.filter((c) => c.table === 'subscribers' && c.method === 'PATCH').length,
           deletes: () => calls.filter((c) => c.table === 'subscribers' && c.method === 'DELETE').length };
}

async function withDb(db, fn) {
  const restore = setFetch(db.fake);
  try { return await fn(); } finally { restore(); }
}

const ARGS = (over) => ({
  email: 'buyer@example.invalid', firstName: 'Sam', restaurantName: 'A Restaurant',
  location: 'Santiago', website: '', report: { healthCheckScore: 70, pillars: {} },
  survey: {}, planType: 'one_off', amountPaid: 49.99, orderKey: null, ...over,
});

// ── The sale: no target, so it INSERTS, exactly as before ─────────────────

test('WITH NO TARGET ROW IT INSERTS, which is the matched webhook path', async () => {
  const db = ledger();
  const out = await withDb(db, () => writeOrderRow(ARGS({ orderKey: 'k1' })));
  assert.equal(out.ok, true);
  assert.equal(db.inserts(), 1);
  assert.equal(db.patches(), 0);
  assert.equal(db.count(), 1);
  assert.equal(db.rows()[0].order_key, 'k1');
});

// ── The swap and the recovery: a target, so it PATCHES and never inserts ──

test('WITH A TARGET ROW IT PATCHES AND NEVER INSERTS', async () => {
  const db = ledger([{ id: 'the-order', email: 'buyer@example.invalid',
                       report_token: 'old-token', order_key: 'k1',
                       restaurant_name: 'The Original', amount_paid: 49.99 }]);
  const out = await withDb(db, () => writeOrderRow(ARGS({
    targetRowId: 'the-order', restaurantName: 'The Swapped' })));
  assert.equal(out.ok, true, out.reason);
  assert.equal(db.inserts(), 0, 'IT INSERTED. That is the whole defect.');
  assert.equal(db.count(), 1, 'one sale left ' + db.count() + ' rows');
  const row = db.rows()[0];
  assert.equal(row.id, 'the-order', 'the wrong row survived');
  assert.equal(row.restaurant_name, 'The Swapped');
  assert.notEqual(row.report_token, 'old-token', 'the token was not replaced');
});

test('NO 409, BECAUSE NO SECOND ROW EVER HOLDS THE TOKEN', async () => {
  // The ledger enforces the unique guard. Under the old order this sequence
  // raised 23505 on every single swap.
  const db = ledger([{ id: 'the-order', email: 'buyer@example.invalid',
                       report_token: 'old-token', order_key: 'k1' }]);
  const out = await withDb(db, () => writeOrderRow(ARGS({ targetRowId: 'the-order' })));
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'patched');
});

test('the order identity and the amount are NOT restated by a patch', async () => {
  const db = ledger([{ id: 'the-order', email: 'buyer@example.invalid',
                       report_token: 'old', order_key: 'k1', amount_paid: 49.99,
                       subscribed_at: '2026-09-01T00:00:00Z' }]);
  await withDb(db, () => writeOrderRow(ARGS({ targetRowId: 'the-order', amountPaid: 99.99 })));
  const row = db.rows()[0];
  assert.equal(row.order_key, 'k1', 'the order key was overwritten');
  assert.equal(row.amount_paid, 49.99, 'a second sale was invented');
  assert.equal(row.subscribed_at, '2026-09-01T00:00:00Z', 'the sale date moved');
});

test('the patch is READ BACK, and the token must match', async () => {
  const db = ledger([{ id: 'the-order', email: 'buyer@example.invalid', report_token: 'old' }]);
  const out = await withDb(db, () => writeOrderRow(ARGS({ targetRowId: 'the-order' })));
  assert.equal(out.ok, true);
  const selects = db.calls.filter((c) => c.table === 'subscribers' && c.method === 'GET');
  assert.ok(selects.length >= 1, 'it never read the row back');
  assert.equal(out.subscriber.reportToken, db.rows()[0].report_token);
});

// ── Failure means no email ────────────────────────────────────────────────

test('A PATCH THAT CHANGES NOTHING IS A FAILURE, not a warning', async () => {
  const db = ledger([{ id: 'another-row', email: 'buyer@example.invalid' }]);
  const out = await withDb(db, () => writeOrderRow(ARGS({ targetRowId: 'not-there' })));
  assert.equal(out.ok, false);
  assert.match(String(out.reason), /rows|not-found|0/i);
  assert.equal(db.count(), 1, 'it fell back to inserting');
  assert.equal(db.inserts(), 0, 'IT INSERTED AFTER A FAILED PATCH');
});

test('a 409 on the patch is a failure and does not insert instead', async () => {
  const db = ledger([{ id: 'the-order', email: 'buyer@example.invalid' }], { failPatch: 409 });
  const out = await withDb(db, () => writeOrderRow(ARGS({ targetRowId: 'the-order' })));
  assert.equal(out.ok, false);
  assert.equal(db.inserts(), 0);
});

test('a failed INSERT is also a failure', async () => {
  const db = ledger([{ id: 'x', email: 'other@example.invalid', report_token: 'taken' }]);
  // Force the collision by handing the insert a token the ledger already holds.
  const out = await withDb(db, () => writeOrderRow(ARGS({ forceToken: 'taken' })));
  assert.equal(out.ok, false);
  assert.equal(db.count(), 1);
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the ledger ENFORCES the unique guard, or the 409 tests prove nothing', async () => {
  const db = ledger([{ id: 'a', report_token: 't1' }]);
  const res = await db.fake('https://db.invalid/rest/v1/subscribers', {
    method: 'POST', body: JSON.stringify({ report_token: 't1' }) });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('CONTROL: and it permits many NULL tokens, as a UNIQUE constraint does', async () => {
  const db = ledger([{ id: 'a', report_token: null }]);
  const res = await db.fake('https://db.invalid/rest/v1/subscribers', {
    method: 'POST', body: JSON.stringify({ report_token: null }) });
  assert.equal(res.ok, true, 'two placeholder rows cannot coexist, which is wrong');
});

test('CONTROL: the ledger refuses a filter it cannot evaluate', async () => {
  const db = ledger([{ id: 'a' }]);
  await assert.rejects(() => db.fake('https://db.invalid/rest/v1/subscribers?email=like.*x*',
    { method: 'DELETE' }), /cannot evaluate/);
});

test('CONTROL: writeOrderRow can succeed, so the failures mean something', async () => {
  const db = ledger();
  const out = await withDb(db, () => writeOrderRow(ARGS()));
  assert.equal(out.ok, true);
  assert.ok(out.subscriber && out.subscriber.reportToken);
});
