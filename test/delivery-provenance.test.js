// ════════════════════════════════════════════════════════════════════════════
// v8.11.30: the delivery email says WHICH survey it is answering.
//
// On 2026-09-20 a buyer paid and received a report for FarmShop, a survey they
// had completed the previous evening, while the survey they had finished four
// minutes earlier sat unclaimed under a different address. The email did not
// say which restaurant it covered or when the survey had been taken, so the
// only way to discover the substitution was to open the report and read it.
//
// The rule is not "refuse when unsure". It is "always say what was delivered".
// A buyer who can see the restaurant name and the survey date in the first
// paragraph knows within one second whether they got what they paid for.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryProvenanceLines } from '../lib-pending.js';

const SEP19 = Date.parse('2026-09-19T20:26:50.666Z');

test('the first line names the restaurant and the survey date', () => {
  const lines = deliveryProvenanceLines({ restaurantName: 'FarmShop', surveySavedAt: SEP19 });
  assert.equal(lines[0], 'This report covers FarmShop, from the survey completed on September 19, 2026.');
});

test('no second line when nothing else is waiting', () => {
  const lines = deliveryProvenanceLines({ restaurantName: 'FarmShop', surveySavedAt: SEP19, otherWaitingCount: 0 });
  assert.equal(lines.length, 1);
});

test('one other survey waiting reads as singular', () => {
  const lines = deliveryProvenanceLines({ restaurantName: 'FarmShop', surveySavedAt: SEP19, otherWaitingCount: 1 });
  assert.equal(lines[1],
    'You have 1 other completed survey waiting under this address. '
    + 'Reply to this email and we will help you with those.');
});

test('two other surveys waiting reads as plural', () => {
  const lines = deliveryProvenanceLines({ restaurantName: 'FarmShop', surveySavedAt: SEP19, otherWaitingCount: 2 });
  assert.equal(lines[1],
    'You have 2 other completed surveys waiting under this address. '
    + 'Reply to this email and we will help you with those.');
});

test('house style: no em-dash, no en-dash, US spelling', () => {
  for (const n of [0, 1, 3]) {
    for (const l of deliveryProvenanceLines({ restaurantName: 'The Drum & Monkey', surveySavedAt: SEP19, otherWaitingCount: n })) {
      assert.ok(!/[–—]/.test(l), 'dash in: ' + l);
      assert.ok(!/&mdash;|&ndash;|&#821[12];/.test(l), 'dash entity in: ' + l);
      assert.ok(!/\b(organise|recognise|colour|apologise|whilst|programme)\b/i.test(l), 'British spelling in: ' + l);
    }
  }
});

test('the date is rendered in UTC, so it cannot drift with the server timezone', () => {
  // 00:30 UTC on the 20th is still the 19th in Santiago. The report states the
  // UTC date deliberately: the alternative is a date that changes depending on
  // which machine rendered the email.
  const justAfterMidnightUTC = Date.parse('2026-09-20T00:30:00Z');
  const lines = deliveryProvenanceLines({ restaurantName: 'X', surveySavedAt: justAfterMidnightUTC });
  assert.match(lines[0], /September 20, 2026/);
});

test('a missing or unusable date degrades to a sentence that is still true', () => {
  for (const bad of [null, undefined, NaN, 'not a date', 0]) {
    const lines = deliveryProvenanceLines({ restaurantName: 'FarmShop', surveySavedAt: bad });
    assert.equal(lines[0], 'This report covers FarmShop.',
      'a report with no usable survey date must still name the restaurant, got: ' + lines[0]);
  }
});

test('a missing restaurant name never produces a sentence with a hole in it', () => {
  for (const bad of [null, undefined, '', '   ']) {
    const lines = deliveryProvenanceLines({ restaurantName: bad, surveySavedAt: SEP19 });
    assert.ok(!/undefined|null|\{|\}/.test(lines[0]), 'placeholder leaked: ' + lines[0]);
    assert.equal(lines[0], 'This report covers the restaurant in your survey, from the survey completed on September 19, 2026.');
  }
});

test('the helper is total: junk in, usable sentences out', () => {
  for (const args of [undefined, null, {}, { otherWaitingCount: -3 }, { otherWaitingCount: 'x' }]) {
    let lines;
    assert.doesNotThrow(() => { lines = deliveryProvenanceLines(args); }, 'threw on ' + JSON.stringify(args));
    assert.ok(Array.isArray(lines) && lines.length >= 1);
    assert.equal(typeof lines[0], 'string');
  }
});

test('a negative or nonsense count never produces a waiting sentence', () => {
  for (const n of [-1, 0, null, undefined, 'two', NaN]) {
    const lines = deliveryProvenanceLines({ restaurantName: 'X', surveySavedAt: SEP19, otherWaitingCount: n });
    assert.equal(lines.length, 1, 'count ' + JSON.stringify(n) + ' produced a waiting sentence');
  }
});
