// ════════════════════════════════════════════════════════════════════════════
// ONE RANKED ACTION PLAN, FIRST AFTER THE COVER (2026-10-01, recommendation 9, B1).
//
// Stored reports carry two lists: `actions` (operational, by priority) and
// `commercialActions` (tied to the owner's numbers). They rendered LAST, in two
// sections. Now one list, "What to do first", sits first in the body:
//   1. urgent operational actions, in stored order
//   2. commercial actions (they carry an evidence line), in stored order
//   3. 30-day actions, then ongoing ones
// A new-shape report (`plan`, produced by the flagged prompt) is used as is.
// Owner, horizon, indicator and finding render only where the payload has them;
// nothing is invented. Items with the same normalised title merge into one.
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionPlan } from '../lib-action-plan.js';

process.env.PORT = '39733';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
const { __test__ } = await import('../server.js');

const P = (s) => ({ score: s, label: 'x', status: 'good' });
const report = (extra) => Object.assign({
  pillars: { cs: P(70), pa: P(66), es: P(60), sm: P(58), cp: P(72), bg: P(68) },
  executiveSummary: 'A summary.',
  actions: [
    { priority: 'ongoing', title: 'Keep posting', desc: 'Post weekly.' },
    { priority: 'urgent', title: 'Fix pacing', desc: 'Reviews mention long waits.' },
    { priority: '30days', title: 'Warm lighting', desc: 'Adjust lighting.' },
    { priority: 'urgent', title: 'fix  pacing', desc: 'Duplicate of the first urgent item.' },
  ],
  commercialActions: [{ title: 'Menu engineering', desc: 'Rework the menu mix.', evidence: 'Average check -3% YoY' }],
}, extra || {});
// The row carries a business metric, as on 90 of the 112 stored reports: main renders the
// commercial list only then (hasAnyBM), and the plan keeps that rule (B1a).
const render = (r, sub) => __test__.renderReportHtml({ subscriber: Object.assign({ restaurant_name: 'A Restaurant', location: 'Santiago', email: 'x@example.org', avg_check_change: -3 }, sub || {}), report: r, reportLabel: 'HealthCheck' });

test('THE RANKING: urgent, then commercial, then 30 days, then ongoing; duplicates merge', () => {
  const plan = buildActionPlan(report());
  assert.deepEqual(plan.map((i) => i.title), ['Fix pacing', 'Menu engineering', 'Warm lighting', 'Keep posting']);
  assert.equal(plan[0].source, 'actions[1]');
  assert.equal(plan[1].finding, 'Average check -3% YoY', 'a commercial evidence line is the finding it follows from');
  assert.equal(plan[2].horizon, '30 days');
  assert.equal(plan[0].horizon, null, 'urgent is a priority, not a horizon');
  assert.equal(plan[0].owner, null, 'no owner is invented');
});

test('a new-shape plan is used as written, with its four fields', () => {
  const plan = buildActionPlan(report({ plan: [{ title: 'T', desc: 'D', owner: 'Head chef', horizon: '30 days', indicator: 'Waits under 12 minutes', finding: 'Reviews mention long waits' }] }));
  assert.equal(plan.length, 1);
  assert.deepEqual([plan[0].owner, plan[0].horizon, plan[0].indicator, plan[0].finding], ['Head chef', '30 days', 'Waits under 12 minutes', 'Reviews mention long waits']);
});

test('THE PAGE: "What to do first" is the first section after the cover; the two old sections are gone', () => {
  const html = render(report());
  const first = html.indexOf('<h2 class="rpt-h">');
  assert.ok(html.slice(first).startsWith('<h2 class="rpt-h">What to do first</h2>'), 'the plan is not the first section: ' + html.slice(first, first + 60));
  assert.equal(html.includes('>Recommended Actions<'), false);
  assert.equal(html.includes('>Commercial Recommendations<'), false);
  for (const t of ['Fix pacing', 'Menu engineering', 'Warm lighting', 'Keep posting']) assert.ok(html.includes(t), t + ' is missing');
  assert.equal(html.includes('Duplicate of the first urgent item'), false, 'the duplicate was not merged');
});

test('fields render only where the payload has them', () => {
  const html = render(report());
  const from = html.indexOf('<h2 class="rpt-h">What to do first</h2>');
  const plan = html.slice(from, html.indexOf('<h2 class="rpt-h">', from + 10)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.ok(plan.length > 100, 'the plan section was not found, so this checks nothing');
  assert.match(plan, /Follows from: Average check -3% YoY/);
  assert.match(plan, /By when: 30 days/);
  assert.doesNotMatch(plan, /Owner: /, 'an owner label appeared where no owner is stored');
  assert.doesNotMatch(plan, /not stated|undefined|null/);
});

test('a report with no actions has no plan section', () => {
  const html = render(report({ actions: [], commercialActions: [] }));
  assert.equal(html.includes('What to do first'), false);
});

test('CONTROL: the ranking test would catch the old order', () => {
  const old = report().actions.map((a) => a.title);
  assert.notDeepEqual(old, buildActionPlan(report()).map((i) => i.title));
});

// B1a (2026-10-01, found by the A2 second pass): main showed "Commercial Recommendations"
// only when the row carries a business metric. The first plan merged them regardless, so on
// 5 stored reports actions labelled "Tied to your numbers" appeared for an owner who shared
// no numbers. The plan keeps main's rule.
test('NO BUSINESS METRIC ON THE ROW: commercial actions stay out of the plan, as on main', () => {
  const html = render(report(), { avg_check_change: null });
  assert.ok(html.includes('What to do first') && html.includes('Fix pacing'), 'the plan did not render, so this checks nothing');
  assert.equal(html.includes('Menu engineering'), false, 'a commercial action rendered with no business metric on the row');
  assert.equal(html.includes('Tied to your numbers'), false);
  assert.deepEqual(buildActionPlan(report(), { commercial: false }).map((i) => i.title), ['Fix pacing', 'Warm lighting', 'Keep posting']);
});

test('CONTROL: with a business metric the commercial action is in the plan', () => {
  const html = render(report(), { avg_check_change: -3 });
  assert.ok(html.includes('Menu engineering'));
});
