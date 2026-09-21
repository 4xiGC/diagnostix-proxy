// ════════════════════════════════════════════════════════════════════════════
// v8.11.45: STOP WRITING A PRICE NOBODY PAID.
//
// Three code paths wrote a hard-coded amount into subscribers.amount_paid:
// 24.99 for a one-off, 99.99 for the retired annual plan. Wix charges 49.99.
// Measured 2026-09-21: 99 rows at 24.99, 1 at 99.99, 0 null, 0 zero. Not one
// of them records a real amount, so sum(amount_paid) has never been true.
//
// The service cannot read what Wix charged, so amount_paid is written as NULL.
// The column is nullable, confirmed from the PostgREST schema, so no migration
// is involved.
//
// THE READER IS THE DANGEROUS HALF. amount_paid is read in exactly one place,
// the HubSpot push, as `subField('amount_paid','amountPaid') || 0`. The moment
// the column became null that would have stamped every contact with an amount
// paid of 0 US dollars, which is a worse claim than the wrong 24.99: zero says
// the customer paid nothing.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIST_PRICE_USD, listPriceLabel, amountPaidToWrite, isRealAmount,
  formatAmountPaid, hubspotAmountFields, AMOUNT_ABSENT_LABEL,
} from '../lib-price.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── The constant ──────────────────────────────────────────────────────────

test('there is ONE list price constant and it is 49.99', () => {
  assert.equal(LIST_PRICE_USD, 49.99);
  assert.equal(listPriceLabel(), '$49.99');
});

test('the constant agrees with the price printed on the survey page', () => {
  const page = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  assert.match(page, new RegExp('\\$' + String(LIST_PRICE_USD).replace('.', '\\.')),
    'the paywall button and the server constant disagree about the price');
});

// ── What is written ───────────────────────────────────────────────────────

test('amount_paid is written as NULL, never a literal', () => {
  assert.equal(amountPaidToWrite(), null);
  assert.notEqual(amountPaidToWrite(), 24.99);
  assert.notEqual(amountPaidToWrite(), 0);
  assert.notEqual(amountPaidToWrite(), LIST_PRICE_USD);
});

test('NO PATH IN server.js STILL WRITES 24.99', () => {
  const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  const hits = (src.match(/24\.99/g) || []);
  assert.deepEqual(hits, [], 'server.js still contains 24.99 ' + hits.length + ' time(s)');
});

test('no amount literal is written on any insert path', () => {
  const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.doesNotMatch(src, /amount_paid:\s*\d/, 'a numeric literal is assigned to amount_paid');
  assert.doesNotMatch(src, /amountPaid:\s*amountPaid\s*\|\|\s*0/, 'amountPaid still coerces to 0');
  assert.doesNotMatch(src, /amount_paid:\s*amountPaid\s*\|\|\s*0/, 'amount_paid still coerces to 0');
});

// ── isRealAmount, which everything else rests on ──────────────────────────

test('absent is not zero, and zero is not an amount', () => {
  for (const bad of [null, undefined, '', NaN, Infinity, -1, 0, '0', false, true, {}, []]) {
    assert.equal(isRealAmount(bad), false, JSON.stringify(String(bad)) + ' was treated as a real amount');
  }
  for (const good of [24.99, 49.99, 99.99, '49.99', 1]) {
    assert.equal(isRealAmount(good), true, JSON.stringify(good) + ' was rejected');
  }
});

// ── Readers: never 0, NaN or $0.00 ────────────────────────────────────────

test('a NULL amount formats as words, never as a number', () => {
  for (const absent of [null, undefined, '', NaN, 0]) {
    const s = formatAmountPaid(absent);
    assert.equal(s, AMOUNT_ABSENT_LABEL, JSON.stringify(String(absent)) + ' formatted as ' + s);
    assert.doesNotMatch(s, /\$?0(\.00)?\b/, 'printed a zero');
    assert.doesNotMatch(s, /NaN|null|undefined/);
  }
});

test('a real amount still formats as money', () => {
  assert.equal(formatAmountPaid(49.99), '$49.99');
  assert.equal(formatAmountPaid('24.99'), '$24.99');
});

test('HUBSPOT: a null amount sends NO PROPERTY, not a zero', () => {
  for (const sub of [{ amount_paid: null }, { amount_paid: undefined }, {}, { amountPaid: null }]) {
    const f = hubspotAmountFields(sub);
    assert.deepEqual(f, {}, 'sent ' + JSON.stringify(f) + ' for ' + JSON.stringify(sub));
    assert.ok(!('diagnostix_amount_paid_usd' in f));
  }
});

test('HUBSPOT: a real amount is still sent, in both row shapes', () => {
  assert.deepEqual(hubspotAmountFields({ amount_paid: 49.99 }), { diagnostix_amount_paid_usd: 49.99 });
  assert.deepEqual(hubspotAmountFields({ amountPaid: 24.99 }), { diagnostix_amount_paid_usd: 24.99 });
});

test('HUBSPOT: zero is treated as absent, because no order here was ever free', () => {
  assert.deepEqual(hubspotAmountFields({ amount_paid: 0 }), {});
});

test('THE HUBSPOT PUSH NO LONGER COERCES WITH || 0', () => {
  const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.doesNotMatch(src, /subField\('amount_paid',\s*'amountPaid'\)\s*\|\|\s*0/,
    'the || 0 coercion is still there, so a null amount becomes 0 in HubSpot');
  assert.match(src, /hubspotAmountFields/, 'the push does not use the guarded helper');
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the 24.99 scan can fail', () => {
  const fake = 'const amountPaid = planType === "annual" ? 99.99 : 24.99;';
  assert.match(fake, /24\.99/, 'the scan cannot see the literal it forbids');
});

test('CONTROL: the || 0 scan can fail', () => {
  const fake = "const amountPaidSafe = subField('amount_paid', 'amountPaid') || 0;";
  assert.match(fake, /subField\('amount_paid',\s*'amountPaid'\)\s*\|\|\s*0/,
    'the scan cannot see the coercion it forbids');
});

test('CONTROL: formatAmountPaid can return money, so the absent check means something', () => {
  assert.notEqual(formatAmountPaid(49.99), AMOUNT_ABSENT_LABEL);
});
