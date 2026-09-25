// ════════════════════════════════════════════════════════════════════════════
// THE EVIDENCE LINE LEADS WITH THE RESTAURANT'S OWN GOOGLE COUNT (2026-09-29,
// recommendation 4 and Q21).
//
// The panel said "The sources read for this assessment publish 10,461 reviews
// and ratings between them" on Orchid 94a649d8, whose own Google count is 648.
// evidence.reviewsTotal sums the subject AND its peers (peerReviewVolumes), so
// the first number an owner can check was not about them.
//
// Now: the restaurant's own count first, the peers' count separately and
// labeled. Stored reports are re-rendered from their stored figures
// (coverage.subjectReviewCount, else _debug.googlePlaces.focalReviewCount when
// the focal place id was counted), never estimated. A report that cannot be
// split keeps its total, now labeled as including the comparable restaurants.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

const { splitReviewVolumes, renderSubjectFirstSentence, evidencePanelHtml } = await import('../lib-evidence.js');

const ORCHID = {
  evidence: { searchesRun: 9, resultsReturned: 87, resultsRead: 72, distinctSites: 29, reviewsTotal: 10461, sourcesCounted: 5,
    reviewsSentence: 'The sources read for this assessment publish 10,461 reviews and ratings between them. DiagnostiX reads the public summary of each source, not every individual review.' },
  coverage: { state: 'pass', subjectReviewCount: 648 },
  _debug: { googlePlaces: { focalReviewCount: 648, focalPlaceIdPresent: true, volumesCountedFrom: 'place-id-only' } },
  subject: { name: 'Orchid Restaurant at the Studley Hotel' },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test('THE SPLIT: the subject 648, the four peers 9,813, from the stored figures', () => {
  assert.deepEqual(splitReviewVolumes(ORCHID), { subjectReviews: 648, peerReviews: 9813, peersCounted: 4 });
});

test('THE SENTENCE: the restaurant first, the peers separately and labeled', () => {
  const s = renderSubjectFirstSentence({ subjectName: 'Orchid Restaurant at the Studley Hotel', subjectReviews: 648, peerReviews: 9813, peersCounted: 4 });
  assert.equal(s, 'Google lists 648 reviews for Orchid Restaurant at the Studley Hotel. '
    + 'The 4 comparable restaurants read alongside it list 9,813 between them. '
    + 'DiagnostiX reads the public summary of each source, not every individual review.');
});

test('one peer is singular; no peer counted means the peers sentence is left out', () => {
  assert.match(renderSubjectFirstSentence({ subjectName: 'X', subjectReviews: 120, peerReviews: 816, peersCounted: 1 }),
    /The comparable restaurant read alongside it lists 816\. /);
  const none = renderSubjectFirstSentence({ subjectName: 'X', subjectReviews: 120, peerReviews: 0, peersCounted: 0 });
  assert.equal(none, 'Google lists 120 reviews for X. DiagnostiX reads the public summary of each source, not every individual review.');
});

test('THE PANEL on a STORED report prints the split, not the stored total sentence', () => {
  const html = evidencePanelHtml(ORCHID);
  assert.ok(html.includes('Google lists 648 reviews for Orchid Restaurant at the Studley Hotel.'), html);
  assert.ok(html.includes('list 9,813 between them'), html);
  assert.ok(!html.includes('10,461'), 'the combined total still leads the panel');
  const i = html.indexOf('648'), j = html.indexOf('9,813');
  assert.ok(i > 0 && j > i, 'the own count is not first');
});

test('the focal count from _debug is used when the coverage block predates it', () => {
  const r = clone(ORCHID); delete r.coverage;
  assert.deepEqual(splitReviewVolumes(r), { subjectReviews: 648, peerReviews: 9813, peersCounted: 4 });
});

test('NO SPLIT WITHOUT PROOF the focal count is inside the total: the total stays, labeled', () => {
  const r = clone(ORCHID); delete r.coverage; r._debug.googlePlaces.focalPlaceIdPresent = false;
  assert.equal(splitReviewVolumes(r), null);
  const html = evidencePanelHtml(r);
  assert.ok(html.includes('The sources read for this assessment, including the comparable restaurants read alongside it, publish 10,461 reviews and ratings between them.'), html);
});

test('a split that does not add up is refused (a subject count larger than the total)', () => {
  const r = clone(ORCHID); r.coverage.subjectReviewCount = 20000;
  assert.equal(splitReviewVolumes(r), null);
});

test('CONTROL: a report with no evidence block still renders no panel', () => {
  assert.equal(evidencePanelHtml({}), '');
  assert.equal(evidencePanelHtml(null), '');
});

test('the subject name falls back to the name given, and is escaped', () => {
  const r = clone(ORCHID); delete r.subject;
  const html = evidencePanelHtml(r, 'Café <b>Nord</b>');
  assert.ok(html.includes('Google lists 648 reviews for Café &lt;b&gt;Nord&lt;/b&gt;.'), html);
});
