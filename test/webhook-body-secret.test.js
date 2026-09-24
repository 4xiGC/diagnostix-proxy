// ════════════════════════════════════════════════════════════════════════════
// THE WEBHOOK SECRET ARRIVES IN THE BODY, WITH A SECOND SECRET FOR A SWITCH.
//
// 2026-09-24: the secret was the last path segment of /payment-webhook/<secret>,
// and Railway's HTTP request log records every path, so the secret sat in the
// platform log for anyone with log access. Wix's "Send an HTTP request" action
// has no custom headers and no signing (read from Wix's help page that day),
// so the secret moves into the body, which is not logged. Simon's decision:
// the body field, a two-secret window, then one rotation.
//
// THE RULE:
//   - the body field webhookSecret is read FIRST, the URL path SECOND;
//   - it matches RVP_WEBHOOK_SECRET ("current") or RVP_WEBHOOK_SECRET_NEXT
//     ("next"), each by timingSafeEqual;
//   - the log line names which path presented it and which secret matched,
//     never the value; every webhook outcome row carries the same in its reason;
//   - the field is removed from the body before anything logs or stores it.
//
// Driven through the REAL route on an ephemeral port, with the contract
// fixture's example as the Wix body. Supabase is a counting ledger; no network.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.PORT = '39385';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const CURRENT = 'current-secret-for-this-test-only';
const NEXT = 'next-secret-for-this-test-only';
const CONTRACT = JSON.parse(readFileSync(new URL('../contract/wix-payment-webhook-body.contract.json', import.meta.url), 'utf8'));

const { __test__ } = await import('../server.js');
const { app, setFetch } = __test__;

async function post({ path = '/payment-webhook/', body, current = CURRENT, next = null }) {
  process.env.RVP_WEBHOOK_SECRET = current;
  if (next) process.env.RVP_WEBHOOK_SECRET_NEXT = next; else delete process.env.RVP_WEBHOOK_SECRET_NEXT;
  const outcomes = [];
  const fake = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/rvp_outcomes') && String(init.method || 'GET').toUpperCase() === 'POST') outcomes.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [], text: async () => '[]' };
  };
  const logs = [];
  const log = console.log, err = console.error, warn = console.warn;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  const restore = setFetch(fake);
  const realGlobal = globalThis.fetch;
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const res = await realGlobal('http://127.0.0.1:' + server.address().port + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // The response goes out before the slow work; wait for the outcome row.
    for (let i = 0; i < 100 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 20));
    return { status: res.status, outcomes, logs };
  } finally {
    server.close(); restore(); console.log = log; console.error = err; console.warn = warn;
    delete process.env.RVP_WEBHOOK_SECRET_NEXT;
  }
}

const wixBody = (secret) => ({ ...CONTRACT.example, webhookSecret: secret });

test('THE CONTRACT: Wix posts to the bare URL with the secret in the body; accepted as the CURRENT secret, presented by the BODY', async () => {
  assert.deepEqual(Object.keys(CONTRACT.required).sort(), ['email', 'webhookSecret']);
  const r = await post({ body: wixBody(CURRENT) });
  assert.equal(r.status, 200);
  assert.ok(r.logs.some((l) => /WEBHOOK_SECRET \[webhook\] status=valid presentedBy=body matched=current/.test(l)), r.logs.join('\n'));
  assert.ok(r.outcomes.length >= 1, 'no outcome row');
  for (const o of r.outcomes) assert.match(o.reason, /presentedBy=body secret=current/);
});

test('THE SWITCH: the NEXT secret is accepted while RVP_WEBHOOK_SECRET_NEXT is set', async () => {
  const r = await post({ body: wixBody(NEXT), next: NEXT });
  assert.equal(r.status, 200);
  assert.ok(r.logs.some((l) => /status=valid presentedBy=body matched=next/.test(l)));
  for (const o of r.outcomes) assert.match(o.reason, /presentedBy=body secret=next/);
});

test('TODAY\'S WIX STILL WORKS: the secret in the URL path, no body field', async () => {
  const body = { ...CONTRACT.example }; delete body.webhookSecret;
  const r = await post({ path: '/payment-webhook/' + CURRENT, body });
  assert.equal(r.status, 200);
  assert.ok(r.logs.some((l) => /status=valid presentedBy=url matched=current/.test(l)));
  for (const o of r.outcomes) assert.match(o.reason, /presentedBy=url secret=current/);
});

test('THE BODY IS READ FIRST: a wrong body secret is refused even with a right URL secret', async () => {
  const r = await post({ path: '/payment-webhook/' + CURRENT, body: wixBody('wrong-secret') });
  assert.equal(r.status, 401);
  assert.ok(r.logs.some((l) => /status=invalid presentedBy=body/.test(l)));
  assert.match(r.outcomes[0].reason, /rejected-secret-invalid/);
  assert.match(r.outcomes[0].reason, /presentedBy=body/);
});

test('CONTROL: the NEXT value is refused when RVP_WEBHOOK_SECRET_NEXT is not set, and no secret at all is refused', async () => {
  assert.equal((await post({ body: wixBody(NEXT) })).status, 401);
  const none = { ...CONTRACT.example }; delete none.webhookSecret;
  const r = await post({ body: none });
  assert.equal(r.status, 401);
  assert.ok(r.logs.some((l) => /status=absent presentedBy=none/.test(l)));
});

test('THE VALUE IS NEVER LOGGED OR STORED, AND THE FIELD LEAVES THE BODY BEFORE THE SHAPE LINE', async () => {
  for (const [secret, next] of [[CURRENT, null], [NEXT, NEXT], ['wrong-secret', null]]) {
    const r = await post({ body: wixBody(secret), next });
    const all = r.logs.join('\n') + JSON.stringify(r.outcomes);
    assert.ok(!all.includes(secret), 'the secret value reached a log or a row');
    const shape = r.logs.find((l) => /WEBHOOK_SHAPE/.test(l));
    // A valid call must reach the shape line, or this check passes over nothing.
    if (secret !== 'wrong-secret') assert.ok(shape, 'no WEBHOOK_SHAPE line for a valid call');
    if (shape) assert.doesNotMatch(shape, /webhookSecret/);
  }
});
