// ════════════════════════════════════════════════════════════════════════════
// v8.11.26 [RVP-A]: every peer carries a Google Places id
//
// TWO MEASURED DEFECTS THIS FIXES, both from the 2026-09-19 reports.
//
// 1. THE FOCAL COUNT CAME FROM A SEARCH KNOWLEDGE GRAPH. On the Zulu
//    assessment the Serper knowledge graph reported 4,552 reviews while Google
//    Places reported 625 for the same restaurant. A factor of seven, and no
//    reader could tell which was printed.
//
// 2. NAME DEDUPLICATION MERGED AND SPLIT THE WRONG THINGS. On the FarmShop
//    assessment "Scoma's Restaurant" appeared TWICE with 7,211 and 6,396
//    reviews, because two search results named the same business slightly
//    differently. On the Starnberg assessment "Pizzeria Tiramisu" and
//    "Pizzería Tiramisú" were the same restaurant under two spellings. Accent
//    folding fixed the second and could never fix the first, and folding
//    harder risks merging two genuinely different restaurants.
//
// THE RULE. Identity is the Google Places id and nothing else. Two peers are
// the same business when their place ids match. A peer with no Places match
// has no identity we can defend, so it carries NO review count and is NEVER
// deduplicated against anything by name. The focal restaurant's count comes
// from its own place id or it is omitted.
//
// This undercounts rather than overstates, which is the right direction for a
// figure printed as evidence.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPlaceIdentity, dedupePeersByPlaceId, peerReviewVolumes,
  peerDisplayCount, peerDisplayRating, placesResolutionSummary,
} from '../lib-places-peers.js';

// ── attaching identity ──────────────────────────────────────────────────────

test('a resolved peer carries its place id and the Places review count', () => {
  const out = attachPlaceIdentity(
    { name: "Scoma's Restaurant", reviewCount: 7211 },
    { ok: true, placeId: 'PID-SCOMA', name: "Scoma's Restaurant", reviewCount: 6396 });
  assert.equal(out.placeId, 'PID-SCOMA');
  assert.equal(out.reviewCount, 6396, 'the Places figure wins over the search figure');
  assert.equal(out.reviewCountSource, 'places');
});

test('THE ZULU CASE: the Places figure replaces the knowledge graph figure', () => {
  // 4,552 from the knowledge graph against 625 from Places, same restaurant.
  const out = attachPlaceIdentity(
    { name: 'Zulu', reviewCount: 4552 },
    { ok: true, placeId: 'PID-ZULU', name: 'Zûlu Kitchen & Bar', reviewCount: 625 });
  assert.equal(out.reviewCount, 625);
  assert.notEqual(out.reviewCount, 4552, 'the knowledge graph figure survived');
});

test('AN UNRESOLVED PEER LOSES ITS REVIEW COUNT ENTIRELY', () => {
  // This is the heart of the package. A number we cannot tie to a place id is
  // a number we cannot defend, so it is not shown at all.
  const out = attachPlaceIdentity(
    { name: 'Some Restaurant', reviewCount: 9000 },
    { ok: false, reason: 'ZERO_RESULTS' });
  assert.equal(out.placeId, null);
  assert.equal(out.reviewCount, null, 'an unverifiable count was kept');
  assert.equal(out.reviewCountSource, 'none');
  assert.equal(out.placesMiss, 'ZERO_RESULTS');
});

test('a resolved peer with no Places count still keeps its identity', () => {
  const out = attachPlaceIdentity(
    { name: 'New Place', reviewCount: 40 },
    { ok: true, placeId: 'PID-NEW', name: 'New Place', reviewCount: null });
  assert.equal(out.placeId, 'PID-NEW');
  assert.equal(out.reviewCount, null, 'Places had no count, so none is shown');
  assert.equal(out.reviewCountSource, 'none');
});

test('the peer name is never rewritten to the Places name', () => {
  // The report already names the restaurant in its prose. Silently renaming a
  // card to Google's spelling would make the card and the sentence disagree.
  const out = attachPlaceIdentity(
    { name: 'Zulu', note: 'a note' },
    { ok: true, placeId: 'PID-ZULU', name: 'Zûlu Kitchen & Bar', reviewCount: 625 });
  assert.equal(out.name, 'Zulu');
  assert.equal(out.placeName, 'Zûlu Kitchen & Bar', 'the Places name is recorded, not substituted');
  assert.equal(out.note, 'a note', 'unrelated fields survive');
});

