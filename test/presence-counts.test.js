// ════════════════════════════════════════════════════════════════════════════
// A COUNT IS A MEASUREMENT, AND ABSENCE IS NOT ZERO (Simon, 2026-11-18).
//
// Cases from the 2026-11-18 RVP comparison and stored reports:
//   La Mesa       Google record 589 reviews at 4.5; both models wrote "0 Google reviews"
//   Gen Tarleton  Google record 158; a run wrote "only 5 social media followers" (an
//                 unofficial page; the official one has 1,287)
//   Yelp scored 20 for "No meaningful Yelp presence found" (search found nothing)
// Fails on main afa304d: lib-presence.js does not exist, and the prompt carries no review
// count. The prompt half is read from server.js source, because the prompt is built inline.
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { googleRecordBlock, applyPresenceRules, cleanText } from '../lib-presence.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LA_MESA = { rating: 4.5, reviewCount: 589 };

test('the prompt carries the Google record, or says not available, and forbids unsupplied counts', () => {
  const b = googleRecordBlock(LA_MESA);
  assert.match(b, /Google rating: 4\.5/);
  assert.match(b, /Google review count: 589/);
  assert.match(b, /NEVER state a follower, fan or subscriber count/);
  assert.match(b, /"score": null and "note": "Not available"/);
  const none = googleRecordBlock({ rating: null, reviewCount: null });
  assert.match(none, /Google review count: not available/);
  // server.js sends it to the scoring pass and the summary, and lets a channel be null.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /\$\{googleRecordBlock\(googleRecord\)\}/);
  assert.match(src, /googleRecordBlock\(googleRecord \|\| \{\}\)/);
  assert.equal((src.match(/\$\{googleRecordBlock\(googleRecord\)\}/g) || []).length, 2, 'the scoring pass AND the second pass (strengths, risks, actions)');
  assert.equal((src.match(/"score":<integer 0-100, or null when the data says nothing about this channel>/g) || []).length, 6);
  assert.match(src, /applyPresenceRules\(report, googleRecord\)/);
});

test('a zero or wrong Google count is removed; the record stands; other platforms keep theirs', () => {
  const r = {
    onlinePresence: { overall: 68, channels: [
      { name: 'Google Business', score: 70, note: 'Listed with 4.5 rating but critically only 0 reviews shown.' },
      { name: 'TripAdvisor', score: 78, note: '55 reviews at 4.0 stars, ranked #451 of 3522.' },
    ] },
    risks: ['Limited review volume on Google (0 reviews reported) despite 4.0 TripAdvisor rating.', 'Sunday closures limit revenue.'],
    executiveSummary: 'La Mesa lands in the Good band overall. Google shows 0 reviews. TripAdvisor shows a 4.0 rating from 55 reviews.',
    strengths: ['Google lists 120 reviews at 4.5.'],
  };
  const changes = applyPresenceRules(r, LA_MESA);
  assert.equal(r.onlinePresence.channels[0].note, 'Rated 4.5 on Google from 589 reviews.');
  assert.equal(r.onlinePresence.channels[1].note, '55 reviews at 4.0 stars, ranked #451 of 3522.', 'TripAdvisor figures are not Google figures');
  assert.deepEqual(r.risks, ['Sunday closures limit revenue.']);
  assert.equal(r.executiveSummary, 'La Mesa lands in the Good band overall. TripAdvisor shows a 4.0 rating from 55 reviews.');
  assert.deepEqual(r.strengths, [], 'a Google count other than the record is removed');
  assert.ok(changes.some((c) => c.reason === 'google-zero'));
  assert.ok(changes.some((c) => c.reason === 'google-count-mismatch'));
});

test('no follower count survives: RVP holds no official social account', () => {
  const r = { risks: ['General Tarleton records only 5 social media followers, signaling minimal digital presence.'],
    competitiveInsight: 'Strong pub. Instagram shows 1.9k followers.' };
  applyPresenceRules(r, { rating: 4.7, reviewCount: 158 });
  assert.deepEqual(r.risks, []);
  assert.equal(r.competitiveInsight, 'Strong pub.');
});

