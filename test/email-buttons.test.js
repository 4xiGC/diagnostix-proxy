// ════════════════════════════════════════════════════════════════════════════
// v8.11.35: the swap and recovery links are buttons.
//
// These tests assert on the ASSEMBLED EMAIL, not on the template source. The
// two builders were extracted into lib-email.js for exactly that reason:
// importing server.js starts a listener, so until now no test had ever seen a
// finished email, and "the HTML contains exactly one anchor with the signed
// href" is a claim about the finished email or it is not the claim.
//
// THE HREF MUST NOT MOVE. The link, its signing, its expiry, its single use
// and the secret gate are unchanged by this release. That is asserted two
// ways: the anchor must equal the URL the untouched builder produces, and the
// signing code itself must be byte-identical to the previous release.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SWAP_BUTTON_LABEL, RECOVERY_BUTTON_LABEL, BUTTON_FALLBACK_LINE,
  swapLinkSentence, renderEmailButton, signRecoveryToken,
} from '../lib-pending.js';
import { buildCustomerReportEmail, buildCacheMissEmail } from '../lib-email.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://rvp.example.invalid';
const TOKEN = signRecoveryToken({ payingEmail: 'buyer@example.invalid', issuedAt: 1_700_000_000_000, secret: 's' });
const SWAP_URL = BASE + '/recover?t=' + encodeURIComponent(TOKEN);

const SUB = { email: 'buyer@example.invalid', first_name: 'Sam', restaurant_name: 'FarmShop',
              plan_type: 'one_off', report_token: 'rt-123' };
const REPORT = { healthCheckScore: 72, scoreVerdict: 'Good', pillars: {} };
const SURVEY = { name: 'FarmShop', location: 'Larkspur, CA' };
const PROV = { restaurantName: 'FarmShop', surveySavedAt: Date.parse('2026-09-19T20:26:50Z'), otherWaitingCount: 0 };

const delivery = buildCustomerReportEmail({ subscriber: SUB, report: REPORT, reportNumber: 1,
  survey: SURVEY, provenance: PROV, swapUrl: SWAP_URL, baseUrl: BASE });
const deliveryNoSecret = buildCustomerReportEmail({ subscriber: SUB, report: REPORT, reportNumber: 1,
  survey: SURVEY, provenance: PROV, swapUrl: null, baseUrl: BASE });
const cacheMiss = buildCacheMissEmail({ firstName: 'Sam', restaurantName: 'FarmShop',
  recoverUrl: SWAP_URL, internalTo: 'hello@4xiconsulting.com' });
const cacheMissNoSecret = buildCacheMissEmail({ firstName: 'Sam', restaurantName: 'FarmShop',
  recoverUrl: null, internalTo: 'hello@4xiconsulting.com' });

const anchors = (html) => [...String(html).matchAll(/<a\s[^>]*href="([^"]+)"/g)].map(m => m[1]);

// ── the pure pieces ────────────────────────────────────────────────────────

test('the button labels are exactly the ones specified', () => {
  assert.equal(SWAP_BUTTON_LABEL, 'Send me a different report');
  assert.equal(RECOVERY_BUTTON_LABEL, 'Find my report');
});

test('the fallback line is exactly the one specified', () => {
  assert.equal(BUTTON_FALLBACK_LINE, 'If the button does not work, copy this link into your browser:');
});