test('attachPlaceIdentity never throws', () => {
  for (const a of [null, undefined, 42, {}]) {
    for (const b of [null, undefined, { ok: true }, { ok: false }]) {
      assert.doesNotThrow(() => attachPlaceIdentity(a, b));
    }
  }
});

// ── deduplication is by place id only ───────────────────────────────────────

test('THE SCOMA CASE: two entries, one place id, one peer', () => {
  const peers = [
    { name: "Scoma's Restaurant", placeId: 'PID-SCOMA', reviewCount: 7211 },
    { name: "Scoma's Restaurant", placeId: 'PID-SCOMA', reviewCount: 6396 },
  ];
  const out = dedupePeersByPlaceId(peers);
  assert.equal(out.length, 1);
  assert.equal(out[0].reviewCount, 7211, 'the larger Places figure is kept');
});

test('THE TIRAMISU CASE: two spellings, one place id, one peer', () => {
  const out = dedupePeersByPlaceId([
    { name: 'Pizzeria Tiramisu', placeId: 'PID-TIRA', reviewCount: 13557 },
    { name: 'Pizzería Tiramisú', placeId: 'PID-TIRA', reviewCount: 13557 },
  ]);
  assert.equal(out.length, 1);
});

test('IDENTICAL NAMES WITH DIFFERENT PLACE IDS STAY SEPARATE', () => {
  // A chain. Two branches of the same brand are two businesses, and merging
  // them would understate the evidence and misstate the competitive set.
  const out = dedupePeersByPlaceId([
    { name: "Joe's Pizza", placeId: 'PID-A', reviewCount: 100 },
    { name: "Joe's Pizza", placeId: 'PID-B', reviewCount: 200 },
  ]);
  assert.equal(out.length, 2, 'two branches were merged into one');
});

test('UNRESOLVED PEERS ARE NEVER DEDUPLICATED, even with identical names', () => {
  // The explicit instruction. Without a place id there is no evidence they are
  // the same business, and guessing from the name is what produced the Scoma
  // double in the first place.
  const out = dedupePeersByPlaceId([
    { name: 'Mystery Grill', placeId: null, reviewCount: null },
    { name: 'Mystery Grill', placeId: null, reviewCount: null },
  ]);
  assert.equal(out.length, 2, 'unresolved peers were merged on name alone');
});

test('order is preserved, and the first occurrence wins its slot', () => {
  const out = dedupePeersByPlaceId([
    { name: 'A', placeId: 'P1', reviewCount: 10 },
    { name: 'B', placeId: 'P2', reviewCount: 20 },
    { name: 'A again', placeId: 'P1', reviewCount: 30 },
  ]);
  assert.deepEqual(out.map(p => p.name), ['A', 'B']);
  assert.equal(out[0].reviewCount, 30, 'the larger count is adopted into the kept row');
});

test('dedupePeersByPlaceId never throws and drops nothing silently', () => {
  assert.deepEqual(dedupePeersByPlaceId(null), []);
  assert.deepEqual(dedupePeersByPlaceId('x'), []);
  const junk = [null, 7, { name: 'ok', placeId: null }];
  assert.equal(dedupePeersByPlaceId(junk).length, 1, 'the one usable row survived');
});

// ── the volumes the Evidence base panel prints ──────────────────────────────

test('volumes count the focal and each resolved peer once', () => {
  const v = peerReviewVolumes({
    focal: { placeId: 'PID-FOCAL', reviewCount: 625 },
    peers: [
      { name: 'A', placeId: 'P1', reviewCount: 2981 },
      { name: 'B', placeId: 'P2', reviewCount: 1933 },
    ],
  });
  assert.equal(v.total, 625 + 2981 + 1933);
  assert.equal(v.counted, 3);
});

test('an unresolved peer contributes nothing to the total', () => {
  const v = peerReviewVolumes({
    focal: { placeId: 'PID-FOCAL', reviewCount: 625 },
    peers: [
      { name: 'A', placeId: 'P1', reviewCount: 2981 },
      { name: 'B', placeId: null, reviewCount: null },
    ],
  });
  assert.equal(v.total, 625 + 2981);
  assert.equal(v.counted, 2);
  assert.equal(v.unresolved, 1, 'the panel should be able to say how many were skipped');
});

test('THE FOCAL COUNT REQUIRES A PLACE ID', () => {
  const v = peerReviewVolumes({
    focal: { placeId: null, reviewCount: 4552 },
    peers: [{ name: 'A', placeId: 'P1', reviewCount: 2981 }],
  });
  assert.equal(v.total, 2981, 'a focal count with no place id was counted');
  assert.equal(v.counted, 1);
});

