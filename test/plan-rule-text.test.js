// ════════════════════════════════════════════════════════════════════════════
// THE PLAN RULE'S TEXT (2026-10-01, B1 prompt v2).
//
// The v1 rule's trial (three stored paid reports, overnight _1001_rvp.md) put all
// four fields on 18 of 18 items, and 14 of the 18 indicators set a target number
// the findings do not contain ("below 10% of new reviews", "4.7 stars"). Several
// also gave the indicator a time window other than the item's horizon. v2 says
// what to count, allows a number only when it appears in the findings or the
// business metrics, and reads the indicator at the end of the horizon.
// These pins are about the text; whether the model obeys it is the trial's job.
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_RULE, PLAN_PROMPT_VERSION } from '../lib-plan-prompt.js';

test('v2: a target number only when the findings or the business metrics contain it', () => {
  assert.match(PLAN_RULE, /target number ONLY when that number appears in the findings or the business metrics/);
});
test('v2: the indicator is read at the end of the horizon, not on its own clock', () => {
  assert.match(PLAN_RULE, /checked at the end of the horizon/);
});
// 2026-09-26: v3 (Simon Q2, Q40) kept every v2 sentence above and added two, so the id moved to v3;
// test/plan-rule-v3.test.js pins the new sentences.
test('the version id changes with the text (v3 since 2026-09-26)', () => {
  assert.match(PLAN_PROMPT_VERSION, /^plan-2026-10-01-v3-[0-9a-f]{12}$/);
});
