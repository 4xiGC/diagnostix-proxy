// ════════════════════════════════════════════════════════════════════════════
// A CHANGED SCORE EXPLAINS ITSELF.
//
// The computed score is RETROACTIVE: renderReportHtml computes from the stored
// pillars every time the page is served, so a customer who reopens a report
// link from May sees a number about 7 points lower than the one in the email
// they were sent. Nothing is backfilled and nothing needs to be, because the
// page is rendered at read time.
//
// THAT IS THE RIGHT BEHAVIOUR AND IT IS ALSO A SURPRISE. A number that changes
// under a reader with no explanation is worse than either number on its own.
// So the page names the method and says plainly that earlier reports may show
// a different total.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERALL_METHOD_VERSION } from '../lib-score.js';

process.env.PORT = '39271';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');

const pillars = (a, b, c, d, e, f) => ({
  cs: { score: a, label: 'Customer Sentiment', status: 'good' },
  pa: { score: b, label: 'Pricing', status: 'good' },
  es: { score: c, label: 'Employee', status: 'warn' },
  sm: { score: d, label: 'Social', status: 'warn' },
  cp: { score: e, label: 'Competitive', status: 'good' },
  bg: { score: f, label: 'Brand', status: 'good' },
});

const render = (report) => __test__.renderReportHtml({
  subscriber: { restaurant_name: 'A Restaurant', location: 'Santiago' },
  report, reportLabel: 'HealthCheck',
});

const TECLADOS = { healthCheckScore: 68, scoreVerdict: 'Good',
  pillars: pillars(66, 70, 42, 48, 58, 72), executiveSummary: 'A summary.' };

test('THE PAGE NAMES THE METHOD', () => {
  assert.match(render(TECLADOS), new RegExp(OVERALL_METHOD_VERSION));
});

test('and says an earlier report may show a different total', () => {
  const html = render(TECLADOS);
  assert.match(html, /may show a different overall score/i,
    'a reader whose number changed is given no explanation');
});

test('the explanation says WHAT the method is, not just its name', () => {
  assert.match(render(TECLADOS), /mean of the six pillar scores/i);
});

test('no method line when there is no score', () => {
  // Nothing was computed, so there is no method to name and nothing changed.
  const p = pillars(60, 60, 60, 60, 60, 60);
  delete p.es;
  const html = render({ healthCheckScore: 77, pillars: p });
  assert.doesNotMatch(html, new RegExp(OVERALL_METHOD_VERSION));
});

test('the explanation carries no dashes', () => {
  const html = render(TECLADOS);
  const line = (html.match(/<div class="score-formula">([\s\S]*?)<\/div>/) || [])[1] || '';
  assert.ok(line.length > 40, 'the formula block was not found, so this checks nothing');
  assert.doesNotMatch(line, /[–—]/);
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the method version is not already in the page by accident', () => {
  // If the string appeared in the stylesheet or a script, every assertion
  // above would pass with no method line rendered at all.
  const p = pillars(60, 60, 60, 60, 60, 60);
  delete p.es;
  const bare = render({ healthCheckScore: 77, pillars: p });
  assert.ok(!bare.includes(OVERALL_METHOD_VERSION));
});

test('CONTROL: the rendered page really is a report page', () => {
  const html = render(TECLADOS);
  assert.match(html, /Pillar Scores/);
  assert.match(html, /rpt-cover/);
});
