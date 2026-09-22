// ════════════════════════════════════════════════════════════════════════════
// EVERY EXIT FROM THE PAYMENT WEBHOOK WRITES AN OUTCOME ROW.
//
// `rvp_outcomes` exists to make sales queryable. The webhook answered 200 at
// the top and then RETURNED FROM FIVE PLACES WITHOUT WRITING A ROW, so the
// table was missing exactly the sales that went wrong.
//
// MEASURED ON THE LIVE TABLE, 2026-09-22: two purchases that day, both
// unmatched at purchase, and ZERO rows with kind=webhook. The only trace was a
// placeholder subscriber row and an alert email.
//
// The five exits, by what they are:
//
//   rejected secret      an unauthenticated POST, the only signal that
//                        somebody is probing the endpoint
//   empty body           a caller with a valid secret sending nothing
//   no email in body     a payment that cannot be attributed to anybody
//   unmatched at purchase   A REAL SALE. The important one.
//   no report data       a paid order that produced nothing
//
// HOW THIS IS DRIVEN. handlePaymentWebhook is on the __test__ seam and is
// called with a fake req and res and a counting ledger in place of PostgREST.
// The count asserted is INSERTS INTO rvp_outcomes, per exit path.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39341';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.RVP_WEBHOOK_SECRET = 'a-test-webhook-secret';

const { __test__ } = await import('../server.js');
const { handlePaymentWebhook, setFetch } = __test__;

// Counts inserts per table and answers every select with nothing, so the
// matcher finds no candidate and the handler takes the unmatched path unless
// a test says otherwise.
function ledger(selectAnswers) {
  const calls = [];
  const answers = selectAnswers || {};
  const fake = async (url, init) => {
    const i = init || {};
    const method = String(i.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    const table = (u.pathname.match(/\/rest\/v1\/([A-Za-z0-9_]+)/) || [])[1] || '(none)';
    calls.push({ table, method, body: i.body ? JSON.parse(i.body) : null });
    const rows = method === 'GET' ? (answers[table] || []) : [];
    return { ok: true, status: method === 'POST' ? 201 : 200,
             json: async () => rows, text: async () => JSON.stringify(rows) };
  };
  return {
    fake, calls,
    outcomes: () => calls.filter((c) => c.table === 'rvp_outcomes' && c.method === 'POST'),
    reasons: () => calls.filter((c) => c.table === 'rvp_outcomes' && c.method === 'POST')
      .map((c) => String((c.body && c.body.reason) || '')),
    subscriberInserts: () => calls.filter((c) => c.table === 'subscribers' && c.method === 'POST').length,
  };
}

function fakeRes() {
  const sent = { status: null, body: null };
  const res = {
    status(c) { sent.status = c; return res; },
    json(b) { sent.body = b; return res; },
    send(b) { sent.body = b; return res; },
    setHeader() { return res; },
  };
  return { res, sent };
}

async function run(db, req) {
  const restore = setFetch(db.fake);
  const { res } = fakeRes();
  try { await handlePaymentWebhook(req, res); } finally { restore(); }
}

const GOOD = { secret: 'a-test-webhook-secret' };

// ── One row per exit ──────────────────────────────────────────────────────

test('A REJECTED SECRET WRITES A ROW', async () => {
  const db = ledger();
  await run(db, { params: { secret: 'wrong' }, body: { email: 'a@b.invalid' } });
  assert.equal(db.outcomes().length, 1, 'wrote ' + db.outcomes().length + ' rows');
  assert.match(db.reasons()[0], /rejected-secret/);
});

test('and it records the LENGTH of what was presented, never the value', async () => {
  const db = ledger();
  await run(db, { params: { secret: 'wrong-secret-value' }, body: {} });
  const r = db.reasons()[0];
  assert.match(r, /len=18/);
  assert.doesNotMatch(r, /wrong-secret-value/, 'the presented secret is in the row');
});

test('AN EMPTY BODY WRITES A ROW', async () => {
  const db = ledger();
  await run(db, { params: GOOD, body: null });
  assert.equal(db.outcomes().length, 1);
  assert.match(db.reasons()[0], /empty-body/);
});

test('A BODY WITH NO EMAIL WRITES A ROW', async () => {
  const db = ledger();
  await run(db, { params: GOOD, body: { product: 'full' } });
  assert.equal(db.outcomes().length, 1);
  assert.match(db.reasons()[0], /no-email-in-body/);
});

test('A SALE THAT MATCHED NOTHING WRITES A ROW, and this is the important one', async () => {
  // Every select answers empty, so the matcher finds no candidate.
  const db = ledger();
  await run(db, { params: GOOD, body: { email: 'buyer@example.invalid', product: 'full' } });
  assert.equal(db.outcomes().length, 1, 'wrote ' + db.outcomes().length + ' rows');
  assert.match(db.reasons()[0], /unmatched-at-purchase/);
});

test('and the placeholder subscriber row is STILL written, unchanged', async () => {
  // The row is what the recovery link later fills in. Adding an outcome row
  // must not have replaced it.
  const db = ledger();
  await run(db, { params: GOOD, body: { email: 'buyer@example.invalid', product: 'full' } });
  assert.equal(db.subscriberInserts(), 1, 'the placeholder row stopped being written');
});

test('the row carries a domain and a local-part length, never an address', async () => {
  const db = ledger();
  await run(db, { params: GOOD, body: { email: 'buyer@example.invalid', product: 'full' } });
  const body = db.outcomes()[0].body;
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /buyer@example\.invalid/, 'the address is in the row');
  assert.ok('addr_domain' in body);
  assert.ok('addr_local_len' in body);
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the ledger counts an outcome insert at all', async () => {
  const db = ledger();
  await db.fake('https://db.invalid/rest/v1/rvp_outcomes', {
    method: 'POST', body: JSON.stringify({ reason: 'x' }) });
  assert.equal(db.outcomes().length, 1);
});

test('CONTROL: it counts ZERO when nothing is written', () => {
  assert.equal(ledger().outcomes().length, 0);
});

test('CONTROL: the five exits give five DIFFERENT reasons', async () => {
  // If they all wrote the same string the rows would be indistinguishable and
  // the table no more useful than a counter.
  const seen = [];
  for (const [req] of [
    [{ params: { secret: 'wrong' }, body: {} }],
    [{ params: GOOD, body: null }],
    [{ params: GOOD, body: { product: 'full' } }],
    [{ params: GOOD, body: { email: 'a@b.invalid', product: 'full' } }],
  ]) {
    const db = ledger();
    await run(db, req);
    seen.push(db.reasons()[0] || '(none)');
  }
  assert.equal(new Set(seen).size, seen.length, 'two exits share a reason: ' + JSON.stringify(seen));
});

test('CONTROL: an exit that already wrote a row does not now write two', async () => {
  const db = ledger();
  await run(db, { params: GOOD, body: { email: 'buyer@example.invalid', product: 'full' } });
  assert.equal(db.outcomes().length, 1, 'the unmatched path double-writes');
});