test('the same place id on the focal and a peer is counted once', () => {
  // Places has returned the focal restaurant inside its own nearby list.
  const v = peerReviewVolumes({
    focal: { placeId: 'PID-X', reviewCount: 625 },
    peers: [{ name: 'itself', placeId: 'PID-X', reviewCount: 625 }],
  });
  assert.equal(v.total, 625);
  assert.equal(v.counted, 1);
});

test('nothing countable yields a zero total and a null-safe shape', () => {
  const v = peerReviewVolumes({ focal: null, peers: [] });
  assert.equal(v.total, 0);
  assert.equal(v.counted, 0);
  assert.doesNotThrow(() => peerReviewVolumes(null));
});

// ── what a card shows ───────────────────────────────────────────────────────

test('a card shows a count only when it came from Places', () => {
  assert.equal(peerDisplayCount({ reviewCount: 625, reviewCountSource: 'places' }), 625);
  assert.equal(peerDisplayCount({ reviewCount: 4552, reviewCountSource: 'search' }), null);
  assert.equal(peerDisplayCount({ reviewCount: null, reviewCountSource: 'none' }), null);
  assert.equal(peerDisplayCount(null), null);
});

// ── the summary line for the log and the panel ──────────────────────────────

test('the resolution summary reports both sides', () => {
  const s = placesResolutionSummary([
    { placeId: 'P1' }, { placeId: 'P2' }, { placeId: null, placesMiss: 'ZERO_RESULTS' },
  ]);
  assert.equal(s.resolved, 2);
  assert.equal(s.unresolved, 1);
  assert.ok(s.line.includes('2'), s.line);
  assert.ok(s.line.includes('1'), s.line);
});

test('the summary is honest when nothing resolved', () => {
  const s = placesResolutionSummary([{ placeId: null }, { placeId: null }]);
  assert.equal(s.resolved, 0);
  assert.equal(s.unresolved, 2);
});

// ── v8.11.28 [RVP-A]: an unresolved peer shows no rating either ─────────────
//
// The first version of this package dropped the review COUNT for a peer with
// no Places match but kept its RATING. That is half a fix: a star rating from
// a search knowledge graph has exactly the provenance problem the count had,
// and 4.8 stars on a card is a stronger claim than a review volume.
//
// A peer with no confident Places match is still LISTED, because removing it
// would change the competitive set the model reasoned about. It shows no
// number at all, and says why in one plain phrase.

test('an unresolved peer loses its RATING as well as its count', () => {
  const out = attachPlaceIdentity(
    { name: 'Some Place', reviewCount: 9000, rating: 4.8 },
    { ok: false, reason: 'ZERO_RESULTS' });
  assert.equal(out.reviewCount, null);
  assert.equal(out.rating, null, 'a knowledge-graph rating survived');
  assert.equal(out.ratingSource, 'none');
});

test('an unresolved peer is still listed, and says why in one phrase', () => {
  const out = attachPlaceIdentity({ name: 'Some Place', rating: 4.8 }, { ok: false, reason: 'ZERO_RESULTS' });
  assert.equal(out.name, 'Some Place', 'the peer was dropped instead of listed');
  assert.ok(typeof out.noDataReason === 'string' && out.noDataReason.length > 8, out.noDataReason);
  assert.ok(!out.noDataReason.includes('—') && !out.noDataReason.includes('–'), 'dash in customer copy');
  assert.ok(/not matched|no match|could not/i.test(out.noDataReason), out.noDataReason);
});

test('a RESOLVED peer takes its rating from Places, not from search', () => {
  const out = attachPlaceIdentity(
    { name: 'Zulu', rating: 4.9, reviewCount: 4552 },
    { ok: true, placeId: 'PID', name: 'Zulu', rating: 4.4, reviewCount: 625 });
  assert.equal(out.rating, 4.4, 'the search rating survived');
  assert.equal(out.ratingSource, 'places');
  assert.equal(out.noDataReason, null);
});

test('a resolved peer with no Places rating shows none', () => {
  const out = attachPlaceIdentity({ name: 'X', rating: 4.9 }, { ok: true, placeId: 'P', name: 'X', rating: null, reviewCount: 10 });
  assert.equal(out.rating, null);
  assert.equal(out.ratingSource, 'none');
});

test('peerDisplayRating mirrors peerDisplayCount', () => {
  assert.equal(peerDisplayRating({ rating: 4.4, ratingSource: 'places' }), 4.4);
  assert.equal(peerDisplayRating({ rating: 4.8, ratingSource: 'search' }), null);
  assert.equal(peerDisplayRating(null), null);
});
