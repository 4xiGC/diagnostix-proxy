// ════════════════════════════════════════════════════════════════════════════
// v8.11.24 [ALL-1]: the evidence base panel, computed by code
//
// WHY THIS EXISTS AND WHY IT IS NOT THE OLD COUNT. Reports used to quote a
// number of "feedback reference points". It was removed because the numbers
// were not true: SVP's 170 is the pipeline cap, identical on every report
// regardless of what was actually found. A constant dressed as a measurement
// is worse than no measurement, because a reader who checks it once stops
// believing everything next to it.
//
// THE RULE FOR EVERY FIGURE HERE: it is counted from what the pipeline
// actually did on THIS assessment, or it is omitted. Nothing is estimated,
// nothing is defaulted, and a figure that cannot be computed does not appear
// as a zero, because "0 reviews" reads as a finding when it is really an
// absence of instrumentation.
//
// RVP IS THE EASY CASE AND THE HONEST ONE. Its review volumes come from Google
// Places user_ratings_total for the focal restaurant and each peer: exact
// integers, already fetched, already tied to a place_id. There is no name
// matching and therefore no subject test to get wrong. SVP and EVP have to
// extract volumes from text and prove the row is about the subject, which is a
// much weaker position and is handled separately.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newLedger, noteSearch, noteResults, hostOf, summarizeEvidence,
  renderEvidenceSentence, formatCount, evidencePanelHtml,
} from '../lib-evidence.js';

// ── hostOf ──────────────────────────────────────────────────────────────────

test('hostOf strips the scheme, the port and a leading www', () => {
  assert.equal(hostOf('https://www.tripadvisor.com/Restaurant_Review-g123.html'), 'tripadvisor.com');
  assert.equal(hostOf('http://example.org:8080/a/b'), 'example.org');
  assert.equal(hostOf('https://maps.google.com/'), 'maps.google.com');
});

test('hostOf is lowercased, so one site is never counted twice', () => {
  assert.equal(hostOf('https://TripAdvisor.com/x'), 'tripadvisor.com');
  assert.equal(hostOf('https://WWW.TripAdvisor.COM/y'), 'tripadvisor.com');
});

test('hostOf returns null on junk rather than inventing a host', () => {
  for (const junk of [null, undefined, '', 'not a url', 42, {}, 'ftp:/']) {
    assert.equal(hostOf(junk), null, JSON.stringify(junk));
  }
});

// ── the ledger counts what happened, not what was configured ────────────────

test('a fresh ledger is all zeros and no sites', () => {
  const s = summarizeEvidence(newLedger());
  assert.equal(s.searchesRun, 0);
  assert.equal(s.resultsReturned, 0);
  assert.equal(s.resultsRead, 0);
  assert.equal(s.distinctSites, 0);
});

test('a search that returned nothing still counts as a search run', () => {
  // The distinction the whole panel rests on. "We ran 14 searches and read 9
  // results" is a true and useful sentence. Counting only fruitful searches
  // would flatter the report exactly where it is weakest.
  const l = newLedger();
  noteSearch(l, { label: 'REVIEWS' });
  noteResults(l, { organic: [], read: 0 });
  const s = summarizeEvidence(l);
  assert.equal(s.searchesRun, 1);
  assert.equal(s.resultsReturned, 0);
  assert.equal(s.resultsRead, 0);
});

test('results read never exceeds results returned', () => {
  // read is what entered the corpus after the slice and the budget. If this
  // can exceed returned, the panel is reporting a cap again.
  const l = newLedger();
  noteSearch(l, { label: 'GOOGLE' });
  noteResults(l, {
    organic: [{ link: 'https://a.com/1' }, { link: 'https://b.com/2' }],
    read: 99,
  });
  const s = summarizeEvidence(l);
  assert.equal(s.resultsReturned, 2);
  assert.equal(s.resultsRead, 2, 'read must be clamped to what was actually returned');
});

