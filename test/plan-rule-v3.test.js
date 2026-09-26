// ════════════════════════════════════════════════════════════════════════════
// PLAN_RULE v3 (2026-09-26, Simon Q2 and Q40). Still behind RVP_PLAN_PROMPT, off.
//
// The v2 trial left two things the rule did not forbid:
//   - 2 of 18 findings were conjecture ("may limit appeal", "may be capturing
//     discretionary spend"), not findings;
//   - descriptions carried numbers the findings do not contain ("within 15-mile
//     radius", "8-20 seats", "within 600 meters"), copied from the original
//     run's own action prose.
// v3 adds one sentence for each, and its version id says v3.
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_RULE, PLAN_PROMPT_VERSION, planPromptEnabled } from '../lib-plan-prompt.js';

test('v3: a finding states what the data shows, never a possibility', () => {
  assert.match(PLAN_RULE, /A finding states what the data shows, never a possibility: no "may", "might" or "could"\./);
});

test('v3: a number in the description only from the findings or the business metrics', () => {
  assert.match(PLAN_RULE, /desc: use a number only when it appears in the findings or the business metrics above; describe the action without one otherwise\./);
});

test('v3: the version id is v3 and hashes the rule; the flag still defaults off', () => {
  assert.match(PLAN_PROMPT_VERSION, /^plan-2026-10-01-v3-[0-9a-f]{12}$/);
  assert.equal(planPromptEnabled({}), false);
  assert.equal(planPromptEnabled({ RVP_PLAN_PROMPT: '1' }), true);
});
