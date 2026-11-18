// ════════════════════════════════════════════════════════════════════════════
// SCORING v3: A PILLAR WITH NO DATA IS NOT AVAILABLE, NEVER A NUMBER (Simon, 2026-11-18).
//
// Approved with three conditions, each proved here:
//   1. The null sweep: no pillar score or overall becomes a 0 anywhere it is computed,
//      written or shown ("a null that becomes a zero in the overall is this defect
//      again with better manners, and in RVP it lands in the single headline number").
//   2. Removed sentences are recorded with their text, not just counted.
//   3. One note covers the model change and v3, so a lower number is not read as decline.
// Old reports keep the v2 rule (Employee Sentiment at exactly 50 left out) and read as
// before. Fails on main afa304d and on 00627a2: no v3, no note, `?? 0` writes.
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../lib-score.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LABELS = { cs: 'Customer Sentiment', pa: 'Pricing & Accessibility', es: 'Employee Sentiment', sm: 'Social Media Impact', cp: 'Competitive Positioning', bg: 'Brand Experience & Growth' };
const pillars = (scores, v3) => Object.fromEntries(S.PILLAR_KEYS.map((k) => [k, Object.assign(
  { score: scores[k], label: LABELS[k], status: scores[k] === null ? 'na' : 'good' }, v3 ? { scoreRule: S.SCORE_RULE_V3 } : {})]));

test('v3: a null pillar is excluded, never a zero, and the overall says what it rests on', () => {
  const p = pillars({ cs: 80, pa: 70, es: null, sm: null, cp: 60, bg: 90 }, true);
  const r = S.computeOverall(p);
  assert.equal(r.ok, true);
  assert.equal(r.score, 75, '(80+70+60+90)/4; with the nulls as zeros it would be 50');
  assert.deepEqual(r.excluded, ['es', 'sm']);
  assert.equal(r.method, S.OVERALL_METHOD_VERSION);
  assert.equal(S.overallBasisSentence(r, p), 'The overall is the mean of the 4 pillars with public data; Employee Sentiment and Social Media Impact had none and are not counted.');
  assert.equal(S.overallFormula(r), '80 + 70 + 60 + 90 = 300, divided by 4 = 75, rounded to 75');
});

test('v3: a measured 50 is a measurement; fewer than three pillars with data is no overall', () => {
  const r = S.computeOverall(pillars({ cs: 80, pa: 70, es: 50, sm: 60, cp: 60, bg: 90 }, true));
  assert.ok(r.averaged.includes('es'));
  const few = S.computeOverall(pillars({ cs: 80, pa: null, es: null, sm: null, cp: null, bg: 90 }, true));
  assert.deepEqual([few.ok, few.score, few.reason], [false, null, 'too-few-pillars-with-data']);
  assert.match(S.overallBasisSentence(few, {}), /only 2 of the six pillars had public data/);
  assert.equal(S.verdictFor(few.score), null, 'no score, no verdict');
});

test('old reports read exactly as before: v2, Employee Sentiment 50 left out, no note', () => {
  const r = S.computeOverall(pillars({ cs: 80, pa: 70, es: 50, sm: 60, cp: 60, bg: 90 }, false));
  assert.deepEqual([r.ok, r.score, r.excluded, r.method], [true, 72, ['es'], S.OVERALL_METHOD_VERSION_V2]);
  assert.equal(S.overallBasisSentence(r, {}), '');
  assert.equal(S.scoreMethodOf(pillars({ cs: 1, pa: 1, es: 1, sm: 1, cp: 1, bg: 1 }, false)), S.OVERALL_METHOD_VERSION_V2);
  const bad = S.computeOverall(pillars({ cs: 80, pa: 70, es: null, sm: 60, cp: 60, bg: 90 }, false));
  assert.equal(bad.ok, false, 'a null without the v3 mark is a malformed v2 pillar, as before');
});

