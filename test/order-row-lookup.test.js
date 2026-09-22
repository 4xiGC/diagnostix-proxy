// ════════════════════════════════════════════════════════════════════════════
// THE ORDER ROW IS FOUND BY THE ORDER, NOT BY BEING THE NEWEST THING UNDER
// AN ADDRESS.
//
// findOrderRow selected email=eq.<paying address>&order=subscribed_at.desc
// &limit=1. That is the lookup behind the 2026-09-20 double delivery: a buyer
// with two rows got whichever one was newest, which is not necessarily the
// order the link was minted for.
//
// subscribers.order_key exists as of migration 004 and orderKeyForDelivery
// derives the value (commit fb0ff55). This wires it: deliverPaidReport binds
// the key at mint time and findOrderRow prefers it.
//
// THESE TESTS CALL THE REAL FUNCTIONS. server.js is imported with
// RVP_IMPORT_ONLY=1 and global fetch is replaced, so what is asserted is the
// request the shipped code actually sends, not a restatement of it.
//
// WHAT IS DELIBERATELY NOT TESTED HERE: that 100 existing rows still resolve.
// They carry no key, so they take the address path, and the address path is
// unchanged. That is a property of the fallback existing, which IS tested.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { swapOrderKey, orderKeyForDelivery, signRecoveryToken } from '../lib-pending.js';

process.env.PORT = '39221';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const { createCustomer, findOrderRow, setFetch } = __test__;

// ── A recorder standing in for PostgREST ──────────────────────────────────
//
// It records every request and answers with whatever the test queued. It is
// NOT a database: no unique index, no filter evaluation, no RLS. It can only
// say what was asked, which is exactly what these tests are about.
function recorder(answers) {
  const calls = [];
  const queue = Array.isArray(answers) ? answers.slice() : [];
  const fake = async (url, opts) => {
    const o = opts || {};
    calls.push({
      url: String(url),
      method: o.method || 'GET',
      body: o.body ? JSON.parse(o.body) : null,
    });
    const next = queue.length ? queue.shift() : [];
    return {
      ok: true, status: 200,
      json: async () => next,
      text: async () => JSON.stringify(next),
      headers: { get: () => null },
    };
  };
  return { fake, calls, selects: () => calls.filter((c) => c.method === 'GET') };
}

// server.js imports node-fetch, and an ESM import binding cannot be replaced
// from outside the module. Setting globalThis.fetch changed nothing and the
// first run of this file went out to the real network: "getaddrinfo ENOTFOUND
// db.invalid". The seam rebinds it from the inside and hands back a restore.
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
const SWAP_URL = 'https://rvp.example.invalid/recover?t=' + encodeURIComponent(TOKEN);

// ── The key is bound when the row is minted ───────────────────────────────

test('createCustomer WRITES order_key when it is given one', async () => {
  const r = recorder();
  await withFetch(r.fake, () => createCustomer({
    email: PAYING, firstName: 'A', restaurantName: 'R', location: '', website: '',
    report: { healthCheckScore: 50 }, survey: {}, planType: 'one-time',
    amountPaid: 49.99, orderKey: KEY,
  }));
  const insert = r.calls.find((c) => c.method === 'POST');
  assert.ok(insert, 'createCustomer sent no insert');
  assert.equal(insert.body.order_key, KEY,
    'the subscriber row was minted without the order it belongs to');
});

test('createCustomer writes NULL, not an invented value, when there is no key', async () => {
  const r = recorder();
  await withFetch(r.fake, () => createCustomer({
    email: PAYING, firstName: 'A', restaurantName: 'R', location: '', website: '',
    report: { healthCheckScore: 50 }, survey: {}, planType: 'one-time', amountPaid: 49.99,
  }));
  const insert = r.calls.find((c) => c.method === 'POST');
  assert.ok('order_key' in insert.body, 'the column is not written at all');
  assert.equal(insert.body.order_key, null);
});

test('the key createCustomer stores is the one rvp_swap_uses will store', async () => {
  // If these ever diverge the two tables describe the same order under two
  // names and nothing joins them.
  const r = recorder();
  await withFetch(r.fake, () => createCustomer({
    email: PAYING, firstName: '', restaurantName: '', location: '', website: '',
    report: null, survey: {}, planType: 'one-time', amountPaid: 49.99,
    orderKey: orderKeyForDelivery({ swapUrl: SWAP_URL, payingEmail: PAYING }),
  }));
  const insert = r.calls.find((c) => c.method === 'POST');
  assert.equal(insert.body.order_key, swapOrderKey({ payingEmail: PAYING, token: TOKEN }));
});

