// ════════════════════════════════════════════════════════════════════════════
// v8.11.31: ONE SWAP PER ORDER.
//
// The 2026-09-20 buyer was delivered the wrong restaurant by a rule that was
// working correctly, and had no way to correct it. The recovery link existed
// but was only ever sent when NOTHING matched, and something had matched.
//
// So every paid delivery now carries the link, and the link does double duty:
//   recovery  the order delivered nothing, the subscriber row is a placeholder
//   swap      the order delivered something, and the buyer wants a different one
//
// THE SWAP IS SINGLE USE, and that is the assertion that matters. A link that
// can be replayed is a link that hands out one report per attempt to anybody
// who can guess an address, and the attempt counter alone does not stop a
// SUCCESSFUL replay: it only counts failures.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { swapLinkSentence, swapEligibility, SWAP_NOTE_PREFIX } from '../lib-pending.js';

const URL = 'https://example.invalid/recover?t=abc.def';

// v8.11.35: RESTATED because the COPY CHANGED, not because the test was wrong.
//
// The sentence used to end "use this link ... instead: <the full URL>", and
// this test pinned that, correctly, for v8.11.31. The link is now a button, so
// the sentence points at the button and the URL appears once underneath it in
// the fallback line. The assertion that matters is stronger than before: the
// sentence must contain NO link at all, which the old copy could not have
// satisfied.
test('the swap sentence points at the button and carries no link', () => {
  assert.equal(swapLinkSentence(URL),
    'Expected a different restaurant? If you completed the survey under another '
    + 'email address, use the button below within 14 days and we will send that '
    + 'report instead.');
  assert.ok(!swapLinkSentence(URL).includes(URL), 'the URL is still in the sentence');
  assert.ok(!/https?:\/\//.test(swapLinkSentence(URL)), 'the sentence still contains a link');
});

test('no url, no sentence: the email never shows a broken link', () => {
  for (const bad of [null, undefined, '', '   ']) {
    assert.equal(swapLinkSentence(bad), '');
  }
});

test('house style: no em-dash, no en-dash, US spelling', () => {
  const s = swapLinkSentence(URL);
  assert.ok(!/[–—]/.test(s), 'dash in the swap sentence');
  assert.ok(!/&mdash;|&ndash;/.test(s), 'dash entity in the swap sentence');
  assert.ok(!/\b(organise|recognise|colour|whilst|programme)\b/i.test(s));
});

// ── eligibility ────────────────────────────────────────────────────────────

test('a delivered order with no swap recorded may swap once', () => {
  const r = swapEligibility({ orderRow: { report_token: 'tok', notes: null } });
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'swap');
});

test('an order that has ALREADY swapped is refused', () => {
  const r = swapEligibility({ orderRow: { report_token: 'tok', notes: SWAP_NOTE_PREFIX + ' The Drum & Monkey' } });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'already-swapped');
});

test('a placeholder order is recovery, not swap, and is allowed', () => {
  const r = swapEligibility({ orderRow: { report_token: null, notes: null } });
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'recovery');
});

test('no order row at all is still allowed, as recovery', () => {
  // The table may be unreachable or the row may predate this release. Refusing
  // a buyer because we cannot find their receipt would be the wrong failure.
  for (const v of [null, undefined]) {
    const r = swapEligibility({ orderRow: v });
    assert.equal(r.allowed, true, 'a missing order row must not block recovery');
    assert.equal(r.mode, 'recovery');
  }
});

test('the swap note prefix is distinctive enough to match on', () => {
  assert.ok(SWAP_NOTE_PREFIX.length > 6);
  assert.ok(/^[A-Z]/.test(SWAP_NOTE_PREFIX));
  // and it must not collide with the recovery note the placeholder path writes
  assert.ok(!/^RECOVERED/.test(SWAP_NOTE_PREFIX));
});

test('a swapped note is detected wherever it sits in the notes field', () => {
  const r = swapEligibility({ orderRow: { report_token: 'tok',
    notes: 'INTERNAL TEST. ' + SWAP_NOTE_PREFIX + ' FarmShop. more text' } });
  assert.equal(r.allowed, false, 'a swap note after other text was missed');
});

test('eligibility is total', () => {
  for (const a of [undefined, null, {}, { orderRow: 42 }, { orderRow: 'x' }]) {
    let r;
    assert.doesNotThrow(() => { r = swapEligibility(a); }, 'threw on ' + JSON.stringify(a));
    assert.equal(typeof r.allowed, 'boolean');
  }
});