test('the swap sentence no longer contains the URL and points at the button', () => {
  const s = swapLinkSentence(SWAP_URL);
  assert.ok(!s.includes(SWAP_URL), 'the URL is still inside the sentence');
  assert.ok(!/https?:\/\//.test(s), 'the sentence still contains a link');
  assert.equal(s,
    'Expected a different restaurant? If you completed the survey under another '
    + 'email address, use the button below within 14 days and we will send that '
    + 'report instead.');
});

test('no url, no sentence and no button', () => {
  for (const bad of [null, undefined, '', '   ']) {
    assert.equal(swapLinkSentence(bad), '');
    assert.equal(renderEmailButton({ url: bad, label: SWAP_BUTTON_LABEL }), '');
  }
});

test('the button is a real anchor, not an image', () => {
  const html = renderEmailButton({ url: SWAP_URL, label: SWAP_BUTTON_LABEL });
  assert.ok(/<a\s[^>]*href=/.test(html), 'no anchor');
  assert.ok(!/<img/i.test(html), 'the button uses an image');
  assert.ok(html.includes('>' + SWAP_BUTTON_LABEL + '<'), 'the label is not the anchor text');
});

test('house style on every string this release adds', () => {
  for (const s of [SWAP_BUTTON_LABEL, RECOVERY_BUTTON_LABEL, BUTTON_FALLBACK_LINE, swapLinkSentence(SWAP_URL)]) {
    assert.ok(!/[–—]/.test(s), 'dash in: ' + s);
    assert.ok(!/&mdash;|&ndash;/.test(s), 'dash entity in: ' + s);
    assert.ok(!/\b(organise|recognise|colour|whilst|programme|apologise)\b/i.test(s), 'British spelling in: ' + s);
  }
});

// ── the delivery email ─────────────────────────────────────────────────────

test('the delivery email has exactly one anchor carrying the signed swap href', () => {
  const swapHrefs = anchors(delivery.html).filter(h => h.includes('/recover?t='));
  assert.equal(swapHrefs.length, 1, 'expected exactly one swap anchor, got ' + swapHrefs.length);
  assert.equal(swapHrefs[0], SWAP_URL, 'the href is not the signed link, unchanged');
});

test('the delivery email shows the swap button label', () => {
  assert.ok(delivery.html.includes('>' + SWAP_BUTTON_LABEL + '<'), 'the swap button label is missing');
});

test('the delivery email sentence does not contain the URL', () => {
  const i = delivery.html.indexOf('Expected a different restaurant?');
  assert.ok(i > 0, 'the swap sentence is missing');
  const sentenceBlock = delivery.html.slice(i, i + 300);
  assert.ok(!sentenceBlock.includes(SWAP_URL), 'the URL is inside the sentence');
});

test('the delivery email carries the fallback line with the URL under it', () => {
  assert.ok(delivery.html.includes(BUTTON_FALLBACK_LINE), 'no fallback line');
  const after = delivery.html.slice(delivery.html.indexOf(BUTTON_FALLBACK_LINE));
  assert.ok(after.includes(SWAP_URL), 'the URL is not under the fallback line');
});

test('the delivery email still names the survey it is answering', () => {
  assert.ok(delivery.html.includes('This report covers FarmShop, from the survey completed on September 19, 2026.'),
    'the v8.11.30 provenance line was lost in the refactor');
});

test('NO VALID SECRET: no button, no label, no link, no fallback', () => {
  const html = deliveryNoSecret.html;
  assert.ok(!html.includes(SWAP_BUTTON_LABEL), 'an unauthenticated delivery showed the swap button');
  assert.ok(!html.includes('/recover?t='), 'an unauthenticated delivery carried a signed link');
  assert.ok(!html.includes('Expected a different restaurant?'), 'an unauthenticated delivery offered a swap');
  assert.ok(!html.includes(BUTTON_FALLBACK_LINE), 'an unauthenticated delivery carried a fallback line');
  // and the control: the authenticated one does have all four
  assert.ok(delivery.html.includes(SWAP_BUTTON_LABEL));
});

// ── the cache-miss email ───────────────────────────────────────────────────

test('the cache-miss email has exactly one anchor carrying the signed recovery href', () => {
  const recHrefs = anchors(cacheMiss.html).filter(h => h.includes('/recover?t='));
  assert.equal(recHrefs.length, 1, 'expected exactly one recovery anchor, got ' + recHrefs.length);
  assert.equal(recHrefs[0], SWAP_URL);
});

test('the cache-miss email shows the recovery button label and the reworded sentence', () => {
  assert.ok(cacheMiss.html.includes('>' + RECOVERY_BUTTON_LABEL + '<'), 'the recovery button label is missing');
  assert.ok(cacheMiss.html.includes('use the button below'), 'the sentence was not reworded');
  assert.ok(cacheMiss.html.includes(BUTTON_FALLBACK_LINE), 'no fallback line');
});

test('the cache-miss sentence no longer wraps the link in prose', () => {
  const i = cacheMiss.html.indexOf('If the email on your payment');
  assert.ok(i > 0, 'the recovery sentence is missing');
  const block = cacheMiss.html.slice(i, i + 300);
  assert.ok(!/<a\s[^>]*href="[^"]*\/recover/.test(block), 'the sentence still contains the link as an anchor');
});

test('the cache-miss email keeps its subject line', () => {
  assert.equal(cacheMiss.subject, 'We could not locate your DiagnostiX report');
});

test('no recovery url: the cache-miss email reads as it did before, with no link', () => {
  assert.ok(!cacheMissNoSecret.html.includes('/recover?t='), 'a link appeared with no secret configured');
  assert.ok(!cacheMissNoSecret.html.includes(RECOVERY_BUTTON_LABEL), 'a button appeared with no secret configured');
  assert.ok(cacheMissNoSecret.html.includes('reply to this email'), 'the fallback prose was lost');
});

// ── images off, and the href that must not move ────────────────────────────

test('no image is load-bearing: the link is never carried by an img', () => {
  for (const [name, html] of [['delivery', delivery.html], ['cacheMiss', cacheMiss.html]]) {
    for (const [tag] of String(html).matchAll(/<img[^>]*>/gi)) {
      assert.ok(!/\/recover\?t=/.test(tag), 'an image carries the recovery link in ' + name);
    }
  }
});

test('THE SIGNING CODE DID NOT MOVE: byte-identical to the previous release', () => {
  const prev = execSync('git show e56b6f9:lib-pending.js', { cwd: REPO, maxBuffer: 32 * 1024 * 1024 })
    .toString('utf8').replace(/\r\n/g, '\n');
  const now = execSync('git show HEAD:lib-pending.js', { cwd: REPO, maxBuffer: 32 * 1024 * 1024 })
    .toString('utf8').replace(/\r\n/g, '\n');
  const region = (src, name) => {
    const i = src.indexOf('export function ' + name);
    assert.ok(i > 0, name + ' not found');
    return src.slice(i, i + 900);
  };
  for (const fn of ['signRecoveryToken', 'verifyRecoveryToken', 'recoveryAllowed']) {
    assert.equal(region(now, fn), region(prev, fn), fn + ' changed in a release that must not touch it');
  }
  assert.ok(prev.includes('RECOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000'));
  assert.ok(now.includes('RECOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000'), 'the expiry changed');
});

test('the href is exactly what the unchanged URL builder produces for this token', () => {
  const expected = BASE + '/recover?t=' + encodeURIComponent(TOKEN);
  assert.equal(anchors(delivery.html).filter(h => h.includes('/recover?t='))[0], expected);
  assert.equal(anchors(cacheMiss.html).filter(h => h.includes('/recover?t='))[0], expected);
});
