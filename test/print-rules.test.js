// ════════════════════════════════════════════════════════════════════════════
// THE PRINT RULES THE REPORT DEPENDS ON, PINNED IN THE RENDERED PAGE.
//
// The executive summary was the only display block that could split across a
// page break. The coloured left stripe restarted on the next page and the
// background band was cut in half. Measured in real Chrome at both Letter and
// A4 on 2026-09-23: its computed page-break-inside was 'auto' while every
// other block in the list was 'avoid'.
//
// THIS FILE IS NOT THE GATE. It asserts the RULE IS IN THE STYLESHEET, which
// is cheap and runs on every commit. Whether Chrome honours it during real
// pagination is answered by overnight/exec-box-split-gate.js, which needs a
// browser and is run by hand. Both exist because either alone would be a
// reading: the rule can be present and ineffective, and a browser check that
// nobody runs is not a regression guard.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39441';
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

const HTML = __test__.renderReportHtml({
  subscriber: { restaurant_name: 'A Restaurant', location: 'Santiago' },
  report: { pillars: pillars(66, 70, 42, 48, 58, 72),
            executiveSummary: 'A summary of the business.',
            strengths: ['a'], risks: ['b'] },
  reportLabel: 'HealthCheck',
});

// EVERY @media print BLOCK, concatenated, so a match in the screen stylesheet
// cannot stand in for one in the print rules.
//
// THE FIRST VERSION TOOK ONLY THE FIRST ONE and the page has several: the
// first is a two-line .ev-panel rule, and the real print stylesheet with
// @page in it comes later. The test failed on a 62 character slice, which is
// the right way for that mistake to surface.
const PRINT_BLOCKS = (() => {
  const out = [];
  let from = 0;
  for (;;) {
    const i = HTML.indexOf('@media print', from);
    if (i === -1) break;
    let depth = 0, end = HTML.length;
    for (let k = HTML.indexOf('{', i); k < HTML.length; k++) {
      if (HTML[k] === '{') depth++;
      else if (HTML[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    out.push(HTML.slice(i, end));
    from = end;
  }
  return out;
})();
// COMMENTS ARE STRIPPED BEFORE ANYTHING IS MATCHED.
//
// THE FIRST VERSION OF THIS FILE PASSED WITH THE FIX REMOVED. The regex
// /\.exec-box[^{]*\{page-break-inside:avoid\}/ matched the CSS COMMENT that
// explains the fix: the comment contains the words ".exec-box JOINS THE LIST"
// and has no brace in it, so [^{]* ran through the whole comment and landed
// on the NEXT rule, .act,.comp-card,.qblock{page-break-inside:avoid}.
//
// The test was asserting that somebody had written about the fix, not that
// the fix was there. This is the same shape as searching a rendered page for
// a section name and finding its stylesheet.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const PRINT_BLOCK = stripComments(PRINT_BLOCKS.join(String.fromCharCode(10)));

test('CONTROL: the print blocks were found and contain the page rule', () => {
  assert.ok(PRINT_BLOCKS.length >= 1, 'no @media print block found at all');
  assert.ok(PRINT_BLOCK.length > 400,
    'the slice is only ' + PRINT_BLOCK.length + ' chars across '
    + PRINT_BLOCKS.length + ' block(s), too short to be the print stylesheet');
  assert.match(PRINT_BLOCK, /@page/, 'no @page rule in any print block');
});

test('THE EXECUTIVE SUMMARY BOX MUST NOT SPLIT ACROSS A PAGE', () => {
  assert.match(PRINT_BLOCK, /\.exec-box[^{]*\{page-break-inside:avoid\}/,
    '.exec-box is not in a page-break-inside:avoid rule');
});

test('and the blocks that already had the rule still do', () => {
  for (const sel of ['.act', '.comp-card', '.qblock', '.col-2']) {
    assert.ok(new RegExp(sel.replace('.', '\.') + '[^{]*\{page-break-inside:avoid\}')
      .test(PRINT_BLOCK), sel + ' lost page-break-inside:avoid');
  }
});

test('CONTROL: the assertion can fail on a selector that is NOT in the list', () => {
  // Without this, the regex above would pass against almost any stylesheet.
  assert.ok(!/\.sc-row[^{]*\{page-break-inside:avoid\}/.test(PRINT_BLOCK),
    '.sc-row is in the avoid list, so the check does not discriminate');
});

test('CONTROL: A COMMENT MENTIONING THE SELECTOR DOES NOT SATISFY IT', () => {
  // This is the bug this file shipped with for one run. A comment naming
  // .exec-box, followed by a rule for other selectors, matched the assertion
  // and the test passed with the fix removed.
  const faked = stripComments(
    '@media print{ /* .exec-box should be here one day */ '
    + '  .act,.comp-card{page-break-inside:avoid} }');
  assert.ok(!/\.exec-box[^{]*\{page-break-inside:avoid\}/.test(faked),
    'a comment still satisfies the assertion');
});

test('CONTROL: and the real rule DOES satisfy it', () => {
  const real = stripComments('@media print{ .exec-box,.act{page-break-inside:avoid} }');
  assert.ok(/\.exec-box[^{]*\{page-break-inside:avoid\}/.test(real),
    'the assertion cannot recognise the rule it exists to require');
});

// ── The paper size is NOT declared, and that is recorded, not fixed ───────

test('NO PAPER SIZE IS DECLARED, which is an open decision', () => {
  // @page{margin:0.6in} with no size means the printer default: Letter in the
  // US, A4 in Europe. Every print geometry number in this product therefore
  // has two values. Measured 2026-09-23: the summary box holds 338 words
  // before crossing a boundary on Letter and 366 on A4.
  //
  // DECLARING ONE IS A PRODUCT DECISION, not a bug fix, so this pins the
  // ABSENCE. If a size is ever added, this test goes red and whoever added it
  // has to say which and why.
  assert.doesNotMatch(PRINT_BLOCK, /@page\s*\{[^}]*size\s*:/,
    'a paper size has been declared; record the decision and update this test');
  assert.match(PRINT_BLOCK, /@page\s*\{\s*margin:0\.6in\s*\}/,
    'the @page rule is no longer margin-only');
});

test('CONTROL: the size detector would SEE a declared size', () => {
  const withSize = PRINT_BLOCK.replace('@page{margin:0.6in}', '@page{size:A4;margin:0.6in}');
  assert.match(withSize, /@page\s*\{[^}]*size\s*:/,
    'the detector cannot see a size, so the assertion above proves nothing');
});
