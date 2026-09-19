// ════════════════════════════════════════════════════════════════════════════
// v8.11.22 [C2]: the webhook secret is enforced
//
// WHY ENFORCEMENT IS SAFE NOW AND WAS NOT BEFORE. v8.11.10 read the secret
// and rejected nothing, on purpose: the Wix automation posted to the bare URL,
// so requiring a secret would have broken every genuine call the moment it
// deployed. Two production orders have since been observed carrying
// status=valid (2026-09-19 18:09Z and 20:29Z), so the automation is known to
// send it and the door can be closed.
//
// WHAT CHANGES IN THE RESPONSE ORDER. The 200 used to be the first statement
// of the handler. It now comes after the secret check, which is a
// timingSafeEqual over two buffers with no I/O in it. A valid call still gets
// its 200 before HubSpot, Supabase, the peer comparison or any email. A
// rejected call gets a 401 so the Wix Run Log shows the failure instead of
// recording a success that never happened.
//
// THROTTLE. A rejection repeats on every order until a human fixes the URL,
// so the alert is capped at one per ten minutes. An uncapped alert on an
// unauthenticated endpoint is an amplification vector: anyone could POST in a
// loop and turn the alert mailbox into the outage.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { webhookEnforcement, alertThrottle, ALERT_THROTTLE_MS } from '../lib-pending.js';

// ── C2: who is rejected ─────────────────────────────────────────────────────

test('a valid secret is accepted and answers 200', () => {
  const e = webhookEnforcement('valid');
  assert.equal(e.reject, false);
  assert.equal(e.httpStatus, 200);
  assert.equal(e.enforcing, true);
});

test('an absent secret is rejected with 401 when one is configured', () => {
  const e = webhookEnforcement('absent');
  assert.equal(e.reject, true);
  assert.equal(e.httpStatus, 401);
});

test('an invalid secret is rejected with 401', () => {
  const e = webhookEnforcement('invalid');
  assert.equal(e.reject, true);
  assert.equal(e.httpStatus, 401);
});

test('401 not 403, so the Wix Run Log shows an auth failure', () => {
  assert.equal(webhookEnforcement('absent').httpStatus, 401);
  assert.equal(webhookEnforcement('invalid').httpStatus, 401);
});

test('RVP_WEBHOOK_SECRET unset: nothing is enforced and nothing is rejected', () => {
  // The escape hatch. If the variable is ever cleared, the service returns to
  // v8.11.10 behaviour rather than rejecting every sale.
  const e = webhookEnforcement('not-configured');
  assert.equal(e.reject, false);
  assert.equal(e.httpStatus, 200);
  assert.equal(e.enforcing, false);
});

test('an unknown status is rejected rather than waved through', () => {
  // Fail closed on a value nobody planned for. The only statuses that pass are
  // the two named above.
  for (const s of ['', null, undefined, 'maybe', 'VALID', 'Valid', 0, {}]) {
    const e = webhookEnforcement(s);
    assert.equal(e.reject, true, 'status ' + JSON.stringify(s) + ' must be rejected');
  }
});

test('enforcement never depends on the body', () => {
  // The signature takes one argument on purpose. A rule that could read the
  // body could be talked into trusting it.
  assert.equal(webhookEnforcement.length, 1);
});

// ── the throttle, applied to both ───────────────────────────────────────────

test('a burst of rejections produces exactly one alert', () => {
  let lastSentAt = 0;
  let sent = 0;
  const start = 1_000_000;
  for (let i = 0; i < 200; i++) {
    const now = start + i * 1000;                 // 200 calls over 200 seconds
    const r = alertThrottle({ lastSentAt, now });
    if (r.send) { sent++; lastSentAt = now; }
  }
  assert.equal(sent, 1, 'a flood must not become a flood of email');
});

test('a fault lasting an hour still reports about six times', () => {
  // The other side of the comparison: the throttle must not be so tight that a
  // real outage goes quiet after one message.
  let lastSentAt = 0;
  let sent = 0;
  const start = 1_000_000;
  for (let i = 0; i < 3600; i++) {
    const now = start + i * 1000;
    const r = alertThrottle({ lastSentAt, now });
    if (r.send) { sent++; lastSentAt = now; }
  }
  assert.equal(sent, Math.ceil(3600_000 / ALERT_THROTTLE_MS));
});
