// ════════════════════════════════════════════════════════════════════════════
// A REVISED SENTENCE SAYS SO, BESIDE THE SENTENCE (2026-09-30, B4).
//
// The field-level rewrite route (overnight\rewrite-field.js) replaces one
// field's text with the approved rewrite and keeps the previous text in
// meta.fieldRevisions[] { path, text, at, model, reason }. The page renders a
// note beside that field, about the SENTENCE, not the score:
//   "This passage was revised on <date> so that its comparisons agree with
//    their numbers. The wording first issued with this report is retained in
//    our records."
// (COPY FOR SIMON'S APPROVAL.) Only the fields the route may touch render a
// note, and only when a revision for that exact path exists.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldRevisionNote, FIELD_REVISION_PATHS } from '../lib-field-revisions.js';

process.env.PORT = '39493';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
const { __test__ } = await import('../server.js');

const pillars = { cs: { score: 66, label: 'Customer Sentiment', status: 'good' }, pa: { score: 70, label: 'Pricing', status: 'good' },
  es: { score: 42, label: 'Employee', status: 'bad' }, sm: { score: 48, label: 'Social', status: 'warn' },
  cp: { score: 58, label: 'Competitive', status: 'warn' }, bg: { score: 72, label: 'Brand', status: 'good' } };
const NOTE = 'This passage was revised on 2026-09-30 so that its comparisons agree with their numbers. The wording first issued with this report is retained in our records.';
// The Competitive Landscape section renders only when there are competitors.
const base = () => ({ pillars, executiveSummary: 'A summary.', competitiveInsight: 'Orchid has fewer reviews than DOMO (648 against 784).',
  competitors: [{ name: 'DOMO', rating: 4.8, reviewCount: 784, note: 'A peer across the road.' }],
  actions: [{ priority: 'urgent', title: 'First', desc: 'Do the first thing.' }, { priority: '30days', title: 'Second', desc: 'Revised second thing.' }] });
const render = (report) => __test__.renderReportHtml({ subscriber: { restaurant_name: 'A Restaurant', location: 'Santiago' }, report, reportLabel: 'HealthCheck' });
const rev = (path) => ({ path, text: 'the old sentence', at: '2026-09-30T02:00:00.000Z', model: 'claude-sonnet-4-5-20250929', reason: 'comparison' });

test('THE NOTE, for a comparison revision', () => {
  const r = base(); r.meta = { fieldRevisions: [rev('competitiveInsight')] };
  assert.equal(fieldRevisionNote(r, 'competitiveInsight'), NOTE);
  assert.equal(fieldRevisionNote(r, 'actions[0].desc'), '', 'a note for a field that was not revised');
});

// 2026-10-01 (C1): "How this report was built" lists every revision note again, by design
// (SUBJECT_INTEGRITY_STANDARD 6.2: each note is the one the page carries beside the changed
// text). So "once" is about the report body, before the proof page; the proof page is
// asserted to list each note exactly once.
const body = (html) => html.slice(0, html.indexOf('class="proof-page"') > 0 ? html.indexOf('class="proof-page"') : html.length);
const proof = (html) => { const i = html.indexOf('class="proof-page"'); return i > 0 ? html.slice(i) : ''; };

test('THE PAGE PRINTS THE NOTE BESIDE THE REVISED FIELD, and nowhere else', () => {
  const r = base(); r.meta = { fieldRevisions: [rev('competitiveInsight'), rev('actions[1].desc')] };
  const html = render(r);
  const ci = html.indexOf('Orchid has fewer reviews than DOMO');
  assert.ok(ci > 0, 'the competitive insight is not on the page');
  const afterCi = html.slice(ci, ci + 600);
  assert.ok(afterCi.includes(NOTE), 'no note after the competitive insight');
  const second = html.indexOf('Revised second thing.');
  assert.ok(html.slice(second, second + 400).includes(NOTE), 'no note after the revised action');
  const first = html.indexOf('Do the first thing.');
  assert.ok(!html.slice(first, first + 200).includes(NOTE), 'a note beside an action that was not revised');
  assert.equal(body(html).split(NOTE).length - 1, 2, 'the note printed in the body a number of times other than the two revisions');
  assert.equal(proof(html).split(NOTE).length - 1, 2, 'the proof page did not list each of the two revisions once');
});

test('no revision, no note', () => {
  assert.ok(!render(base()).includes('was revised on'));
});

test('only the listed fields can carry a note', () => {
  assert.deepEqual(FIELD_REVISION_PATHS.map(String), [String(/^competitiveInsight$/), String(/^actions\[\d+\]\.desc$/), String(/^competitors\[\d+\]\.note$/), String(/^commercialActions\[\d+\]\.desc$/)]);
  const r = base(); r.meta = { fieldRevisions: [rev('executiveSummary')] };
  assert.equal(fieldRevisionNote(r, 'executiveSummary'), '', 'the summary has its own note (summaryRevisedNote)');
});

test('CONTROL: the note detector finds the note when it is on the page', () => {
  const r = base(); r.meta = { fieldRevisions: [rev('competitiveInsight')] };
  assert.ok(render(r).includes(NOTE));
});
