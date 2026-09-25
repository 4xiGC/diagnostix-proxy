// ════════════════════════════════════════════════════════════════════════════
// A COMPARISON WHOSE WORDS CONTRADICT ITS NUMBERS IS FLAGGED (2026-09-29,
// recommendation 4).
//
// Delivered, read 2026-09-28 (B2):
//   Orchid:    "... significantly higher review volume: 648 vs 784" (648 is the LOWER)
//   Bocanáriz: "ranks #2 in Santiago dining (4.5 rating, 8,285 reviews, #62 of 3,523 restaurants)"
// Two parts, both in lib-comparisons.js:
//   COMPARISON_RULE, a prompt rule, appended to the prose prompts (diagnose-p2
//     and the executive summary); asserted here through the REAL /diagnose route
//   findContradictions(report), the render-time check: it FLAGS (a log line and
//     a returned list) and never rewrites the prose. A comparison is rewritten
//     only by a model under the rule; a regex that "fixes" one would be guessing
//     which of the two numbers the sentence meant.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

const { findContradictions, findContradictionsInText, COMPARISON_RULE } = await import('../lib-comparisons.js');

test('THE ORCHID CASE: "higher ... 648 vs 784" is flagged', () => {
  const f = findContradictionsInText('Ranked number 1 in Google Places within category, 4.7/5 vs DOMO at 4.8 and Illam at 4.9 but with significantly higher review volume: 648 vs 784.');
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].kind, 'direction');
  assert.match(f[0].detail, /higher.*648.*784/);
});

test('THE BOCANARIZ CASE: two different ranks in one sentence are flagged', () => {
  const f = findContradictionsInText('Bocanáriz ranks #2 in Santiago dining (4.5 rating, 8,285 reviews, #62 of 3,523 restaurants).');
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].kind, 'two-ranks');
});

test('CONTROLS: comparisons whose words match their numbers are NOT flagged', () => {
  for (const s of [
    'The restaurant has fewer reviews than its peer: 648 vs 784.',
    'A higher rating than DOMO: 4.8 vs 4.5.',
    'Review volume is lower, 648 against 784.',
    'It ranks #2 of 40 in the neighborhood.',
    'It was #3 in 2024 and #3 again in 2025.',
    'Guest count 0% vs 5% last year.',
    'Rated 4.5 on Google and 4.0 on TripAdvisor.',
  ]) assert.deepEqual(findContradictionsInText(s), [], s);
});

test('"more", "greater", "larger", "ahead" and "fewer", "less", "behind", "trails" are read too', () => {
  assert.equal(findContradictionsInText('It has more reviews than Nearby One (120 vs 900).').length, 1);
  assert.equal(findContradictionsInText('It trails Nearby One on volume, 900 vs 120.').length, 1);
  assert.equal(findContradictionsInText('It has fewer reviews, 900 vs 120.').length, 1);
});

test('THE REPORT CHECK walks every prose field and names the path; it never edits', () => {
  const report = {
    executiveSummary: 'A clean summary.',
    competitiveInsight: 'Significantly higher review volume: 648 vs 784.',
    competitors: [{ name: 'X', note: 'Ranks #2 in town (#62 of 3,523).' }],
    _debug: { note: 'higher 1 vs 9' },
  };
  const before = JSON.stringify(report);
  const f = findContradictions(report);
  assert.deepEqual(f.map((x) => x.path).sort(), ['competitiveInsight', 'competitors[0].note']);
  assert.equal(JSON.stringify(report), before, 'the check edited the report');
});

test('it never throws', () => {
  for (const bad of [undefined, null, 42, 'text', { a: null }]) assert.doesNotThrow(() => findContradictions(bad));
});

test('THE PROMPT RULE names both live failures, in plain terms', () => {
  assert.match(COMPARISON_RULE, /COMPARISONS, HARD RULE/);
  assert.match(COMPARISON_RULE, /648/);
  assert.match(COMPARISON_RULE, /#62 of 3,523/);
  assert.doesNotMatch(COMPARISON_RULE, /[–—]/, 'the rule itself carries a dash');
});

test('THE RENDER logs every flag with its path and leaves the sentence as written', async () => {
  process.env.RVP_IMPORT_ONLY = '1'; process.env.PORT = process.env.PORT || '39496';
  const { __test__ } = await import('../server.js');
  const lines = []; const was = console.log; console.log = (...a) => { lines.push(a.join(' ')); };
  const report = { pillars: {}, executiveSummary: 'x', competitiveInsight: 'Significantly higher review volume: 648 vs 784.' };
  const before = JSON.stringify(report);
  try {
    __test__.renderReportHtml({ subscriber: { restaurant_name: 'Orchid' }, reportLabel: 'HealthCheck', report });
  } finally { console.log = was; }
  const line = lines.find((l) => l.startsWith('COMPARISON_CHECK [render]'));
  assert.ok(line, 'no COMPARISON_CHECK line: ' + JSON.stringify(lines.slice(0, 5)));
  assert.match(line, /flagged=1/);
  assert.match(line, /competitiveInsight:direction/);
  assert.equal(JSON.stringify(report), before, 'the render changed the flagged report');
});
