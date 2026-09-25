// ════════════════════════════════════════════════════════════════════════════
// FAIL LOUDLY, NEVER SILENTLY (2026-09-29, recommendation 7, Q26).
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

process.env.PORT = '39497';
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

test('THE DEFAULT MODEL TIMEOUT IS 180 SECONDS', () => {
  assert.equal(MODEL_TIMEOUT_MS_DEFAULT, 180000);
});

test('A 5xx IS RETRIED ONCE, and the second answer is used', async () => {
  await withFetch((n) => (n === 1 ? status(529, OVERLOADED) : ok(MODEL_OK)), async (calls) => {
    assert.deepEqual(await claude('p', { label: 't' }), { a: 1 });
    assert.equal(calls.filter((c) => c.url.includes('anthropic')).length, 2);
  });
});

test('A TIMEOUT IS RETRIED ONCE; every call carries an abort signal', async () => {
  await withFetch((n, url, init) => (n === 1 ? hang(url, init) : ok(MODEL_OK)), async (calls) => {
    assert.deepEqual(await claude('p', { label: 't' }), { a: 1 });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.init && c.init.signal), 'a model call went out with no abort signal');
  });
});

test('TWO TIMEOUTS FAIL, after exactly two calls, with the reason stated', async () => {
  await withFetch((n, url, init) => hang(url, init), async (calls) => {
    await assert.rejects(claude('p', { label: 't' }), /timed out after 60 ms/);
    assert.equal(calls.length, 2);
  });
});

test('A 4xx IS NOT RETRIED', async () => {
  await withFetch(() => status(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), async (calls) => {
    await assert.rejects(claude('p', { label: 't' }), /bad/);
    assert.equal(calls.length, 1);
  });
});
