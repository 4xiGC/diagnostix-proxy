// ════════════════════════════════════════════════════════════════════════════
// THE EMAIL AND THE REPORT SHOW THE SAME NUMBER.
//
// buildCustomerReportEmail read report.healthCheckScore and
// report.scoreVerdict. renderReportHtml now computes both from the six
// pillars. Those two numbers differ by a median of 7 points across the 103
// stored reports, so shipping the renderer alone would send a customer an
// email saying 68 and a report saying 59, with nothing on either to explain
// it. The email is the first thing they see and the report is what they paid
// for; they cannot disagree.
//
// NO FALLBACK HERE EITHER. The old line was `?? 0`. When the six pillars are
// not all present the email shows no number at all rather than a hard zero or
// the typed value.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerReportEmail } from '../lib-email.js';
import { computeOverall, verdictFor } from '../lib-score.js';

const pillars = (a, b, c, d, e, f) => ({
  cs: { score: a, label: 'Customer Sentiment', status: 'good' },
  pa: { score: b, label: 'Pricing', status: 'good' },
  es: { score: c, label: 'Employee', status: 'warn' },
  sm: { score: d, label: 'Social', status: 'warn' },
  cp: { score: e, label: 'Competitive', status: 'good' },
  bg: { score: f, label: 'Brand', status: 'good' },
});

const build = (report) => buildCustomerReportEmail({
  subscriber: { report_token: 'a'.repeat(32), restaurant_name: 'A Restaurant',
                first_name: 'Sam', plan_type: 'one_off' },
  report, reportNumber: 1, survey: {},
});

// Teclados: the delivered report said 68, the six pillars average 59.333.
const TECLADOS = { healthCheckScore: 68, scoreVerdict: 'Good',
  pillars: pillars(66, 70, 42, 48, 58, 72) };

test('THE EMAIL SHOWS THE COMPUTED SCORE', () => {
  const html = build(TECLADOS).html;
  assert.match(html, />59</, 'the email does not show 59');
});

test('AND NOT THE TYPED ONE', () => {
  const html = build(TECLADOS).html;
  assert.doesNotMatch(html, />68</, 'the email still shows the typed 68');
});

test('the verdict is the one the band table gives, not the model word', () => {
  const html = build(TECLADOS).html;
  // 59 is Fair under 45/65/80. The model said Good.
  assert.match(html, /FAIR|Fair/, 'the email does not carry the computed verdict');
  assert.doesNotMatch(html, />\s*Good\s*</, 'the email still carries the model verdict');
});

test('the email agrees with the lib, not with a copy of the arithmetic', () => {
  const r = computeOverall(TECLADOS.pillars);
  const html = build(TECLADOS).html;
  assert.ok(html.includes('>' + r.score + '<'));
  assert.ok(html.toUpperCase().includes(String(verdictFor(r.score)).toUpperCase()));
});

test('an exact half rounds up in the email too', () => {
  const html = build({ healthCheckScore: 90, pillars: pillars(80, 80, 80, 83, 83, 83) }).html;
  assert.match(html, />82</);
  assert.doesNotMatch(html, />90</);
});

// ── NO FALLBACK ───────────────────────────────────────────────────────────

test('A MISSING PILLAR MEANS NO NUMBER, not a zero and not the typed one', () => {
  const p = pillars(60, 60, 60, 60, 60, 60);
  delete p.cp;
  const html = build({ healthCheckScore: 77, pillars: p }).html;
  assert.doesNotMatch(html, />77</, 'it fell back to the typed score');
  assert.doesNotMatch(html, />0</, 'it printed a hard zero');
});

test('the email still builds, and still carries the report link', () => {
  // Refusing to show a score must not refuse to deliver the report.
  const p = pillars(60, 60, 60, 60, 60, 60);
  delete p.cp;
  const out = build({ healthCheckScore: 77, pillars: p });
  assert.ok(out.html.length > 500);
  assert.match(out.html, /\/report\?token=/);
  assert.match(out.subject, /A Restaurant/);
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the email CAN show a number, so the absences mean something', () => {
  assert.match(build({ healthCheckScore: 70, pillars: pillars(70, 70, 70, 70, 70, 70) }).html, />70</);
});

test('CONTROL: 59 and 68 are genuinely different in this fixture', () => {
  const r = computeOverall(TECLADOS.pillars);
  assert.equal(r.score, 59);
  assert.notEqual(r.score, TECLADOS.healthCheckScore);
});

test('CONTROL: the >NN< probe can fail', () => {
  // If this matched anything the first two tests would both pass regardless.
  assert.doesNotMatch(build(TECLADOS).html, />12345</);
});