test('the server makes v3 reports: the prompt allows null, the pillars are marked, absence is read', () => {
  const src = read('server.js');
  assert.equal((src.match(/"score":<integer 0-100, or null when no public data speaks to this pillar>,"label"/g) || []).length, 6);
  assert.match(src, /never use 50 as a placeholder/);
  assert.match(src, /pl\.scoreRule = SCORE_RULE_V3;/);
  assert.match(src, /const esAbsent = \/\^\\s\*\(\?:no\|not\|none\)\\b\/i\.test\(String\(report\.employeeSentiment/);
});

test('the cover names the Google listing assessed, so a chain branch can be told apart', async () => {
  process.env.RVP_IMPORT_ONLY = '1';
  const { __test__ } = await import('../server.js');
  const rep = { pillars: pillars({ cs: 80, pa: 70, es: null, sm: 66, cp: 60, bg: 90 }, true), executiveSummary: 'x', strengths: [], risks: [],
    subject: { name: 'TGI Fridays', typedName: 'TGI Fridays', placeId: 'x', address: '10811 International Dr, Orlando, FL 32821, USA' } };
  const h = __test__.renderReportHtml({ subscriber: { restaurant_name: 'TGI Fridays' }, report: rep, reportLabel: 'Report' });
  assert.ok(h.includes('Google listing assessed: 10811 International Dr, Orlando, FL 32821, USA'));
  const old = Object.assign({}, rep, { subject: { name: 'TGI Fridays', placeId: 'x' } });
  assert.ok(!__test__.renderReportHtml({ subscriber: { restaurant_name: 'TGI Fridays' }, report: old, reportLabel: 'Report' }).includes('Google listing assessed'));
  const page = read('public/index.html');
  assert.match(page, /Google listing assessed: <b>'\+String\(r\.subject\.address\)/);
  assert.match(read('server.js'), /address: typeof confirmedPlace\.address === 'string'/);
});

test('the sweep: no score, pillar or overall is coerced to 0 anywhere', () => {
  const files = ['server.js', 'public/index.html', ...fs.readdirSync(ROOT).filter((f) => /^lib-.*\.js$/.test(f))];
  const shapes = [/score\s*\|\|\s*0\b/, /score\s*\?\?\s*0\b/, /\.score\s*:\s*0\b/, /overall\)?\s*\|\|\s*0\b/, /baseline_score:\s*0\b/];
  const hits = [];
  for (const f of files) read(f).split(/\r?\n/).forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    if (shapes.some((re) => re.test(line))) hits.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 110));
  });
  assert.deepEqual(hits, []);
});

test('every renderer shows Not available for a no-data pillar, and HubSpot never receives a missing value', () => {
  const src = read('server.js');
  assert.match(src, /if \(typeof p\.score !== 'number'\) return `<div class="sc-row">/);
  assert.match(src, /function hubspotPresent\(props\)/);
  assert.equal((src.match(/JSON\.stringify\(\{ properties \}\)/g) || []).length, 0, 'every HubSpot write passes through hubspotPresent');
  const page = read('public/index.html');
  assert.match(page, /if \(typeof p\.score !== 'number'\) return '<div class="sc-row">'/);
  assert.match(page, /pillar_es: r\.pillars && r\.pillars\.es && typeof r\.pillars\.es\.score === 'number' \? r\.pillars\.es\.score : null,/);
  assert.match(page, /score_method: \(window\.RVPScore && window\.RVPScore\.scoreMethodOf/);
});

test('a trajectory is never read across the method change or from a missing score', () => {
  const src = read('server.js');
  assert.match(src, /scoreMethodOf\(report && report\.pillars\) === scoreMethodOf\(baseline && baseline\.pillars\)/);
  assert.match(src, /const trajectory = reportNumber === 1 \|\| !comparable \? '' :/);
});

test('removed sentences are recorded with their text, on the report and in the log', () => {
  const src = read('server.js');
  assert.match(src, /report\.presenceRemovals = presenceChanges\.filter\(\(c\) => c\.action === 'sentence-removed'\)/);
  assert.match(src, /'PRESENCE_REMOVED \[diagnose\] reason=' \+ r\.reason \+ ' path=' \+ r\.path \+ ' sentence=' \+ JSON\.stringify/);
});

test('one note for both changes, on v3 reports only', async () => {
  assert.match(S.METHOD_CHANGE_NOTE, /newer AI model/);
  assert.match(S.METHOD_CHANGE_NOTE, /not directly comparable/);
  process.env.RVP_IMPORT_ONLY = '1';
  const { __test__ } = await import('../server.js');
  const v3 = { pillars: pillars({ cs: 80, pa: 70, es: null, sm: 66, cp: 60, bg: 90 }, true), executiveSummary: 'x', strengths: [], risks: [] };
  const v2 = { pillars: pillars({ cs: 80, pa: 70, es: 50, sm: 66, cp: 60, bg: 90 }, false), executiveSummary: 'x', strengths: [], risks: [] };
  const h3 = __test__.renderReportHtml({ subscriber: { restaurant_name: 'Test' }, report: v3, reportLabel: 'Report' });
  const h2 = __test__.renderReportHtml({ subscriber: { restaurant_name: 'Test' }, report: v2, reportLabel: 'Report' });
  assert.ok(h3.includes('Scores from before this change and after it are not'), 'the v3 report carries the note');
  assert.ok(h3.includes('Method ' + S.OVERALL_METHOD_VERSION));
  assert.ok(h3.includes('Employee Sentiment had none and is not counted'));
  assert.ok(!h2.includes('Scores from before this change'), 'an old report does not');
  assert.ok(h2.includes('Method ' + S.OVERALL_METHOD_VERSION_V2), 'an old report names its own method, v2');
  assert.ok(/Employee Sentiment[\s\S]{0,400}Not available/.test(h3));
});