test('distinct sites counts hosts, not results', () => {
  const l = newLedger();
  noteSearch(l, { label: 'GOOGLE' });
  noteResults(l, {
    organic: [
      { link: 'https://tripadvisor.com/a' },
      { link: 'https://www.tripadvisor.com/b' },
      { link: 'https://yelp.com/c' },
    ],
    read: 3,
  });
  const s = summarizeEvidence(l);
  assert.equal(s.resultsReturned, 3);
  assert.equal(s.distinctSites, 2, 'tripadvisor.com twice is one site');
});

test('only the results actually READ contribute a site', () => {
  // A result that was returned but sliced away was never read, so claiming its
  // host among "sites read" would be a false claim in the panel's own words.
  const l = newLedger();
  noteSearch(l, { label: 'GOOGLE' });
  noteResults(l, {
    organic: [{ link: 'https://read-me.com/a' }, { link: 'https://sliced-off.com/b' }],
    read: 1,
  });
  const s = summarizeEvidence(l);
  assert.equal(s.distinctSites, 1);
  assert.ok(s.sites.includes('read-me.com'));
  assert.ok(!s.sites.includes('sliced-off.com'), 'a result that was never read is not a site read');
});

test('a result with no usable link contributes no site but still counts', () => {
  const l = newLedger();
  noteSearch(l, { label: 'GOOGLE' });
  noteResults(l, { organic: [{ title: 'no link here' }, { link: 'https://ok.com/x' }], read: 2 });
  const s = summarizeEvidence(l);
  assert.equal(s.resultsReturned, 2);
  assert.equal(s.distinctSites, 1);
});

test('the ledger survives junk without throwing', () => {
  const l = newLedger();
  for (const junk of [null, undefined, {}, { organic: null }, { organic: 'x' }, { organic: [null, 7] }]) {
    assert.doesNotThrow(() => noteResults(l, junk));
  }
  assert.doesNotThrow(() => summarizeEvidence(null));
  assert.doesNotThrow(() => noteSearch(null, {}));
});

// ── the sentence, and the zero case ─────────────────────────────────────────

test('the sentence matches the agreed wording', () => {
  const out = renderEvidenceSentence({ reviewsTotal: 3412, sourcesCounted: 5 });
  assert.equal(out,
    'The sources read for this assessment publish 3,412 reviews and ratings '
    + 'between them. DiagnostiX reads the public summary of each source, not '
    + 'every individual review.');
});

test('THE ZERO CASE: nothing to report means no sentence at all', () => {
  // Not "0 reviews". A zero here means the volumes could not be counted, and
  // printing it would state an absence of instrumentation as a finding about
  // the subject.
  assert.equal(renderEvidenceSentence({ reviewsTotal: 0, sourcesCounted: 0 }), null);
  assert.equal(renderEvidenceSentence({ reviewsTotal: 0, sourcesCounted: 3 }), null);
  assert.equal(renderEvidenceSentence({}), null);
  assert.equal(renderEvidenceSentence(null), null);
});

test('a non-integer or negative total is refused, not rounded', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '3412', null, undefined]) {
    assert.equal(renderEvidenceSentence({ reviewsTotal: bad, sourcesCounted: 2 }), null,
      'accepted ' + String(bad));
  }
});

test('one review is singular-safe, because the wording must not read as broken', () => {
  const out = renderEvidenceSentence({ reviewsTotal: 1, sourcesCounted: 1 });
  assert.ok(out && out.includes('1 review'), out);
  assert.ok(!/\b1 reviews\b/.test(out), 'reads as broken English: ' + out);
});

test('the sentence contains no dash, per house style', () => {
  const out = renderEvidenceSentence({ reviewsTotal: 3412, sourcesCounted: 5 });
  assert.ok(!out.includes('—') && !out.includes('–'), out);
});

