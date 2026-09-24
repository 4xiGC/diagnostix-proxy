// ════════════════════════════════════════════════════════════════════════════
// THE NEWEST GOOGLE REVIEW DATE FOR A CONFIRMED PLACE (2026-09-24).
//
// One legacy Place Details call, fields=reviews, reviews_sort=newest. Google
// returns up to five reviews, each with `time` in seconds since 1970 UTC; the
// newest is the largest. Approved by Simon on 2026-09-24 once the published
// pricing put it inside the existing plan:
//
//   Places Details    5,000 free a month, then 17 USD per 1,000   (ASSUMED,
//   Atmosphere Data   1,000 free a month, then  5 USD per 1,000    pricing page
//                     (reviews is an Atmosphere field; the cap     read
//                     is shared with every Find Place asking for   2026-09-24)
//                     rating or user_ratings_total)
//
// So 0 USD inside both free caps, about 0.005 USD once the shared Atmosphere cap
// is used, 0.022 USD at worst. NEVER THROWS: a failure returns ok false and the
// caller treats recency as unknown, which never blocks a sale.
// ════════════════════════════════════════════════════════════════════════════

export const PLACE_DETAILS_ASSUMED_USD = Object.freeze({ details: 0.017, atmosphere: 0.005, worst: 0.022 });

export async function fetchNewestReviewAt({ placeId, apiKey, fetchFn, timeoutMs = 4000 }) {
  const started = Date.now();
  if (!placeId || !apiKey || typeof fetchFn !== 'function') {
    return { ok: false, called: false, reason: !apiKey ? 'no-key' : 'no-place-id', newestReviewAt: null, reviewsRead: 0, ms: 0 };
  }
  const url = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + encodeURIComponent(placeId)
    + '&fields=reviews&reviews_sort=newest&key=' + encodeURIComponent(apiKey);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(url, ctl ? { signal: ctl.signal } : undefined);
    if (!res || !res.ok) return { ok: false, called: true, reason: 'http-' + (res && res.status), newestReviewAt: null, reviewsRead: 0, ms: Date.now() - started };
    const d = await res.json();
    if (!d || d.status !== 'OK') return { ok: false, called: true, reason: 'status-' + (d && d.status), newestReviewAt: null, reviewsRead: 0, ms: Date.now() - started };
    const reviews = (d.result && Array.isArray(d.result.reviews)) ? d.result.reviews : [];
    const times = reviews.map((r) => Number(r && r.time)).filter((t) => Number.isFinite(t) && t > 0);
    const newest = times.length ? new Date(Math.max(...times) * 1000).toISOString() : null;
    return { ok: true, called: true, reason: newest ? 'read' : 'no-reviews', newestReviewAt: newest, reviewsRead: reviews.length, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, called: true, reason: (e && e.name === 'AbortError') ? 'timeout' : 'error', newestReviewAt: null, reviewsRead: 0, ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
