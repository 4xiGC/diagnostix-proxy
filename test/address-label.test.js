// ════════════════════════════════════════════════════════════════════════════
// v8.11.29: every address in a log line carries its LOCAL PART LENGTH.
//
// WHY THE DOMAIN ALONE WAS NOT ENOUGH. On 2026-09-20 a buyer paid from one
// gmail address while their survey sat under a different gmail address one
// letter shorter. Every line in the matching path printed "@gmail.com" on both
// sides of the comparison, so a log that was doing exactly what it was told
// showed a match between two addresses that were not the same. The length is
// the smallest addition that makes two addresses on one domain distinguishable
// without printing either of them.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { addrLabel, emailDomainOnly } from '../lib-webhook-log.js';

test('addrLabel prints the domain and the local part length', () => {
  assert.equal(addrLabel('abcdefghijkl@gmail.com'), '@gmail.com len=12');
  assert.equal(addrLabel('abcdefghijk@gmail.com'), '@gmail.com len=11');
});

test('THE INCIDENT: two addresses on one domain are now distinguishable', () => {
  const paying = addrLabel('abcdefghijkl@gmail.com');   // 12, the FarmShop address
  const survey = addrLabel('abcdefghijk@gmail.com');    // 11, the Drum & Monkey address
  assert.notEqual(paying, survey,
    'the two addresses in the 2026-09-20 incident must not produce the same label');
  // and the control: the old helper could NOT tell them apart
  assert.equal(emailDomainOnly('abcdefghijkl@gmail.com'), emailDomainOnly('abcdefghijk@gmail.com'),
    'control: if the domain-only helper distinguished these, this test proves nothing');
});

test('addrLabel never reveals the local part itself', () => {
  const out = addrLabel('verysecretname@example.com');
  assert.ok(!/verysecretname/.test(out), 'the local part leaked into the label');
  assert.ok(!/[a-z]{4,}@/.test(out.replace('@example.com', '')), 'something address-shaped leaked');
});

test('addrLabel is total: junk in, a label out, never a throw', () => {
  for (const v of [null, undefined, '', 'no-at-sign', '@nolocal.com', 'trailing@', 42, {}, []]) {
    let out;
    assert.doesNotThrow(() => { out = addrLabel(v); }, 'threw on ' + JSON.stringify(v));
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  }
});

test('an address with no local part reports len=0, not a domain that looks normal', () => {
  assert.equal(addrLabel('@nolocal.com'), '@nolocal.com len=0');
});

test('addrLabel lowercases and trims before measuring, as the matcher does', () => {
  assert.equal(addrLabel('  ABCDEFGHIJKL@GMail.COM  '), '@gmail.com len=12');
});
