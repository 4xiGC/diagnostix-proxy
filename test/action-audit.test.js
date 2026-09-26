// ════════════════════════════════════════════════════════════════════════════
// WHAT AN ACTION NEEDS: OWNER, HORIZON, INDICATOR, REASON (2026-10-01, A3).
// The rule that measures the stored reports' actions (the baseline) and the new
// plan shape (B1). Literal, never a guess: "urgent" and "ongoing" say nothing
// about when; a role named in the text counts as an owner.
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditAction, auditReportActions } from '../lib-action-audit.js';

test('A STORED-SHAPE ACTION WITH NONE OF THE FOUR', () => {
  const a = auditAction({ priority: 'urgent', title: 'Improve lighting', desc: 'Adjust the dining room lighting to feel warmer.' });
  assert.deepEqual(a, { owner: false, horizon: false, indicator: false, reason: false, all4: false });
});

test('each of the four is read from the text, literally', () => {
  const a = auditAction({ priority: 'urgent', title: 'Pacing', desc: 'Reviews mention long waits between courses. The general manager should retrain the floor team within 2 weeks and track average course interval to under 12 minutes.' });
  assert.deepEqual(a, { owner: true, horizon: true, indicator: true, reason: true, all4: true });
});

test('the 30-day priority is a horizon; urgent and ongoing are not', () => {
  assert.equal(auditAction({ priority: '30days', desc: 'x' }).horizon, true);
  assert.equal(auditAction({ priority: 'urgent', desc: 'x' }).horizon, false);
  assert.equal(auditAction({ priority: 'ongoing', desc: 'x' }).horizon, false);
});

test('explicit fields count: the B1 plan shape', () => {
  const a = auditAction({ title: 't', desc: 'd', owner: 'Head chef', horizon: '30 days', indicator: 'Portion complaints under 2 per month', finding: 'Customers Are Saying: portion size' });
  assert.equal(a.all4, true);
});

test('a commercial action`s evidence line is its reason', () => {
  assert.equal(auditAction({ title: 't', desc: 'd', evidence: 'Guest count -12% YoY' }).reason, true);
});

test('the report roll-up counts every list and names the source of each item', () => {
  const r = auditReportActions({ actions: [{ priority: 'urgent', desc: 'x' }], commercialActions: [{ desc: 'y', evidence: 'z' }], plan: [] });
  assert.equal(r.total, 2);
  assert.equal(r.reason, 1);
  assert.deepEqual(r.items.map((i) => i.source), ['actions[0]', 'commercialActions[0]']);
});

test('it never throws', () => {
  for (const bad of [undefined, null, 5, 'x', {}, { actions: 'no' }]) assert.equal(typeof auditReportActions(bad).total, 'number');
});

test('CONTROL: a sentence with an owner word but no role is not an owner', () => {
  assert.equal(auditAction({ desc: 'Own the narrative on social media.' }).owner, false);
});
