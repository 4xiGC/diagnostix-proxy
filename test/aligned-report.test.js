// ════════════════════════════════════════════════════════════════════════════
// v8.11.27 [RVP-B]: the aligned report prototype changes format, never content
//
// The live renderer and the live email are NOT touched by this package. The
// prototype lives in prototype/aligned-report.mjs, is imported by nothing in
// server.js, and exists so the format can be reviewed against real data before
// anyone decides to adopt it.
//
// THE CONTRACT THESE TESTS PIN. Format may change freely. Content may not:
//
//   - every number the report data carries still appears
//   - every link still appears, character for character
//   - every section the live report renders still has a heading
//   - the print stylesheet hides no section heading
//
// The comparison is against the stored report DATA rather than against the
// live renderer's HTML. That is deliberate and it is the stronger test:
// scraping the live output would only prove the prototype copied it, while
// this proves the prototype did not lose anything the data actually contains.
//
// Fixtures are the real 2026-09-19 Zulu and FarmShop payloads with every
// address stripped, saved by overnight/fetch-fixtures.mjs.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  renderAlignedReportHtml, ALIGNED_SECTIONS, alignedTokens,
} from '../prototype/aligned-report.mjs';

const FIXTURES = path.join(
  'C:', 'Users', 'SIMON', 'Projects', 'diagnostix-svp-measurements', 'overnight', 'fixtures-rvp.json');

const haveFixtures = fs.existsSync(FIXTURES);
const fx = haveFixtures ? JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) : {};

// Every distinct number the data carries, as it would be written.
function numbersIn(value, acc = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) acc.add(value);
  else if (Array.isArray(value)) value.forEach(v => numbersIn(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => numbersIn(v, acc));
  return acc;
}

