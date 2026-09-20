// ── Peer identity is a Google Places id (v8.11.26) [RVP-A] ──────────────────
//
// TWO MEASURED DEFECTS THIS EXISTS TO FIX, both from the 2026-09-19 reports.
//
// 1. THE FOCAL COUNT CAME FROM A SEARCH KNOWLEDGE GRAPH. On the Zulu
//    assessment the Serper knowledge graph reported 4,552 reviews while Google
//    Places reported 625 for the same restaurant, a factor of seven, and
//    nothing in the report let a reader tell which had been used.
//
// 2. NAME DEDUPLICATION MERGED AND SPLIT THE WRONG THINGS. On the FarmShop
//    assessment "Scoma's Restaurant" appeared twice with 7,211 and 6,396
//    reviews. On the Starnberg assessment the same restaurant appeared as
//    "Pizzeria Tiramisu" and "Pizzería Tiramisú". Accent folding fixed the
//    second and could never fix the first, and folding harder would start
//    merging genuinely different restaurants.
//
// THE RULE. Identity is the Places id and nothing else.
//
//   - Two peers are the same business when their place ids match.
//   - A peer with no Places match has no identity we can defend. It carries
//     NO review count and is NEVER deduplicated against anything by name.
//   - The focal restaurant's count comes from its own place id, or it is
//     omitted.
//
// This undercounts rather than overstates. For a figure printed as evidence
// that is the only safe direction: a missing number invites a question, a
// wrong number invites a conclusion.

function asInt(v) {
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.round(v) : null;
}

// Merges a Places lookup into a peer. The peer's own name is never rewritten:
// the report already names the restaurant in its prose, and silently renaming
// a card to Google's spelling would make the card and the sentence disagree.
export function attachPlaceIdentity(peer, placeHit) {
  const p = (peer && typeof peer === 'object') ? peer : {};
  const h = (placeHit && typeof placeHit === 'object') ? placeHit : {};
  const out = Object.assign({}, p);

  if (h.ok === true && typeof h.placeId === 'string' && h.placeId) {
    out.placeId = h.placeId;
    out.placeName = h.name || null;
    out.placesMiss = null;
    const n = asInt(h.reviewCount);
    out.reviewCount = n;                      // null when Places has no count
    out.reviewCountSource = n === null ? 'none' : 'places';
    // v8.11.28: the RATING comes from Places too, or not at all. The first
    // version of this package dropped the count and kept the rating, which is
    // half a fix: a star rating from a search knowledge graph has exactly the
    // provenance problem the count had, and 4.8 stars on a card is a stronger
    // claim than a review volume.
    const rt = (typeof h.rating === 'number' && Number.isFinite(h.rating)) ? h.rating : null;
    out.rating = rt;
    out.ratingSource = rt === null ? 'none' : 'places';
    out.placeRating = rt;
    out.noDataReason = null;
  } else {
    // No identity, so no number. Whatever count arrived from search is dropped
    // here rather than shown without provenance.
    out.placeId = null;
    out.placeName = null;
    out.placesMiss = (h && typeof h.reason === 'string' && h.reason) ? h.reason : 'unresolved';
    out.reviewCount = null;
    out.reviewCountSource = 'none';
    out.rating = null;
    out.ratingSource = 'none';
    out.placeRating = null;
    // The peer is still LISTED. Removing it would change the competitive set
    // the model reasoned about, and the card saying why is more useful than a
    // card quietly missing two numbers. US spelling, no dashes: this is
    // customer copy.
    out.noDataReason = 'Not matched to a Google listing, so no rating or review count is shown.';
  }
  return out;
}

// Deduplicates ONLY on place id. Unresolved peers pass through untouched, even
// when two of them share a name, because a shared name is not evidence of a
// shared business and treating it as such is the original defect.
export function dedupePeersByPlaceId(peers) {
  if (!Array.isArray(peers)) return [];
  const out = [];
  const indexByPid = new Map();
  for (const raw of peers) {
    if (!raw || typeof raw !== 'object') continue;
    const pid = (typeof raw.placeId === 'string' && raw.placeId) ? raw.placeId : null;
    if (!pid) { out.push(raw); continue; }
    if (!indexByPid.has(pid)) {
      indexByPid.set(pid, out.length);
      out.push(raw);
      continue;
    }
    // Same business seen again. Keep the first slot, adopt the larger count:
    // two Places lookups for one id can disagree if one was cached.
    const i = indexByPid.get(pid);
    const kept = out[i];
    const a = asInt(kept.reviewCount);
    const b = asInt(raw.reviewCount);
    if (b !== null && (a === null || b > a)) {
      out[i] = Object.assign({}, kept, { reviewCount: b, reviewCountSource: 'places' });
    }
  }
  return out;
}

// The volumes the Evidence base panel prints. One figure per distinct place id,
// focal included, and nothing at all without an id.
export function peerReviewVolumes(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const byPid = new Map();
  let unresolved = 0;

  const add = (row) => {
    if (!row || typeof row !== 'object') return;
    const pid = (typeof row.placeId === 'string' && row.placeId) ? row.placeId : null;
    const n = asInt(row.reviewCount);
    if (!pid) { unresolved += 1; return; }
    if (n === null) return;
    byPid.set(pid, Math.max(byPid.get(pid) || 0, n));
  };

  add(a.focal);
  for (const p of (Array.isArray(a.peers) ? a.peers : [])) add(p);

  let total = 0;
  for (const v of byPid.values()) total += v;
  return { total, counted: byPid.size, unresolved };
}

// A card shows a count only when Places gave it. A count that arrived from a
// search knowledge graph is withheld rather than printed without provenance.
export function peerDisplayCount(peer) {
  if (!peer || typeof peer !== 'object') return null;
  if (peer.reviewCountSource !== 'places') return null;
  return asInt(peer.reviewCount);
}


// Mirrors peerDisplayCount. A rating is shown only when Places gave it.
export function peerDisplayRating(peer) {
  if (!peer || typeof peer !== 'object') return null;
  if (peer.ratingSource !== 'places') return null;
  const r = peer.rating;
  return (typeof r === 'number' && Number.isFinite(r)) ? r : null;
}

export function placesResolutionSummary(peers) {
  const list = Array.isArray(peers) ? peers : [];
  let resolved = 0, unresolved = 0;
  for (const p of list) {
    if (p && typeof p === 'object' && typeof p.placeId === 'string' && p.placeId) resolved += 1;
    else unresolved += 1;
  }
  return {
    resolved,
    unresolved,
    line: `${resolved} peer(s) resolved to a Places id, ${unresolved} not resolved`,
  };
}
