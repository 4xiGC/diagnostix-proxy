// ════════════════════════════════════════════════════════════════════════════
// v8.11.18 [A2, A3]: inference ships switched off, and the secret gates
// recovery
//
// A2. SHADOW MODE. The matcher still computes "inferred". Nothing is ever
// delivered on it. The buyer goes down the recovery path exactly as if the
// answer had been "none", and the alert fires so the rule can be watched.
// Real delivery sits behind RVP_INFER_DELIVERY, default off.
//
// Measuring it: when a buyer later recovers, we log whether the row they
// recovered is the row inference WOULD have chosen. That is the only honest
// way to find out whether the rule is right, and it costs nothing, because
// the buyer has told us the answer by typing their survey address.
//
// A3. THE WEBHOOK IS STILL UNAUTHENTICATED. A recovery link is a bearer
// credential that fetches a report. A forged POST naming the attacker's own
// address must not earn one, so a link and a placeholder row are created ONLY
// when the call carried a valid secret.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShadowMode, recoveryAllowed, inferenceVerdict } from '../lib-pending.js';

const inferred = { decision: 'inferred', match: { id: 'r7' }, reason: 'single-candidate-in-window' };
const exact    = { decision: 'exact',    match: { id: 'r1' }, reason: 'exact-email-match' };
const none     = { decision: 'none',     match: null,        reason: 'no-candidate-in-window' };

// ── A2: shadow mode ─────────────────────────────────────────────────────────

test('with delivery OFF an inferred match does not deliver and becomes none', () => {
  const r = applyShadowMode({ result: inferred, deliverInferred: false });
  assert.equal(r.decision, 'none', 'shadow mode delivered on an inferred match');
  assert.equal(r.match, null, 'a row survived into the delivery path');
  assert.equal(r.logDecision, 'would-infer', 'the log must say would-infer, not none');
  assert.equal(r.wouldHaveInferredId, 'r7', 'the row inference would have chosen must be recorded');
  assert.equal(r.alert, true, 'shadow mode must still alert');
});

test('with delivery ON an inferred match is untouched', () => {
  const r = applyShadowMode({ result: inferred, deliverInferred: true });
  assert.equal(r.decision, 'inferred');
  assert.equal(r.match.id, 'r7');
  assert.equal(r.logDecision, 'inferred');
  assert.equal(r.alert, true);
});

test('exact and none are untouched by shadow mode, either way', () => {
  for (const flag of [true, false]) {
    const e = applyShadowMode({ result: exact, deliverInferred: flag });
    assert.equal(e.decision, 'exact');
    assert.equal(e.match.id, 'r1');
    assert.equal(e.alert, false, 'an exact match must not raise the inferred alert');
    assert.equal(e.wouldHaveInferredId, null);

    const n = applyShadowMode({ result: none, deliverInferred: flag });
    assert.equal(n.decision, 'none');
    assert.equal(n.alert, false);
    assert.equal(n.wouldHaveInferredId, null);
  }
});

test('the default is OFF, so a missing or malformed flag never delivers', () => {
  for (const v of [undefined, null, '', 'no', 'false', '0', 'off', 'TRUE ', 0, {}]) {
    const r = applyShadowMode({ result: inferred, deliverInferred: v });
    assert.equal(r.decision, 'none', 'delivery happened on flag value ' + JSON.stringify(v));
  }
  // Only the exact string 'true' turns it on.
  assert.equal(applyShadowMode({ result: inferred, deliverInferred: 'true' }).decision, 'inferred');
  assert.equal(applyShadowMode({ result: inferred, deliverInferred: true }).decision, 'inferred');
});

// ── A2: the measurement ─────────────────────────────────────────────────────

test('inferenceVerdict reports right, wrong or no-inference', () => {
  assert.equal(inferenceVerdict({ wouldHaveInferredId: 'r7', recoveredId: 'r7' }), 'right');
  assert.equal(inferenceVerdict({ wouldHaveInferredId: 'r7', recoveredId: 'r9' }), 'wrong');
  assert.equal(inferenceVerdict({ wouldHaveInferredId: null, recoveredId: 'r9' }), 'no-inference');
  assert.equal(inferenceVerdict({ wouldHaveInferredId: undefined, recoveredId: 'r9' }), 'no-inference');
  assert.equal(inferenceVerdict({ wouldHaveInferredId: '', recoveredId: 'r9' }), 'no-inference');
});

test('inferenceVerdict never throws and never guesses', () => {
  for (const a of [undefined, null, {}, 42, 'x']) {
    let v;
    assert.doesNotThrow(() => { v = inferenceVerdict(a || {}); });
    assert.ok(['right', 'wrong', 'no-inference'].includes(v), 'produced ' + v);
  }
  // A recovered id we do not know is not "right".
  assert.equal(inferenceVerdict({ wouldHaveInferredId: 'r7', recoveredId: null }), 'wrong');
});

// ── A3: the secret gate ─────────────────────────────────────────────────────

test('recovery is offered ONLY on a call that carried a valid secret', () => {
  assert.equal(recoveryAllowed('valid'), true);
  for (const st of ['absent', 'invalid', 'not-configured', undefined, null, '', 'VALID', 'valid ']) {
    assert.equal(recoveryAllowed(st), false,
      'a link would be issued on secret status ' + JSON.stringify(st));
  }
});
