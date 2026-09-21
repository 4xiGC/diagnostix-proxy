// ════════════════════════════════════════════════════════════════════════════
// v8.11.44: THE SERVED SURVEY PAGE CARRIES NO ANNUAL MARKUP.
//
// public/index.html carried a full Annual upsell panel, force-hidden with
// display:none !important, plus a commented-out Annual button on the paywall.
// Hidden is not absent. The panel was served to every visitor, in every page
// source, naming a $99.99/year plan that cannot be bought, with a "Subscribe
// now" button and the words "Auto-renews annually".
//
// Anyone reading the page source, and every crawler and every reader-mode
// extraction, saw a product that was retired in v8.10.0.
//
// NOTHING LIVE REFERENCED IT. The only reference to #annual-upsell outside the
// block itself is inside a comment in unlockFullReport(), so removing it
// breaks no handler. That is asserted here rather than assumed.
//
// These tests read the FILE THAT IS SERVED, because the page is static and
// express serves it from disk. Asserting on a template would be asserting on
// something no visitor receives.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = path.join(REPO, 'public', 'index.html');
const html = () => fs.readFileSync(PAGE, 'utf8');

// ── The strings that must not be served ───────────────────────────────────

test('THE SERVED PAGE CONTAINS NO ANNUAL UPSELL MARKUP', () => {
  const h = html();
  const forbidden = [
    ['id="annual-upsell"', /id="annual-upsell"/],
    ['$99.99', /99\.99/],
    ['Upgrade to Annual', /Upgrade to Annual/],
    ['Subscribe now', /Subscribe now/],
    ['Auto-renews annually', /Auto-renews annually/],
    ['subscribe annually', /subscribe annually/i],
  ];
  const left = [];
  for (const [label, re] of forbidden) if (re.test(h)) left.push(label);
  assert.deepEqual(left, [], 'still served: ' + left.join(', '));
});

test('no element carries the annual-upsell id in any form', () => {
  assert.doesNotMatch(html(), /annual-upsell/);
});

test('the word Annual does not appear in served markup outside a JS comment', () => {
  // The page is one file of markup and script. Strip /* */ and // comments and
  // HTML comments, then look at what is left: that is what a visitor gets.
  const stripped = html()
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  const hits = stripped.match(/\bAnnual\b|\bannual\b|99\.99/g) || [];
  assert.deepEqual(hits, [], 'live markup or script still says: ' + JSON.stringify(hits));
});

// ── Nothing live referenced it, and nothing live breaks ───────────────────

test('unlockFullReport does not reach for the removed element', () => {
  const h = html();
  const i = h.indexOf('function unlockFullReport');
  assert.ok(i > 0, 'unlockFullReport is gone, which is not this change');
  const body = h.slice(i, i + 2500);
  assert.doesNotMatch(body, /getElementById\(['"]annual-upsell['"]\)/,
    'a live handler still reaches for the removed element');
});

test('the one-off purchase path is untouched', () => {
  const h = html();
  assert.match(h, /Unlock Full Report/);
  assert.match(h, /\$49\.99/, 'the list price is no longer shown on the paywall');
  assert.match(h, /function unlockFullReport/);
  assert.match(h, /WIX_PAY_URL|WIX_FULL_URL|wix/i);
});

test('the survey itself is untouched', () => {
  const h = html();
  assert.ok(h.length > 40000, 'the page shrank far more than this change should: ' + h.length);
  assert.match(h, /id="p3"|end p3/, 'the paywall step markers are gone');
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the detector finds the block when it is present', () => {
  // The exact markup that was removed. If this does not trip every pattern,
  // the test above proves nothing.
  const block = '<div id="annual-upsell" style="display:none !important">'
    + '<div>Upgrade to Annual &mdash; $99.99/year</div>'
    + '<button onclick="unlockAnnual()">Subscribe now &mdash; $99.99/year</button>'
    + '<div>Auto-renews annually &middot; Cancel anytime</div></div>';
  for (const re of [/id="annual-upsell"/, /99\.99/, /Upgrade to Annual/,
    /Subscribe now/, /Auto-renews annually/, /annual-upsell/]) {
    assert.match(block, re, 'the detector missed ' + re);
  }
});

test('CONTROL: the comment stripper does not swallow the whole page', () => {
  const stripped = html()
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.ok(stripped.length > 30000,
    'stripping comments left almost nothing, so the scan above scanned almost nothing: '
    + stripped.length);
  assert.match(stripped, /Unlock Full Report/, 'the stripper removed live markup');
});
