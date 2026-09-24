// ════════════════════════════════════════════════════════════════════════════
// THE RVP REVIEW-COUNT AND RECENCY GATE (RVP_SAFEGUARDS_SPEC.md section 3,
// SUBJECT_INTEGRITY_STANDARD.md 1.1 and 1.2).
//
// THE QUANTITY IS THE SUBJECT'S OWN GOOGLE PLACES REVIEW COUNT
// (user_ratings_total from the focal findplacefromtext call). NOT
// evidence.reviewsTotal: that is a sum over the subject and every peer with a
// place id (lib-places-peers.js peerReviewVolumes), so a two-review restaurant
// in a busy street would pass on its neighbors' reviews.
//
//   refused-coverage  subjectReviewCount < MIN_SUBJECT_REVIEWS, or unknown
//   limited           subjectReviewCount < LIMITED_BELOW_REVIEWS, or the
//                     newest review is older than MAX_DAYS_SINCE_NEWEST_REVIEW
//   pass              otherwise
//
// RECENCY UNKNOWN DOES NOT DOWNGRADE. RVP fetches no review dates today (no
// Place Details call), so "unknown" is every run; marking every report limited
// for a date nobody read would be a claim about the business made from an
// absence in our own data.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewGate, REVIEW_GATE, refusalCopy, limitedNote } from '../lib-review-gate.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('the thresholds are named parameters with the spec values', () => {
  assert.equal(REVIEW_GATE.MIN_SUBJECT_REVIEWS, 50);
  assert.equal(REVIEW_GATE.LIMITED_BELOW_REVIEWS, 300);
  assert.equal(REVIEW_GATE.MAX_DAYS_SINCE_NEWEST_REVIEW, 180);
  // No review-platform count exists in RVP; the parameter is present and off.
  assert.equal(REVIEW_GATE.MIN_SOURCES, null);
});

test('REFUSED: below MIN_SUBJECT_REVIEWS', () => {
  const g = reviewGate({ subjectReviewCount: 49, newestReviewAt: null }, null, NOW);
  assert.equal(g.state, 'refused-coverage');
  assert.equal(g.reason, 'subject-reviews-below-minimum');
  assert.equal(g.subjectReviewCount, 49);
});

test('REFUSED: no count at all is refused, never passed', () => {
  for (const c of [null, undefined, 'many', -3, NaN]) {
    const g = reviewGate({ subjectReviewCount: c }, null, NOW);
    assert.equal(g.state, 'refused-coverage', String(c));
    assert.equal(g.reason, 'subject-reviews-unknown');
  }
});

test('LIMITED: at the minimum and below LIMITED_BELOW_REVIEWS', () => {
  assert.equal(reviewGate({ subjectReviewCount: 50 }, null, NOW).state, 'limited');
  const g = reviewGate({ subjectReviewCount: 299 }, null, NOW);
  assert.equal(g.state, 'limited');
  assert.equal(g.reason, 'subject-reviews-thin');
});

test('LIMITED: plenty of reviews but the newest is old', () => {
  const g = reviewGate({ subjectReviewCount: 2000, newestReviewAt: daysAgo(181) }, null, NOW);
  assert.equal(g.state, 'limited');
  assert.equal(g.reason, 'newest-review-old');
  assert.equal(g.recency, 'old');
});

test('PASS: enough reviews, recent or unknown recency', () => {
  const a = reviewGate({ subjectReviewCount: 300, newestReviewAt: daysAgo(10) }, null, NOW);
  assert.equal(a.state, 'pass'); assert.equal(a.recency, 'recent');
  const b = reviewGate({ subjectReviewCount: 5000, newestReviewAt: null }, null, NOW);
  assert.equal(b.state, 'pass'); assert.equal(b.recency, 'unknown');
});

test('thresholds can be overridden per call without changing the defaults', () => {
  assert.equal(reviewGate({ subjectReviewCount: 60 }, { MIN_SUBJECT_REVIEWS: 100 }, NOW).state, 'refused-coverage');
  assert.equal(REVIEW_GATE.MIN_SUBJECT_REVIEWS, 50);
});

test('REFUSAL COPY follows the standard skeleton, page and email closings differ', () => {
  const g = reviewGate({ subjectReviewCount: 12 }, null, NOW);
  const page = refusalCopy({ subject: 'Teclados', gate: g, channel: 'page' });
  assert.equal(page.heading, 'We cannot assess Teclados yet');
  assert.match(page.body.join(' '), /Google lists 12 reviews for Teclados\. The rule requires at least 50\./);
  // 2026-09-28: the refusal layout (test/refusal-layout.test.js pins every part).
  assert.match(page.body.join(' '), /This is not a judgment about the business\./);
  assert.match(page.body.join(' '), /You have not been charged, and no assessment was produced\./);
  assert.match(page.closing, /^If you would like one, email .+ and we will arrange it\.$/);
  const mail = refusalCopy({ subject: 'Teclados', gate: g, channel: 'email' });
  assert.equal(mail.closing, 'If you would like one, reply to this email and we will arrange it.');
  assert.doesNotMatch(page.body.join(' ') + page.heading + page.closing, /[–—]/);
});

test('the unknown-count refusal does not print a number it does not have', () => {
  const g = reviewGate({ subjectReviewCount: null }, null, NOW);
  const page = refusalCopy({ subject: 'Teclados', gate: g, channel: 'page' });
  assert.match(page.body[0], /Google lists no review count for Teclados\./);
  assert.doesNotMatch(page.body[0], /null|undefined|NaN/);
});

test('the LIMITED note names what is thin; a pass has no note', () => {
  assert.match(limitedNote({ subject: 'Teclados', gate: reviewGate({ subjectReviewCount: 120 }, null, NOW) }),
    /^Google lists 120 reviews for Teclados, fewer than 300\./);
  assert.match(limitedNote({ subject: 'Teclados', gate: reviewGate({ subjectReviewCount: 900, newestReviewAt: daysAgo(400) }, null, NOW) }),
    /more than 180 days old/);
  assert.equal(limitedNote({ subject: 'Teclados', gate: reviewGate({ subjectReviewCount: 900 }, null, NOW) }), null);
});
