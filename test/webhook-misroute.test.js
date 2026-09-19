// ════════════════════════════════════════════════════════════════════════════
// v8.11.23 [C3]: a misrouted webhook path is loud
//
// On 2026-09-19 the Wix automation was set to /payment-webhook<secret> with no
// slash. Express matched neither route, every sale 404ed at the edge, and this
// service logged NOTHING at all, because the handler was never entered. It was
// invisible for part of an afternoon and was found only by reading Railway's
// edge log after the fact.
//
// The tail of a misrouted path is very often the secret itself, glued on wrong,
// so only four characters and a length are ever reported.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { misroutedHint } from '../lib-pending.js';

// ── C3: the misrouted path ──────────────────────────────────────────────────

test('the real 2026-09-19 typo is detected', () => {
  const h = misroutedHint('/payment-webhook8a0cf97227e3cfb93019484213a991bea41b174ad22d66b2c7d0b99fd1ad6706');
  assert.equal(h.misrouted, true);
  assert.equal(h.hint, '8a0c');
});

test('only four characters are ever exposed', () => {
  const secretish = '/payment-webhook' + 'z'.repeat(64);
  const h = misroutedHint(secretish);
  assert.equal(h.hint.length, 4);
  assert.equal(h.hint, 'zzzz');
  assert.ok(!h.hint.includes('zzzzz'), 'the hint must not grow with the input');
});

test('the hint never contains the whole tail', () => {
  const tail = 'abcdefghijklmnop';
  const h = misroutedHint('/payment-webhook' + tail);
  assert.ok(!(h.hint + '').includes(tail), 'the full value must never appear');
  assert.equal(h.tailLength, tail.length, 'the LENGTH is safe to report and is useful');
});

test('the two real routes are not misroutes', () => {
  assert.equal(misroutedHint('/payment-webhook').misrouted, false);
  assert.equal(misroutedHint('/payment-webhook/abcd1234').misrouted, false);
});

test('a trailing slash alone is the bare route, not a misroute', () => {
  assert.equal(misroutedHint('/payment-webhook/').misrouted, false);
});

test('a path that merely contains the word is not a misroute', () => {
  assert.equal(misroutedHint('/api/payment-webhook-status').misrouted, false);
  assert.equal(misroutedHint('/health').misrouted, false);
});

test('a deeper path IS a misroute, because no route matches it', () => {
  // /payment-webhook/:secret matches one segment only, so this 404s today and
  // would have been just as silent.
  const h = misroutedHint('/payment-webhook/abcd/extra');
  assert.equal(h.misrouted, true);
  assert.equal(h.hint, 'abcd');
});

test('misroutedHint never throws on junk', () => {
  for (const p of [null, undefined, '', 123, {}, []]) {
    assert.doesNotThrow(() => misroutedHint(p));
    assert.equal(misroutedHint(p).misrouted, false);
  }
});