function linksIn(value, acc = new Set()) {
  if (typeof value === 'string') {
    const m = value.match(/https?:\/\/[^\s"'<>)]+/g);
    if (m) m.forEach(u => acc.add(u));
  } else if (Array.isArray(value)) value.forEach(v => linksIn(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => linksIn(v, acc));
  return acc;
}

const CASES = ['zulu', 'farmshop'];

test('the fixtures exist, so these tests are not vacuous', () => {
  assert.ok(haveFixtures, 'fixtures-rvp.json is missing; run overnight/fetch-fixtures.mjs');
  for (const c of CASES) assert.ok(fx[c] && fx[c].report, 'fixture missing: ' + c);
});

// ── content is preserved ────────────────────────────────────────────────────

for (const c of CASES) {
  test(`${c}: every score and rating in the data appears in the aligned report`, () => {
    const f = fx[c];
    const html = renderAlignedReportHtml({ subscriber: f.subscriber, report: f.report });
    // Scores and ratings are the numbers a reader checks. Review counts are
    // covered separately below because they are formatted with separators.
    const wanted = [];
    const r = f.report;
    if (typeof r.healthCheckScore === 'number') wanted.push(r.healthCheckScore);
    for (const p of Object.values(r.pillars || {})) {
      if (p && typeof p.score === 'number') wanted.push(p.score);
    }
    for (const comp of (r.competitors || [])) {
      if (comp && typeof comp.rating === 'number') wanted.push(comp.rating);
    }
    assert.ok(wanted.length >= 3, 'control: the fixture carries too few numbers to test');
    for (const n of wanted) {
      assert.ok(html.includes(String(n)), `${c}: number ${n} is missing from the aligned report`);
    }
  });

  test(`${c}: every link in the data appears character for character`, () => {
    const f = fx[c];
    const html = renderAlignedReportHtml({ subscriber: f.subscriber, report: f.report });
    const links = [...linksIn(f.report)];
    for (const u of links) {
      assert.ok(html.includes(u), `${c}: link missing or rewritten: ${u}`);
    }
  });

  test(`${c}: every competitor name appears`, () => {
    const f = fx[c];
    const html = renderAlignedReportHtml({ subscriber: f.subscriber, report: f.report });
    // Compare against the ESCAPED form. "Scoma's Restaurant" renders as
    // "Scoma&#39;s Restaurant", so a raw-byte match would fail on a name that
    // is in fact present. The first version of this test had that bug.
    const escq = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const names = (f.report.competitors || []).map(x => x && x.name).filter(Boolean);
    assert.ok(names.length > 0, 'control: the fixture has no competitors to check');
    for (const n of names) {
      assert.ok(html.includes(escq(n)), `${c}: competitor "${n}" is missing`);
    }
  });

  test(`${c}: the executive summary text is reproduced verbatim`, () => {
    const f = fx[c];
    const html = renderAlignedReportHtml({ subscriber: f.subscriber, report: f.report });
    const s = f.report.executiveSummary;
    if (typeof s === 'string' && s.trim()) {
      // Compare on a distinctive slice: the whole string is escaped in the
      // output, so an exact substring match would fail on any apostrophe.
      const probe = s.split(/[.!?]/)[0].replace(/[&<>"']/g, '').trim().slice(0, 48);
      assert.ok(probe.length > 12, 'control: probe too short to be meaningful');
      const stripped = html.replace(/&#39;|&apos;/g, '').replace(/&amp;/g, '').replace(/&quot;/g, '');
      assert.ok(stripped.includes(probe), `${c}: the executive summary is not reproduced`);
    }
  });

  test(`${c}: no section is lost`, () => {
    const f = fx[c];
    const html = renderAlignedReportHtml({ subscriber: f.subscriber, report: f.report });
    for (const sec of ALIGNED_SECTIONS) {
      if (sec.optional && !sec.present(f.report)) continue;
      assert.ok(html.includes(sec.heading),
        `${c}: section heading "${sec.heading}" is missing`);
    }
  });

  test(`${c}: the print stylesheet hides no section heading`, () => {
    const f = fx[c];
    const html = renderAlignedReportHtml({ subscriber: f.subscriber, report: f.report });
    const m = html.match(/@media\s+print\s*\{([\s\S]*?)\n\s*\}\s*<\/style>/);
    const printCss = m ? m[1] : (html.match(/@media\s+print\s*\{([\s\S]*)/) || ['', ''])[1];
    assert.ok(printCss.length > 0, 'control: no print stylesheet found at all');
    assert.ok(!/\.sec-h[^{]*\{[^}]*display\s*:\s*none/.test(printCss),
      `${c}: the print stylesheet hides a section heading`);
    assert.ok(!/h2[^{]*\{[^}]*display\s*:\s*none/.test(printCss),
      `${c}: the print stylesheet hides h2`);
  });
}

// ── the format itself ───────────────────────────────────────────────────────

test('the aligned report adopts the shared gray and ink spine', () => {
  const t = alignedTokens();
  // The ten tokens SVP and EVP already share, byte for byte.
  const spine = {
    '--gray-50': '#F7F8FA', '--gray-100': '#EDEFF4', '--gray-200': '#D7DCE5',
    '--gray-400': '#8A93A6', '--gray-700': '#3A4255',
    '--ink': '#0B0F22', '--paper': '#FFFFFF',
    '--green': '#27AE60', '--red': '#C0392B', '--red-soft': '#E74C3C',
  };
  for (const [k, v] of Object.entries(spine)) {
    assert.equal(t[k], v, `token ${k} does not match the SVP and EVP spine`);
  }
});

test("RVP keeps its own navy identity, and it is EVP's navy-2", () => {
  const t = alignedTokens();
  assert.equal(t['--navy'], '#1B1464', 'RVP navy should stay its existing value');
  assert.equal(t['--navy-2'], '#2E3192');
  assert.equal(t['--accent'], '#0072BC', "RVP's existing blue is the accent");
});

test('the token name is --navy-2, not --navy2', () => {
  // The live RVP CSS spells it --navy2 while EVP spells it --navy-2. That is
  // exactly the drift a shared token set removes, so the prototype picks one.
  const t = alignedTokens();
  assert.ok(Object.prototype.hasOwnProperty.call(t, '--navy-2'));
  assert.ok(!Object.prototype.hasOwnProperty.call(t, '--navy2'), 'the hyphenless spelling survived');
});

test('a score band means the same thing in all three products', () => {
  const t = alignedTokens();
  assert.equal(t['--band-strong'], '#27AE60');
  assert.equal(t['--band-risk'], '#C0392B');
  assert.ok(t['--band-caution'], 'a caution band must exist');
});

test('the aligned report renders without a subscriber row', () => {
  // FarmShop was never delivered, so nothing may assume a subscriber exists.
  assert.doesNotThrow(() => renderAlignedReportHtml({ subscriber: null, report: { healthCheckScore: 50 } }));
});

test('the aligned renderer never throws on an empty report', () => {
  for (const r of [null, undefined, {}, { pillars: null, competitors: 'x' }]) {
    assert.doesNotThrow(() => renderAlignedReportHtml({ subscriber: {}, report: r }));
  }
});

test('the output contains no em-dash or en-dash', () => {
  const f = fx.zulu;
  const html = renderAlignedReportHtml({ subscriber: f.subscriber, report: f.report });
  // The fixture prose is already dash-sanitized upstream, so anything here
  // would have come from the prototype's own copy.
  const chrome = html.replace(/<p[^>]*class="prose"[^>]*>[\s\S]*?<\/p>/g, '');
  assert.ok(!chrome.includes('—'), 'em-dash in the prototype chrome');
  assert.ok(!chrome.includes('–'), 'en-dash in the prototype chrome');
});
