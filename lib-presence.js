// ════════════════════════════════════════════════════════════════════════════
// A COUNT IS A MEASUREMENT, AND ABSENCE IS NOT ZERO (Simon, 2026-11-18).
//
// THE DEFECT. RVP holds the subject's Google record (rating and review count,
// from the Find Place answer the owner confirmed) but the prompt passed only the
// rating. Asked about Google, the model wrote "0 reviews": La Mesa (589 on
// Google), General Tarleton (158). Delivered paid reports said "zero customer
// reviews exist on Google" for venues with 371 to 2,725. Follower counts came
// from whatever page a search returned: General Tarleton "5 followers" was an
// unofficial page (the official one has 1,287). And every online channel got a
// 0-100 score whether or not any data existed, so "no data" was scored as weak.
//
// THE RULE:
//   1. The Google record goes into the prompt as the authoritative figures, or
//      as "not available". A review count, rating or follower count the prompt
//      did not supply is never stated.
//   2. RVP has no record of a subject's official social accounts, so NO
//      follower or fan count is stated anywhere: a sentence stating one is
//      removed. (Passing official accounts needs a source for them first.)
//   3. A sentence stating zero or no Google reviews, or a Google review count
//      other than the record's, is removed.
//   4. A channel whose data is absent has no score and says "Not available";
//      it is outside the overall, which is the mean of the channels that have
//      data, or null when none do. A zero is a measured finding, never the
//      shape absence takes.
// Pure; never throws; every change is returned.
// ════════════════════════════════════════════════════════════════════════════
const NOT_AVAILABLE = 'Not available';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The prompt block. Only figures the pipeline holds; absent ones say so.
function googleRecordBlock(rec) {
  const rating = num(rec && rec.rating), count = num(rec && rec.reviewCount);
  return [
    'GOOGLE BUSINESS RECORD (authoritative, from the Google listing the owner confirmed):',
    '  Google rating: ' + (rating === null ? 'not available' : rating),
    '  Google review count: ' + (count === null ? 'not available' : count),
    'COUNT RULES (HARD): state a Google rating or Google review count only as given above, and never say Google has zero or no reviews unless the count above is 0. '
      + 'State a review count or rating for any other platform only when it appears verbatim in the web data. '
      + 'NEVER state a follower, fan or subscriber count for any social account: none is supplied. '
      + 'For an online channel the data says nothing about, return "score": null and "note": "' + NOT_AVAILABLE + '". Never score absent data.',
  ].join('\n');
}

const SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;
// "5 followers", "1.9k followers", "5 social media followers", "63K Instagram followers".
const FOLLOWERS = /\b\d[\d,.]*\s*[kKmM]?\+?\s*(?:[A-Za-z]+\s+){0,3}(?:followers|seguidores|fans|subscribers|likes)\b/i;
// A zero is a whole number, not the end of a decimal ("4.0 with only 55 reviews" was removed in
// error on 2026-11-18), and no other number stands between it and "reviews".
// "0 on Google Maps" counts too (kept in error by the first tightening, caught by re-checking the
// logged removals).
const GOOGLE_ZERO = /(?<![\d.,])\b(?:0|zero|no)\s+(?:(?![\d])\w+\s+){0,3}(?:google\s+)?reviews?\b|\breviews?\b[^.\d]{0,30}(?<![\d.,])\b(?:0|zero)\b(?![.,]\d)|(?<![\d.,])\b(?:0|zero|no)\s+(?:reviews?\s+)?(?:on|in|from|at)\s+google\b/i;
const REVIEW_COUNT = /\b(\d[\d,.]*)\s*(?:google\s+)?reviews?\b/gi;

// A sentence that states a count the prompt never supplied, or contradicts the record.
function offending(sentence, rec, aboutGoogle) {
  const s = String(sentence);
  // A follower range in advice about influencers or creators is not a claim about the subject
  // ("partner with micro-influencers (10k-100k followers)", removed in error on 2026-11-18).
  if (FOLLOWERS.test(s) && !/\b(?:influencers?|creators?|bloggers?)\b/i.test(s)) return 'follower-count';
  if (aboutGoogle || /google/i.test(s)) {
    const count = num(rec && rec.reviewCount);
    if (GOOGLE_ZERO.test(s) && count !== 0) return 'google-zero';
    if (count !== null && !/tripadvisor|yelp|opentable|facebook|instagram/i.test(s)) {
      for (const m of s.matchAll(REVIEW_COUNT)) {
        const n = Number(m[1].replace(/[,.](?=\d{3}\b)/g, '').replace(/,/g, ''));
        if (Number.isFinite(n) && n !== count) return 'google-count-mismatch';
      }
    }
  }
  return null;
}