// ── The lookup prefers it ─────────────────────────────────────────────────

test('findOrderRow QUERIES BY order_key when it has one', async () => {
  const r = recorder([[{ id: 'row-by-key', email: PAYING }]]);
  const row = await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: KEY }));
  assert.equal(row && row.id, 'row-by-key');
  const first = r.selects()[0];
  assert.ok(first, 'findOrderRow made no request');
  assert.match(first.url, /order_key=eq\./, 'the first lookup was not by order key');
  assert.ok(first.url.includes(encodeURIComponent(KEY)), 'it queried some other key');
});

test('a hit by key does NOT then query by address', async () => {
  const r = recorder([[{ id: 'row-by-key' }]]);
  await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: KEY }));
  assert.equal(r.selects().length, 1, 'it looked the row up twice');
  assert.doesNotMatch(r.selects()[0].url, /email=eq\./);
});

test('NO KEY MEANS THE ADDRESS PATH, unchanged', async () => {
  // The 100 rows that already exist carry no key. This is the only thing that
  // can find them, and it must still be exactly what it was.
  const r = recorder([[{ id: 'row-by-address' }]]);
  const row = await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING }));
  assert.equal(row && row.id, 'row-by-address');
  assert.equal(r.selects().length, 1);
  assert.match(r.selects()[0].url, /email=eq\./);
  assert.match(r.selects()[0].url, /order=subscribed_at\.desc&limit=1/);
  assert.doesNotMatch(r.selects()[0].url, /order_key/);
});

test('A KEY THAT FINDS NOTHING FALLS BACK TO THE ADDRESS', async () => {
  // An order minted before this release, reached by a link minted after it,
  // must still deliver. Falling through is the whole reason the address path
  // is kept.
  const r = recorder([[], [{ id: 'row-by-address' }]]);
  const row = await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: KEY }));
  assert.equal(row && row.id, 'row-by-address', 'a key miss lost the order');
  assert.equal(r.selects().length, 2);
  assert.match(r.selects()[0].url, /order_key=eq\./);
  assert.match(r.selects()[1].url, /email=eq\./);
});

test('NULL IS NOT A LOOKUP', async () => {
  // order_key=is.null would match every one of the 100 existing rows, which is
  // worse than the defect. An underivable key must go straight to the address.
  for (const bad of [null, undefined, '', '   ']) {
    const r = recorder([[{ id: 'row-by-address' }]]);
    await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: bad }));
    for (const c of r.selects()) {
      assert.doesNotMatch(c.url, /order_key/,
        'an empty key of ' + JSON.stringify(bad) + ' was sent as a filter');
    }
  }
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the rebind takes, and is undone afterwards', async () => {
  // Without this, every assertion below could be passing because the real
  // node-fetch failed and the code swallowed the error, which is what the
  // first run of this file actually did.
  const r = recorder([[{ id: 'seen' }]]);
  const row = await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING }));
  assert.equal(row && row.id, 'seen', 'the recorder did not answer, the real fetch did');
  // And it is put back: a call outside withFetch must NOT reach the recorder.
  const before = r.calls.length;
  await findOrderRow({ payingEmail: PAYING }).catch(() => {});
  assert.equal(r.calls.length, before, 'the recorder is still installed after the test');
});

test('CONTROL: the recorder sees the requests, so silence would mean something', async () => {
  const r = recorder([[{ id: 'x' }]]);
  await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING }));
  assert.ok(r.calls.length >= 1, 'the recorder saw nothing at all');
  assert.match(r.calls[0].url, /rest\/v1\/subscribers/);
});

test('CONTROL: the url assertions can fail', async () => {
  const r = recorder([[{ id: 'x' }]]);
  await withFetch(r.fake, () => findOrderRow({ payingEmail: PAYING }));
  assert.doesNotMatch(r.selects()[0].url, /order_key=eq\./,
    'the address path is somehow sending an order_key filter');
});

test('CONTROL: two different orders produce two different filters', async () => {
  const other = swapOrderKey({ payingEmail: PAYING, token: TOKEN + 'x' });
  assert.notEqual(other, KEY);
  const a = recorder([[{ id: '1' }]]);
  const b = recorder([[{ id: '1' }]]);
  await withFetch(a.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: KEY }));
  await withFetch(b.fake, () => findOrderRow({ payingEmail: PAYING, orderKey: other }));
  assert.notEqual(a.selects()[0].url, b.selects()[0].url);
});
