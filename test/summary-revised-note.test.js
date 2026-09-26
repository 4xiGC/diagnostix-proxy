// THE REPORT SAYS SO WHEN ITS EXECUTIVE SUMMARY WAS REWRITTEN.
//
// 73 stored payloads had their executive summary replaced on 2026-09-23,
// because the originals stated a verdict that contradicted the computed band:
// 114 blocking contradictions across 66 rows, plus eight band-clean but
// over-length. The originals are kept forever in
// meta.executiveSummaryOriginal.
//
// THE REPORT IS RENDERED AT READ TIME from the stored payload, so a customer
// reopening a link from before that date sees prose they were never sent,
// with nothing on the page saying it changed. That is the same failure the
// v8.11.50 method disclosure was written for, one layer over: a number that
// changes under a reader without explanation is worse than either number, and
// so is a paragraph.
//
// Q4, answered by Simon: tell the customer.
import { test } from 'node:test';
import assert from 'node:assert';

process.env.RVP_IMPORT_ONLY = '1';
process.env.PORT = process.env.PORT || '39478';
const { __test__ } = await import('../server.js');
const { renderReportHtml } = __test__;

const PILLARS = {
  cs: { score: 72, label: 'Customer Sentiment', status: 'good' },
  pa: { score: 65, label: 'Pricing & Accessibility', status: 'warn' },
  es: { score: 58, label: 'Employee Sentiment', status: 'warn' },
  sm: { score: 74, label: 'Social Media Impact', status: 'good' },
  cp: { score: 70, label: 'Competitive Positioning', status: 'good' },
  bg: { score: 71, label: 'Brand Experience & Growth', status: 'good' },
};

const render = (meta, pillars = PILLARS) => renderReportHtml({
  subscriber: { restaurant_name: 'Revised Note Fixture', location: 'Santiago' },
  report: {
    pillars,
    executiveSummary: 'A fair overall position with steady sentiment.',
    strengths: ['One'], risks: ['Two'],
    ...(meta ? { meta } : {}),
  },
  reportLabel: 'HealthCheck',
});

const REVISED = {
  executiveSummaryOriginal: 'The restaurant is performing excellently across every pillar.',
  executiveSummaryReplacedAt: '2026-09-23T04:11:07.552Z',
  executiveSummaryModel: 'claude-sonnet-5',
  executiveSummaryMethod: 'rvp-overall-mean-v1',
};

test('a revised summary is DISCLOSED, with the date it was revised', () => {
  const html = render(REVISED);
  assert.match(html, /executive summary on this page was rewritten on 2026-09-23/i,
    'the page must say the summary was rewritten and when');
});

test('the disclosure says WHY: to agree with the computed score', () => {
  const html = render(REVISED);
  assert.match(html, /agree with the computed overall score/i,
    'a disclosure that does not say why reads as an admission of an unexplained edit');
});

test('CONTROL: a payload with no revision says NOTHING about a rewrite', () => {
  const html = render(null);
  assert.doesNotMatch(html, /rewritten on/i,
    'a report whose summary was never touched must not carry the sentence');
  assert.doesNotMatch(html, /executive summary on this page was/i);
});

test('CONTROL: meta present but no replacedAt still says nothing', () => {
  // The 37 payloads that were assessed but never regenerated carry other meta.
  const html = render({ benchmarkRowId: 'abc', someOtherField: 1 });
  assert.doesNotMatch(html, /rewritten on/i,
    'only executiveSummaryReplacedAt may trigger the sentence');
});

test('the date is READ FROM THE PAYLOAD, not taken from today', () => {
  const a = render({ ...REVISED, executiveSummaryReplacedAt: '2026-09-23T04:11:07.552Z' });
  const b = render({ ...REVISED, executiveSummaryReplacedAt: '2025-01-05T23:59:59.000Z' });
  assert.match(a, /rewritten on 2026-09-23/);
  assert.match(b, /rewritten on 2025-01-05/);
  assert.notStrictEqual(
    (a.match(/rewritten on (\d{4}-\d{2}-\d{2})/) || [])[1],
    (b.match(/rewritten on (\d{4}-\d{2}-\d{2})/) || [])[1],
    'CONTROL: if both render the same date the value is being ignored and a '
    + 'constant is being printed'
  );
});

test('an unparseable timestamp discloses the rewrite WITHOUT inventing a date', () => {
  const html = render({ ...REVISED, executiveSummaryReplacedAt: 'not a date' });
  assert.match(html, /executive summary on this page was rewritten/i,
    'the disclosure must survive a bad timestamp: the rewrite happened either way');
  assert.doesNotMatch(html, /Invalid Date/,
    'never print Invalid Date to a customer');
  assert.doesNotMatch(html, /rewritten on \d/,
    'and never guess a date that is not in the payload');
});

test('the disclosure survives a payload with NO computable overall score', () => {
  // Five pillars, so computeOverall returns null and the method block that
  // carries the disclosure is not rendered. THE DISCLOSURE IS NOT ABOUT THE
  // SCORE: the summary was still rewritten and the reader is still owed the
  // sentence.
  const five = { ...PILLARS };
  delete five.bg;
  const html = render(REVISED, five);
  assert.doesNotMatch(html, /Overall score:/,
    'CONTROL: this fixture must genuinely have no overall score, otherwise '
    + 'the test is not exercising the branch it claims to');
  assert.match(html, /executive summary on this page was rewritten on 2026-09-23/i,
    'the sentence must not be nested inside the score block');
});

// 2026-10-01 (C1): "How this report was built" lists every revision note again, by design
// (SUBJECT_INTEGRITY_STANDARD 6.2: each note is the one the page carries beside the changed
// text). So "once" is about the report body, before the proof page; the proof page is
// asserted to list each note exactly once.
const body = (html) => html.slice(0, html.indexOf('class="proof-page"') > 0 ? html.indexOf('class="proof-page"') : html.length);
const proof = (html) => { const i = html.indexOf('class="proof-page"'); return i > 0 ? html.slice(i) : ''; };

test('CONTROL: the sentence appears exactly once', () => {
  const html = render(REVISED);
  const n = (body(html).match(/executive summary on this page was rewritten/gi) || []).length;
  assert.strictEqual(n, 1, 'rendered ' + n + ' times in the body');
  const p = (proof(html).match(/executive summary on this page was rewritten/gi) || []).length;
  assert.strictEqual(p, 1, 'listed ' + p + ' times on the proof page');
});
