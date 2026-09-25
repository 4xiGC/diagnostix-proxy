// ════════════════════════════════════════════════════════════════════════════
// A LIMITED ASSESSMENT SAYS SO WHERE IT IS READ, AND A REFUSAL IS NEVER TURNED
// INTO AN ESTIMATED REPORT (overnight 2026-09-26, Item 3).
//
// The standard (1.1): limited produces "the full assessment, plus a limited
// coverage note". So the delivered report and the survey page print the note
// from report.coverage when, and only when, the state is limited. A stored
// report from before the gate has no coverage field and renders exactly as
// before.
//
// THE REFUSAL. The survey page treats any response without pillars as a failure
// and builds an "estimated" report from the owner's own sliders
// (buildFallback). A refusal answered that way would hand the owner a scored
// report of a business the product just declined to assess. The page must
// check `refused` BEFORE that fallback and show the refusal copy instead.
// These are static checks on the served page; the refusal panel is rendered
// in real Chrome by test/place-confirmation-chrome.test.js.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coverageNoteHtml } from '../lib-review-gate.js';

process.env.PORT = '39469';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
const { __test__ } = await import('../server.js');
const render = (report) => __test__.renderReportHtml({
  subscriber: { restaurant_name: 'Teclados', location: 'Santiago' }, report, reportLabel: 'HealthCheck' });

const NOTE = 'Google lists 120 reviews for Teclados, fewer than 300. The assessment is produced, and the thinner the public signal, the more it rests on a small number of reviews.';
const base = { executiveSummary: 'A summary.', pillars: { cs: { score: 60 }, pa: { score: 60 }, es: { score: 60 }, sm: { score: 60 }, cp: { score: 60 }, bg: { score: 60 } } };

test('coverageNoteHtml: the note for limited, nothing otherwise', () => {
  assert.match(coverageNoteHtml({ coverage: { state: 'limited', note: NOTE } }), /Limited coverage/);
  assert.match(coverageNoteHtml({ coverage: { state: 'limited', note: '<b>x</b>' } }), /&lt;b&gt;x&lt;\/b&gt;/);
  for (const r of [{}, null, { coverage: { state: 'pass', note: null } }, { coverage: { state: 'limited', note: '' } }]) {
    assert.equal(coverageNoteHtml(r), '', JSON.stringify(r));
  }
});

test('THE DELIVERED REPORT prints the note for a limited report', () => {
  const html = render(Object.assign({}, base, { coverage: { state: 'limited', note: NOTE } }));
  assert.ok(html.includes('Google lists 120 reviews for Teclados, fewer than 300.'));
});

test('CONTROL: a pass report, and a stored report with no coverage field, print no note', () => {
  for (const r of [Object.assign({}, base, { coverage: { state: 'pass', note: null } }), base]) {
    assert.ok(!render(r).includes('Limited coverage'));
  }
});

const PAGE = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('THE SURVEY PAGE checks refused BEFORE the failure page (the estimate is gone since 2026-09-30)', () => {
  const fn = PAGE.slice(PAGE.indexOf('async function runHealthCheck'), PAGE.indexOf('// ── PROGRESS REPORT SECTION BUILDER'));
  const refused = fn.indexOf('.refused');
  const failure = fn.indexOf('showRefusal(FAILURE_COPY)');
  assert.ok(refused > 0, 'runHealthCheck reads .refused');
  assert.ok(failure > 0, 'runHealthCheck shows the failure page');
  assert.ok(refused < failure, 'and reads .refused before it');
  assert.ok(!fn.includes('buildFallback('), 'the estimated report is back');
  assert.ok(/function showRefusal\(/.test(PAGE), 'the page has a refusal renderer');
  assert.ok(/id="p4"/.test(PAGE), 'and a refusal panel');
});

test('THE SURVEY PAGE prints the limited note in its summary', () => {
  assert.ok(/r\.coverage && r\.coverage\.state === 'limited'/.test(PAGE));
});
