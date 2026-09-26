// ════════════════════════════════════════════════════════════════════════════
// THE PLAN RULE (2026-10-01, recommendation 9, B1). PROMPT CHANGE, OFF BY DEFAULT.
//
// Appended to diagnose-p2 ONLY when RVP_PLAN_PROMPT is "1" (planPromptEnabled).
// With the flag unset, p2 is byte for byte the prompt it was, so a push changes
// nothing in delivery until Simon approves. When on, p2 also returns `plan`, the
// one ranked list with owner, horizon, indicator and finding per item, which
// lib-action-plan.js renders as written. `actions` and `commercialActions` are
// still returned, so every other reader is unchanged.
//
// PLAN_PROMPT_VERSION is the sha256 of PLAN_RULE (first 12 hex), recorded in
// the run's provenance beside the p2 id when the flag is on.
//
// v2 (2026-10-01, after the v1 trial): v1's indicators set targets the data did
// not contain on 14 of 18 trial items, and gave them their own time windows.
// v2 names what to count, allows a number only from the findings or the owner's
// metrics, and reads the indicator at the end of the horizon.
//
// v3 (2026-09-26, Simon Q2 and Q40, after the v2 trial): 2 of 18 v2 findings
// were conjecture ("may be capturing discretionary spend"), and descriptions
// carried numbers the findings do not contain ("15-mile radius", "8-20 seats",
// "600 meters"), copied from the original run's own action prose. v3 forbids
// both, in one sentence each.
// ════════════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';

export const PLAN_RULE = [
  'THE PLAN: also return "plan", an array of 3 to 6 items that merges the operational "actions" and the "commercialActions" into ONE list, ranked by what the owner should do first.',
  'Each item is {"title":"...","desc":"...","owner":"...","horizon":"...","indicator":"...","finding":"..."}.',
  'owner: the role that does it, for example "Owner", "General manager", "Head chef", "Front-of-house manager" or "Marketing lead".',
  'horizon: when it should be done, as a period: "2 weeks", "30 days" or "90 days". The indicator is checked at the end of the horizon, so give it no other time window.',
  'indicator: one observable sign that it worked, naming what to count or watch and where, for example "the share of new Google reviews that mention slow service".',
  'Give a target number ONLY when that number appears in the findings or the business metrics above (for example a current rating to hold or beat); otherwise give no number. Never set a target the data does not contain.',
  'finding: the finding in this report the item follows from, named from the web data, the reviews or the owner\'s survey, in under 15 words.',
  'A finding states what the data shows, never a possibility: no "may", "might" or "could".',
  'desc: use a number only when it appears in the findings or the business metrics above; describe the action without one otherwise.',
  'Never invent a number the data does not contain. Keep "actions" and "commercialActions" exactly as the schema above asks.',
].join(' ');

export const PLAN_PROMPT_VERSION = 'plan-2026-10-01-v3-' + crypto.createHash('sha256').update(PLAN_RULE).digest('hex').slice(0, 12);

export function planPromptEnabled(env = process.env) {
  return env.RVP_PLAN_PROMPT === '1';
}
