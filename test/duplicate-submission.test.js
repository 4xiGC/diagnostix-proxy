// ════════════════════════════════════════════════════════════════════════════
// v8.11.33: the same survey submitted twice is one survey.
//
// On 2026-09-20 The Drum & Monkey was saved twice under one address, at
// 13:51:47 and 13:55:11, three minutes and twenty four seconds apart. Both
// rows are still unclaimed. A payment from that address would buy the newer
// one and strand the older one forever, and the buyer would be told "you have
// 1 other completed survey waiting" about a survey that is the same survey.
//
// SAMENESS IS BY PLACES ID WHERE THERE IS ONE, because a Places id is the
// identity of a restaurant and a name is not. "The Drum & Monkey" and
// "Drum and Monkey" are the same pub, and two different branches of a chain
// share a name and are not the same subject. Name and location are the
// fallback, and they are a weaker signal, which is why the window is short.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateSubmission, DUPLICATE_WINDOW_MS, DUPLICATE_CLAIM_LABEL } from '../lib-pending.js';

const T = 1_700_000_000_000;
const row = (o) => Object.assign({ id: 'r', saved_at: T, survey: { name: 'The Drum & Monkey', location: 'Harrogate' } }, o);

test('the window is ten minutes', () => {
  assert.equal(DUPLICATE_WINDOW_MS, 10 * 60 * 1000);
});

test('THE INCIDENT: the same restaurant 3m24s apart is a duplicate', () => {
  const older = row({ id: 'first', saved_at: T });
  const newer = row({ id: 'second', saved_at: T + 204_000 });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), true);
});

test('the same restaurant 11 minutes apart is NOT a duplicate', () => {
  const older = row({ id: 'first', saved_at: T });
  const newer = row({ id: 'second', saved_at: T + 11 * 60 * 1000 });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), false);
});

test('a matching Places id decides it, whatever the names say', () => {
  const older = row({ id: 'first', survey: { name: 'The Drum & Monkey', placeId: 'ChIJxyz', location: 'Harrogate' } });
  const newer = row({ id: 'second', saved_at: T + 60_000, survey: { name: 'Drum and Monkey', placeId: 'ChIJxyz', location: 'Harrogate, North Yorkshire' } });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), true);
});

test('DIFFERENT Places ids are never a duplicate, however alike the names', () => {
  const older = row({ id: 'first', survey: { name: 'Pizza Express', placeId: 'ChIJaaa', location: 'Harrogate' } });
  const newer = row({ id: 'second', saved_at: T + 60_000, survey: { name: 'Pizza Express', placeId: 'ChIJbbb', location: 'Harrogate' } });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), false,
    'two branches of one chain share a name and are not the same restaurant');
});

test('with no Places id, the name is normalized before comparing', () => {
  const older = row({ id: 'first', survey: { name: 'The Drum & Monkey', location: 'Harrogate' } });
  const newer = row({ id: 'second', saved_at: T + 60_000, survey: { name: '  the  DRUM and monkey ', location: 'harrogate' } });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), true);
});

test('with no Places id, a different location is not a duplicate', () => {
  const older = row({ id: 'first', survey: { name: 'The Drum & Monkey', location: 'Harrogate' } });
  const newer = row({ id: 'second', saved_at: T + 60_000, survey: { name: 'The Drum & Monkey', location: 'York' } });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), false);
});

test('a different restaurant in the window is not a duplicate', () => {
  const older = row({ id: 'first', survey: { name: 'FarmShop', location: 'Harrogate' } });
  const newer = row({ id: 'second', saved_at: T + 60_000, survey: { name: 'The Drum & Monkey', location: 'Harrogate' } });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), false);
});

test('an already claimed row is never superseded', () => {
  const older = row({ id: 'first', claimed_at: '2026-09-20T00:00:00Z' });
  const newer = row({ id: 'second', saved_at: T + 60_000 });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), false,
    'a row that has already been sold must not be relabelled as a duplicate');
});

test('a row is never a duplicate of itself', () => {
  const r = row({ id: 'same' });
  assert.equal(isDuplicateSubmission({ existing: r, incoming: r }), false);
});

test('a blank name never matches another blank name', () => {
  const older = row({ id: 'first', survey: { name: '', location: '' } });
  const newer = row({ id: 'second', saved_at: T + 60_000, survey: { name: '   ', location: null } });
  assert.equal(isDuplicateSubmission({ existing: older, incoming: newer }), false,
    'two unnamed surveys are unknown, not identical');
});

test('the claim label says what happened and is distinct from the others', () => {
  assert.equal(DUPLICATE_CLAIM_LABEL, 'superseded-duplicate');
  for (const other of ['exact', 'inferred', 'recovery', 'swap']) {
    assert.notEqual(DUPLICATE_CLAIM_LABEL, other);
  }
});

test('the check is total', () => {
  for (const a of [undefined, null, {}, { existing: null, incoming: null }, { existing: 1, incoming: 2 }]) {
    let r;
    assert.doesNotThrow(() => { r = isDuplicateSubmission(a); }, 'threw on ' + JSON.stringify(a));
    assert.equal(r, false, 'junk must answer false, never true');
  }
});
