// ════════════════════════════════════════════════════════════════════════════
// EVERY NUMBER IN A PLAN ITEM COMES FROM THE REPORT (2026-10-01, Simon Q40).
//
// The v2 trial's strict check read indicators only, and The Spinnaker's v2
// descriptions carried "2-5 dollars per cover", "15-mile radius", "8-20 seats"
// and "600 meters", which nothing had checked. unsourcedNumbers reads EVERY
// field of a plan item (title, desc, owner, horizon, indicator, finding) and
// returns each number the stored report and the business metrics do not
// contain. The one exemption: the horizon periods the plan rule itself names
// ("2 weeks", "30 days", "90 days"), in the horizon field only.
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { unsourcedNumbers, planSource, PLAN_FIELDS } from '../lib-action-audit.js';

const SOURCE = JSON.stringify({ competitors: [{ name: "Scoma's", rating: 4.6, reviewCount: 1933 }], note: 'ranked #13 of 66 for group dining' })
  + ' Guest count change: +0%';

test('checks every plan field, not only the indicator', () => {
  assert.deepEqual(PLAN_FIELDS, ['title', 'desc', 'owner', 'horizon', 'indicator', 'finding']);
  const got = unsourcedNumbers({
    title: 'Optimize group dining',
    desc: 'Create a package for 8-20 seats within a 15-mile radius, 600 meters away, 2-5 dollars per cover.',
    owner: 'General manager', horizon: '90 days',
    indicator: 'Monthly group bookings', finding: 'Ranked 13 of 66 for group dining',
  }, SOURCE);
  assert.deepEqual(got.map((x) => x.field + ':' + x.number), ['desc:8', 'desc:20', 'desc:15', 'desc:600', 'desc:2', 'desc:5']);
});

test('a number the report contains is sourced, with thousands separators and decimals read as numbers', () => {
  assert.deepEqual(unsourcedNumbers({ desc: "Scoma's rates 4.6 from 1,933 reviews; ranked 13 of 66", indicator: 'rating above 4.6' }, SOURCE), []);
  // 4 is not sourced by 4.6, and 19 is not sourced by 1933
  assert.deepEqual(unsourcedNumbers({ desc: 'hold 4 stars and 19 covers' }, SOURCE).map((x) => x.number), ['4', '19']);
});

test('the horizon periods the rule names are exempt in the horizon field only', () => {
  assert.deepEqual(unsourcedNumbers({ horizon: '30 days' }, SOURCE), []);
  assert.deepEqual(unsourcedNumbers({ horizon: '2 weeks' }, SOURCE), []);
  assert.deepEqual(unsourcedNumbers({ horizon: '45 days' }, SOURCE).map((x) => x.number), ['45']);
  assert.deepEqual(unsourcedNumbers({ indicator: 'bookings within 30 days' }, SOURCE).map((x) => x.field + ':' + x.number), ['indicator:30']);
});

// The source is the report's FINDINGS, not its own action prose. On The Spinnaker
// (c7850407) the v2 plan's "15-mile", "8-20 seats", "600m" and "2-5 dollars per
// cover" appear in the stored report ONLY inside the stored `actions`, which the
// same model wrote in the original run: prose vouching for itself. planSource
// leaves out actions, commercialActions, plan and _debug, and adds the metrics.
test('the source is the findings and the metrics, never the actions the plan merges', () => {
  const report = {
    competitiveInsight: "Scoma's and Sushi Ran both rate 4.6",
    actions: [{ title: 'Groups', desc: 'package for 8-20 seats within 600m' }],
    commercialActions: [{ title: 'Check', desc: 'raise 2-5 dollars per cover' }],
    plan: [{ desc: '99 plan-only' }], _debug: { totalMs: 123456 },
  };
  const src = planSource(report, { guest_count_change: 0, avg_check_change: 3, profitability_change: null });
  assert.deepEqual(unsourcedNumbers({ desc: 'Create a package for 8-20 seats, 600m away, 2-5 dollars per cover; hold 4.6; lift check 3%' }, src)
    .map((x) => x.number), ['8', '20', '600', '2', '5']);
  assert.deepEqual(unsourcedNumbers({ desc: '99 and 123456' }, src).map((x) => x.number), ['99', '123456']);
  assert.equal(typeof planSource(null, null), 'string');
});

// Digits inside identifiers are not findings. The first probe matched "20" in a
// stored Google place id ("ChIJ0b_p20WEh..."), which would have sourced "8-20 seats".
test('digits inside ids, uuids, timestamps and model names source nothing', () => {
  const src = planSource({
    meta: { peerComparisonRunId: '67f8d3af-03b0-455c-aa52-3faadd579e01', executiveSummaryModel: 'claude-sonnet-4-5-20250929', at: '2026-09-23T11:48:23.227Z' },
    competitors: [{ placeId: 'ChIJ0b_p20WEhYAReF9zY3zyRXA', rating: 4.6 }], sha: 'e0b89991f754aa',
  }, null);
  assert.deepEqual(unsourcedNumbers({ desc: '8-20 seats, 455 guests, 4 or 5 visits, 11 and 48 minutes, 23 tables, 579 covers' }, src).map((x) => x.number),
    ['8', '20', '455', '4', '5', '11', '48', '23', '579']);
  assert.deepEqual(unsourcedNumbers({ desc: 'hold 4.6' }, src), []);
});

test('never throws on a missing item or source', () => {
  assert.deepEqual(unsourcedNumbers(null, null), []);
  assert.deepEqual(unsourcedNumbers({ desc: 'no numbers here' }, undefined), []);
});