function cleanText(text, rec, path, changes, aboutGoogle) {
  if (typeof text !== 'string' || !text.trim()) return text;
  const kept = [];
  for (const sen of text.split(SPLIT)) {
    const why = offending(sen, rec, aboutGoogle);
    if (why) { changes.push({ path, action: 'sentence-removed', reason: why, before: sen }); continue; }
    kept.push(sen);
  }
  return kept.join(' ').trim();
}

// Absence language in a channel note: our search found nothing, which is not a measurement.
// Only a note that OPENS with absence ("No dedicated presence detected", "Not found in search
// results", "None visible"): a note with data that mentions a gap ("4.5 rating, no meaningful
// engagement") keeps its score.
const ABSENT_NOTE = /^\s*(?:no|not|none|n\/a|unknown)\b/i;

function normalizeChannels(report, rec, changes) {
  const op = report && report.onlinePresence;
  if (!op || !Array.isArray(op.channels)) return;
  for (const [i, c] of op.channels.entries()) {
    if (!c || typeof c !== 'object') continue;
    const path = 'onlinePresence.channels[' + i + ']';
    // A Google channel's note is about Google even when it never says the word.
    const isGoogle = /google/i.test(String(c.name || ''));
    if (typeof c.note === 'string') c.note = cleanText(c.note, rec, path + '.note', changes, isGoogle);
    // The record is a measurement: a Google channel whose note held only a false count says the record.
    if (isGoogle && !c.note && num(rec && rec.reviewCount) !== null) {
      c.note = 'Rated ' + (num(rec.rating) === null ? 'n/a' : rec.rating) + ' on Google from ' + rec.reviewCount + ' reviews.';
      changes.push({ path: path + '.note', action: 'record-stated' });
    }
    const score = num(c.score);
    const absent = score === null || !c.note || ABSENT_NOTE.test(String(c.note));
    if (absent) {
      if (c.score !== null || c.note !== NOT_AVAILABLE) changes.push({ path, action: 'not-available', before: [c.score, c.note] });
      c.score = null;
      c.note = NOT_AVAILABLE;
    } else {
      c.score = Math.max(0, Math.min(100, Math.round(score)));
    }
  }
  const scored = op.channels.filter((c) => c && num(c.score) !== null).map((c) => c.score);
  const overall = scored.length ? Math.round(scored.reduce((t, v) => t + v, 0) / scored.length) : null;
  if (op.overall !== overall) changes.push({ path: 'onlinePresence.overall', action: 'recomputed', before: op.overall, after: overall });
  op.overall = overall;
}

// Every prose string in the report, except verbatim quotes, which are the source's own words.
function walk(x, path, fn) {
  if (Array.isArray(x)) {
    x.forEach((v, i) => { if (typeof v === 'string') x[i] = fn(v, path + '[' + i + ']'); else walk(v, path + '[' + i + ']', fn); });
    // A list item emptied by the rules goes, rather than printing as a blank bullet.
    for (let i = x.length - 1; i >= 0; i--) if (typeof x[i] === 'string' && !x[i].trim()) x.splice(i, 1);
    return;
  }
  if (!x || typeof x !== 'object') return;
  for (const [k, v] of Object.entries(x)) {
    if (!path && (k === '_debug' || k === 'reviewVerbatims' || k === 'subject' || k === 'competitors')) continue;
    const p = path ? path + '.' + k : k;
    if (typeof v === 'string') x[k] = fn(v, p); else walk(v, p, fn);
  }
}

// Applied to the merged model report, in place, before scoring and the summary.
function applyPresenceRules(report, rec) {
  const changes = [];
  try {
    if (!report || typeof report !== 'object') return changes;
    normalizeChannels(report, rec, changes);
    walk(report, '', (s, p) => (/^onlinePresence\.channels\[\d+\]\.note$/.test(p) ? s : cleanText(s, rec, p, changes)));
  } catch (_) { /* never fail an assessment on the guard */ }
  return changes;
}

export { NOT_AVAILABLE, googleRecordBlock, applyPresenceRules, cleanText, offending, ABSENT_NOTE, normalizeChannels };
