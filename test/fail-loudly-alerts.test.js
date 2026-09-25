// ════════════════════════════════════════════════════════════════════════════
// FAIL LOUDLY: THE TWO ALERTS (2026-09-29, recommendation 7, Q26).
//
// C4 (2026-09-28) read RVP's model call and email wrapper from main:
//   claude()   no timeout: a hung Anthropic call held the buyer on the thinking
//              screen until the platform gave up; a 5xx was not retried
//   /diagnose  a failure returned 500 with no row and no alert
//   Resend     retried once, then the final failure was logged and nobody told
// Now: a 180 s timeout on every model call, ONE retry on a 5xx or a timeout
// (never on a 4xx, which will fail the same way twice), an internal ALERT when
// an assessment fails, and an internal ALERT when a customer email still fails
// after its retry. Everything against mocks: no network, no spend.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39498';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.RVP_IDENTITY_SECRET = 'test-identity-secret';
process.env.RVP_MODEL_TIMEOUT_MS = '60';
process.env.RVP_MODEL_RETRY_DELAY_MS = '5';

const { __test__ } = await import('../server.js');
const { app, setFetch, setClaude, getClaude, sendEmailViaResend, MODEL_TIMEOUT_MS_DEFAULT } = __test__;
const claude = getClaude();

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
const status = (code, body) => ({ ok: false, status: code, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
const MODEL_OK = { content: [{ type: 'text', text: '{"a":1}' }], stop_reason: 'end_turn', usage: { output_tokens: 3 } };
const OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
// A fetch that never answers, but honours its abort signal, as a hung socket would.
const hang = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); });
});

function withFetch(fn, body) {
  const calls = [];
  const restore = setFetch(async (url, init) => { calls.push({ url: String(url), init }); return fn(calls.length, url, init); });
  return body(calls).finally(restore);
}

test('A FAILED ASSESSMENT SENDS ONE INTERNAL ALERT, naming the restaurant and the error', async () => {
  const emails = [];
  const fake = async (url, init) => {
    if (String(url).includes('api.resend.com')) { emails.push(JSON.parse(init.body)); return ok({ id: 'e' + emails.length }); }
    return ok({});
  };
  const restoreFetch = setFetch(fake); const realGlobal = globalThis.fetch; globalThis.fetch = fake;
  const restoreClaude = setClaude(async () => { throw new Error('Anthropic overloaded twice'); });
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const res = await realGlobal('http://127.0.0.1:' + server.address().port + '/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Casa Teclados', location: 'Santiago, Chile', placeId: 'ChIJ-x' }) });
    assert.equal(res.status, 500);
    await new Promise((r) => setTimeout(r, 50));
  } finally { server.close(); globalThis.fetch = realGlobal; restoreClaude(); restoreFetch(); }
  const alerts = emails.filter((e) => /ALERT: an assessment failed/.test(e.subject));
  assert.equal(alerts.length, 1, 'alerts: ' + JSON.stringify(emails.map((e) => e.subject)));
  assert.deepEqual(alerts[0].to, ['hello@4xiconsulting.com']);
  assert.match(alerts[0].subject, /Casa Teclados/);
  assert.match(alerts[0].html, /Anthropic overloaded twice/);
  assert.match(alerts[0].html, /Analytics peer run/, 'the alert does not say which caller failed');
});

test('A CUSTOMER EMAIL THAT STILL FAILS AFTER ITS RETRY SENDS ONE INTERNAL ALERT', async () => {
  const sent = [];
  await withFetch((n, url, init) => {
    const b = JSON.parse(init.body); sent.push(b);
    return b.to[0] === 'hello@4xiconsulting.com' ? ok({ id: 'alert' }) : status(503, { message: 'unavailable' });
  }, async () => {
    const r = await sendEmailViaResend({ to: 'owner@example.org', subject: 'Your DiagnostiX Full Report is ready: X', html: '<p>x</p>' });
    assert.equal(r.ok, false);
  });
  const toCustomer = sent.filter((b) => b.to[0] === 'owner@example.org');
  const alerts = sent.filter((b) => b.to[0] === 'hello@4xiconsulting.com');
  assert.equal(toCustomer.length, 2, 'the customer send was not retried once');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /ALERT: a customer email failed/);
  assert.match(alerts[0].html, /Your DiagnostiX Full Report is ready: X/);
  assert.doesNotMatch(alerts[0].html + alerts[0].subject, /owner@example\.org/, 'the alert carries the customer address');
});

test('CONTROLS: a delivered email sends no alert, and a failed ALERT never alerts about itself', async () => {
  const sent = [];
  await withFetch((n, url, init) => { sent.push(JSON.parse(init.body)); return ok({ id: 'x' }); }, async () => {
    await sendEmailViaResend({ to: 'owner@example.org', subject: 'S', html: 'x' });
  });
  assert.equal(sent.length, 1);
  const sent2 = [];
  await withFetch((n, url, init) => { sent2.push(JSON.parse(init.body)); return status(503, { message: 'down' }); }, async () => {
    await sendEmailViaResend({ to: 'hello@4xiconsulting.com', subject: 'ALERT: x', html: 'x' });
  });
  assert.equal(sent2.length, 2, 'an internal send was retried once and then left alone');
});