test('formatCount groups thousands and refuses what it cannot format', () => {
  assert.equal(formatCount(3412), '3,412');
  assert.equal(formatCount(1), '1');
  assert.equal(formatCount(1000000), '1,000,000');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(-1), null);
  assert.equal(formatCount(1.5), null);
  assert.equal(formatCount('x'), null);
});

// ── the rendered panel ──────────────────────────────────────────────────────
//
// Moved into lib-evidence.js so it can be tested at all: server.js is an app
// entry point that calls app.listen at module scope, so a test cannot require
// it without starting a server.

test('a report with counts renders the panel', () => {
  const html = evidencePanelHtml({ evidence: {
    searchesRun: 14, resultsReturned: 96, resultsRead: 71, distinctSites: 38,
    reviewsTotal: 3412, sourcesCounted: 5,
    reviewsSentence: renderEvidenceSentence({ reviewsTotal: 3412, sourcesCounted: 5 }),
  }});
  assert.ok(html.includes('Evidence base'), html.slice(0, 200));
  assert.ok(html.includes('14'), 'searches missing');
  assert.ok(html.includes('96'), 'returned missing');
  assert.ok(html.includes('71'), 'read missing');
  assert.ok(html.includes('38'), 'sites missing');
  assert.ok(html.includes('3,412'), 'the review volume is missing or unformatted');
});

test('BACK COMPATIBILITY: a stored report with no evidence renders nothing', () => {
  // Every report written before this release has no evidence block. They must
  // keep rendering exactly as they do today, or shipping this breaks every
  // existing customer link.
  assert.equal(evidencePanelHtml({}), '');
  assert.equal(evidencePanelHtml({ evidence: null }), '');
  assert.equal(evidencePanelHtml(null), '');
  assert.equal(evidencePanelHtml(undefined), '');
});

test('THE ZERO CASE: counts present, volumes not, renders counts and no sentence', () => {
  const html = evidencePanelHtml({ evidence: {
    searchesRun: 6, resultsReturned: 40, resultsRead: 30, distinctSites: 12,
    reviewsTotal: null, sourcesCounted: null, reviewsSentence: null,
  }});
  assert.ok(html.includes('Evidence base'));
  assert.ok(html.includes('30'));
  assert.ok(!html.includes('publish'), 'a sentence was rendered with no volumes: ' + html);
  assert.ok(!/\b0 reviews\b/.test(html), 'a zero was printed as a finding');
});

test('a count that is not a number is dropped, not printed as zero', () => {
  const html = evidencePanelHtml({ evidence: {
    searchesRun: 6, resultsReturned: null, resultsRead: undefined, distinctSites: 12,
  }});
  assert.ok(html.includes('Searches run'));
  assert.ok(html.includes('Distinct sites read'));
  assert.ok(!html.includes('Results returned'), 'a null count was rendered');
  assert.ok(!html.includes('Results read'), 'an undefined count was rendered');
});

test('nothing renderable at all produces an empty string, not an empty panel', () => {
  assert.equal(evidencePanelHtml({ evidence: { reviewsSentence: null } }), '');
});

test('the panel escapes what it prints', () => {
  const html = evidencePanelHtml({ evidence: {
    searchesRun: 1, reviewsSentence: 'x <script>alert(1)</script> & "q"',
  }});
  assert.ok(!html.includes('<script>'), 'unescaped markup reached the panel');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the panel avoids a page break, because it is a unit', () => {
  const html = evidencePanelHtml({ evidence: { searchesRun: 1 } });
  assert.ok(html.includes('ev-panel'), 'the class the print CSS targets is missing');
});

test('a sentence with no counts renders no empty grid element', () => {
  // A stored report has volumes but no counts. An empty <div class="ev-grid">
  // renders as a stray gap above the sentence.
  const html = evidencePanelHtml({ evidence: {
    reviewsSentence: renderEvidenceSentence({ reviewsTotal: 12135, sourcesCounted: 5 }),
  }});
  assert.ok(html.includes('12,135'));
  assert.ok(!html.includes('ev-grid'), 'an empty grid element was rendered: ' + html);
});
