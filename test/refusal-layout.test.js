// ════════════════════════════════════════════════════════════════════════════
// THE REFUSAL LAYOUT, THE SAME IN ALL THREE PRODUCTS (Simon, 2026-09-28, A2).
//
// Every refusal, coverage or identity, is built as five parts in this order:
//   heading      what did not happen, naming the subject
//   reason       the plain reason: what was read, the rule, and why
//   next         what happens next: nothing charged, and what the requester
//                can do themselves
//   consultant   the consultant route
//   closing      ONE line, chosen by medium (page or email)
// `body` is kept as the flattened reason, next and consultant, so a reader
// written before the layout still gets every sentence.
//
// RVP'S REASON IS ITS OWN (standard, section 5 row 14). An RVP coverage
// refusal is a thin Google review count on a place the requester CONFIRMED,
// so the SVP and EVP cause ("a name that public sources do not use") does not
// apply and is not printed here.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewGate, refusalCopy, noMatchCopy, CONTACT_ADDRESS } from '../lib-review-gate.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const PARTS = ['heading', 'reason', 'next', 'consultant', 'closing'];

test('THE COVERAGE REFUSAL HAS THE FIVE PARTS, IN ORDER, WITH RVP WORDING', () => {
  const c = refusalCopy({ subject: 'Teclados', gate: reviewGate({ subjectReviewCount: 12 }, null, NOW), channel: 'page' });
  assert.deepEqual(Object.keys(c).filter((k) => PARTS.includes(k)), PARTS);
  assert.equal(c.heading, 'We cannot assess Teclados yet');
  assert.deepEqual(c.reason, [
    'Google lists 12 reviews for Teclados. The rule requires at least 50. The rule is fixed in advance and is the same for every business.',
    'Reviews are the public record this assessment reads, and fewer than 50 is not enough to assess a business fairly. This is not a judgment about the business.',
  ]);
  assert.deepEqual(c.next, [
    'You have not been charged, and no assessment was produced.',
    'When Teclados has at least 50 reviews on Google, you can run the assessment again.',
  ]);
  assert.equal(c.consultant, 'A consultant-led assessment reads sources this scan cannot, including material behind logins, in other languages, and supplied by you.');
  assert.equal(c.closing, 'If you would like one, email ' + CONTACT_ADDRESS + ' and we will arrange it.');
  assert.doesNotMatch(JSON.stringify(c), /a name that public sources do not use/, 'the SVP and EVP cause does not apply to RVP');
});

test('the closing line is one per medium, and the flattened body carries every sentence', () => {
  const g = reviewGate({ subjectReviewCount: 12 }, null, NOW);
  const mail = refusalCopy({ subject: 'Teclados', gate: g, channel: 'email' });
  assert.equal(mail.closing, 'If you would like one, reply to this email and we will arrange it.');
  assert.deepEqual(mail.body, [...mail.reason, ...mail.next, mail.consultant]);
});

test('the unknown-count refusal does not print a number it does not have', () => {
  const c = refusalCopy({ subject: 'Teclados', gate: reviewGate({ subjectReviewCount: null }, null, NOW), channel: 'page' });
  assert.equal(c.reason[0], 'Google lists no review count for Teclados. The rule requires at least 50 reviews on Google. The rule is fixed in advance and is the same for every business.');
  assert.doesNotMatch(JSON.stringify(c), /null|undefined|NaN/);
});

test('THE IDENTITY REFUSAL (no Places match) HAS THE SAME FIVE PARTS', () => {
  const c = noMatchCopy('Nowhere Bistro', 'page');
  assert.deepEqual(Object.keys(c).filter((k) => PARTS.includes(k)), PARTS);
  assert.equal(c.heading, 'We could not find Nowhere Bistro on Google');
  assert.deepEqual(c.reason, ['We searched Google for the name and location you entered and found no matching business, so there is nothing to assess yet.']);
  assert.deepEqual(c.next, ['You have not been charged.', 'Check the spelling of the name and add the city and country, then try again.']);
  assert.equal(c.consultant, 'A consultant-led assessment does not depend on a Google listing.');
  assert.equal(c.closing, 'If you would like one, email ' + CONTACT_ADDRESS + ' and we will arrange it.');
  assert.equal(noMatchCopy('Nowhere Bistro', 'email').closing, 'If you would like one, reply to this email and we will arrange it.');
});

test('no refusal line carries a dash', () => {
  const all = JSON.stringify([
    refusalCopy({ subject: 'X', gate: reviewGate({ subjectReviewCount: 3 }, null, NOW), channel: 'page' }),
    refusalCopy({ subject: 'X', gate: reviewGate({ subjectReviewCount: null }, null, NOW), channel: 'email' }),
    noMatchCopy('X', 'page'), noMatchCopy('X', 'email')]);
  assert.doesNotMatch(all, /[\u2013\u2014]/);
});