test('a decimal rating is not a zero count (removed in error on the 2026-11-18 smoke run)', () => {
  const keep = 'TripAdvisor rating of 4.0 with only 55 reviews shows lower visibility or engagement on that platform compared to Google presence.';
  const r = { risks: [keep, 'Google shows 0 reviews despite a 4.5 rating.', 'Google: reviews 0 so far.',
    'Limited review volume (55 on TripAdvisor, 0 on Google Maps) relative to nearby competitors.'] };
  applyPresenceRules(r, LA_MESA);
  assert.deepEqual(r.risks, [keep]);
});

test('advice about influencers keeps its follower range; a claim about the subject does not', () => {
  const r = { actions: [{ desc: 'Partner with 3-5 Santiago food/lifestyle micro-influencers (10k-100k followers) for hosted dinners.' }],
    risks: ['Limited social media footprint (873 Instagram followers) underutilizes brand equity.'] };
  applyPresenceRules(r, LA_MESA);
  assert.equal(r.actions[0].desc, 'Partner with 3-5 Santiago food/lifestyle micro-influencers (10k-100k followers) for hosted dinners.');
  assert.deepEqual(r.risks, []);
});

test('absent channel data is Not available, outside the overall, never a low score', () => {
  const r = { onlinePresence: { overall: 54, channels: [
    { name: 'Google Business', score: 78, note: 'Rating of 4.5 is strong.' },
    { name: 'Yelp', score: 20, note: 'No meaningful Yelp presence found, which is typical for the Chilean market.' },
    { name: 'OpenTable', score: null, note: 'Not available' },
    { name: 'Delivery Platforms', score: 40, note: 'Not found on delivery apps in the search results.' },
    { name: 'TripAdvisor', score: 68, note: '4.0 from 55 reviews, but limited engagement and no meaningful replies.' },
  ] } };
  applyPresenceRules(r, LA_MESA);
  const ch = Object.fromEntries(r.onlinePresence.channels.map((c) => [c.name, c]));
  for (const n of ['Yelp', 'OpenTable', 'Delivery Platforms']) assert.deepEqual([ch[n].score, ch[n].note], [null, 'Not available'], n);
  assert.equal(ch.TripAdvisor.score, 68, 'a note with data that mentions a gap keeps its score');
  assert.equal(r.onlinePresence.overall, Math.round((78 + 68) / 2), 'the overall is the mean of the channels with data');
  const empty = { onlinePresence: { overall: 30, channels: [{ name: 'Yelp', score: 30, note: 'No data.' }] } };
  applyPresenceRules(empty, LA_MESA);
  assert.equal(empty.onlinePresence.overall, null, 'no channel with data: no overall, never 0');
});

test('quotes are the source\'s own words and are not edited', () => {
  const r = { reviewVerbatims: [{ text: 'Only 0 reviews on Google when I looked, odd for such a good place.' }] };
  applyPresenceRules(r, LA_MESA);
  assert.equal(r.reviewVerbatims[0].text, 'Only 0 reviews on Google when I looked, odd for such a good place.');
});

test('the renderers say Not available and never draw a zero; benchmarks record null', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /if \(typeof c\.score !== 'number'\) return `<div class="pres-row">/);
  assert.doesNotMatch(src, /Math\.min\(100, c\.score \|\| 0\)/);
  assert.match(src, /diagnostix_online_score: report\.onlinePresence && typeof report\.onlinePresence\.overall === 'number' \? report\.onlinePresence\.overall : null/);
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /onlinePresence\.overall\)\|\|0/);
  assert.doesNotMatch(page, /onlinePresence\?\.overall\|\|0/);
  assert.match(page, /Not available: no channel had data to score/);
  assert.match(page, /online_presence_overall: r\.onlinePresence && typeof r\.onlinePresence\.overall === 'number' \? r\.onlinePresence\.overall : null/);
});

test('cleanText leaves a sentence with no count alone', () => {
  const ch = [];
  assert.equal(cleanText('Strong Google presence with clear positioning.', LA_MESA, 'x', ch), 'Strong Google presence with clear positioning.');
  assert.equal(ch.length, 0);
});
