// ════════════════════════════════════════════════════════════════════════════
// THE SURVEY PAGE SHOWS THE COMPUTED SCORE, AND SHARES ONE COPY OF THE RULE.
//
// public/index.html rendered r.healthCheckScore and r.scoreVerdict directly,
// in nine places, and carried TWO MORE BAND TABLES of its own on top of the
// one in the prompt:
//
//     dialSVG            65 / 45          colour only
//     scoreBand          75 / 55          the teaser headline
//     buildFallback      75 / 60 / 45     the offline verdict
//
// Four tables for one quantity, none of them the report's. With the report now
// banding at 45 / 65 / 80, a visitor could be told "performing well" by the
// page and Fair by the report they buy ten seconds later.
//
// IT LOADS THE REAL lib-score.js RATHER THAN CARRYING A COPY. index.html is
// served as a string by app.get('/'), and a second implementation of the
// arithmetic in a browser file is the drift this whole part exists to remove.
// So the server serves the module and the page imports it.
//
// WHAT THIS FILE CAN AND CANNOT CHECK. It checks the route, the import, and
// that no direct read of the typed fields survives in a render path. It CANNOT
// check what the browser paints; overnight/rvp-score-gate.js does that in real
// Chrome, and this file is not evidence about rendering.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.PORT = '39281';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const HTML = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
const LIB = readFileSync(join(process.cwd(), 'lib-score.js'), 'utf8');

test('THE SERVER SERVES lib-score.js TO THE BROWSER', () => {
  assert.equal(typeof __test__.serveScoreLib, 'function',
    'there is no route handler exposing the score library');
});

test('and what it serves is the real file, not a copy', () => {
  const sent = __test__.serveScoreLib();
  assert.equal(sent.body, LIB, 'the served text differs from lib-score.js on disk');
  assert.match(sent.type, /javascript/);
});

test('THE PAGE IMPORTS IT', () => {
  assert.match(HTML, /from\s+['"]\/lib-score\.js['"]/,
    'index.html does not import the score library');
});

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

test('NO RENDER PATH READS THE TYPED SCORE', () => {
  // The construction inside buildFallback is allowed: that function BUILDS a
  // report payload and the field has to exist on it. Reading it back to show
  // a number is what must not survive.
  //
  // COMMENT LINES ARE SKIPPED, because the comment explaining this change
  // names both fields and a sweep that flagged it would be measuring prose.
  // The control below plants the read on a CODE line, so the exclusion cannot
  // hide a real one.
  const offenders = [];
  HTML.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    if (/\br\.healthCheckScore\b/.test(line) || /\br\.scoreVerdict\b/.test(line)) {
      offenders.push((i + 1) + ': ' + line.trim().slice(0, 90));
    }
  });
  assert.deepEqual(offenders, [], 'typed reads still in the page:\n' + offenders.join('\n'));
});

test('the page no longer carries band tables of its own', () => {
  // 75/55 in scoreBand and 75/60/45 in buildFallback. If either survives the
  // page can contradict the report it sells.
  assert.doesNotMatch(HTML, /healthCheckScore\s*>=\s*75/);
  assert.doesNotMatch(HTML, /overall\s*>=\s*75/);
});

// 2026-09-30 (B3): buildFallback, the in-browser estimate, is removed. The page
// computes no score of its own for a failed assessment; it says it failed.
test('THE PAGE HAS NO IN-BROWSER ESTIMATE: buildFallback is gone', () => {
  assert.ok(!HTML.includes('function buildFallback'), 'the in-browser estimate is back');
  assert.ok(HTML.includes('var FAILURE_COPY = {'), 'the failure copy is missing');
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the sweep can find a typed read when one is there', () => {
  // Counted as a DELTA, not an absolute, and through the SAME comment-skipping
  // filter the sweep uses. An absolute count only works while the answer
  // happens to be zero, and a control that skipped the filter would not prove
  // the filter still catches code.
  const count = (text) => text.split('\n')
    .filter(line => !isComment(line) && /\br\.healthCheckScore\b/.test(line)).length;
  assert.equal(count(HTML + '\nx = r.healthCheckScore;') - count(HTML), 1,
    'the sweep cannot see a typed read on a code line at all');
});

test('CONTROL: and it does NOT count a commented mention', () => {
  const count = (text) => text.split('\n')
    .filter(line => !isComment(line) && /\br\.healthCheckScore\b/.test(line)).length;
  assert.equal(count(HTML + '\n// mentions r.healthCheckScore in prose') - count(HTML), 0);
});

test('CONTROL: the page really is the survey page', () => {
  assert.match(HTML, /renderReport/);
  assert.match(HTML, /dialSVG/);
  assert.ok(HTML.length > 20000);
});

test('CONTROL: lib-score.js is non-empty, so the equality check means something', () => {
  assert.ok(LIB.length > 1000);
  assert.match(LIB, /export function computeOverall/);
});
