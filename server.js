import express from 'express';
// v8.11.49: node-fetch, behind a name a test can rebind.
//
// This was `import fetch from 'node-fetch'`, and an ESM import binding cannot
// be replaced from outside the module, so setting globalThis.fetch in a test
// changed nothing and the first run of test/order-row-lookup.test.js went out
// to the real network: "getaddrinfo ENOTFOUND db.invalid". Every fetch( call
// in this file is unchanged and still resolves here; only the binding is now
// one a test can point somewhere else through __test__.setFetch.
import nodeFetch from 'node-fetch';
let fetch = nodeFetch;
import { computeOverall, overallFormula, verdictFor, NO_SCORE_SENTENCE,
         OVERALL_METHOD_VERSION, recordedScore } from './lib-score.js';
import { contradictsBand, retryInstruction } from './lib-narrative.js';
import crypto from 'crypto';
import { describeShape, emailDomainOnly, addrLabel } from './lib-webhook-log.js';
import { buildCustomerReportEmail, buildCacheMissEmail } from './lib-email.js';
import { LIST_PRICE_USD, listPriceLabel, amountPaidToWrite, hubspotAmountFields } from './lib-price.js';
import { normalizeEmail, saveSizeBytes, MAX_SAVE_BYTES,
         matchPendingReport, selectRowToClaim, emailDomain, INFER_WINDOW_MS,
         deliveryProvenanceLines, swapLinkSentence, swapEligibility, SWAP_NOTE_PREFIX,
         isDuplicateSubmission, DUPLICATE_WINDOW_MS, DUPLICATE_CLAIM_LABEL,
         swapOrderKey, orderKeyForDelivery, patchRowsAffected, claimVerdict, outcomeRecord, recoveryReason,
         alertCopyFor, pgErrorFields, recoveryCopy, recoveryNotFound,
         applyShadowMode, recoveryAllowed, inferenceVerdict,
         signRecoveryToken, verifyRecoveryToken,
         RECOVERY_TTL_MS, RECOVERY_MAX_ATTEMPTS,
         markSpent, memoryHitVerdict,
         alertThrottle, ALERT_THROTTLE_MS,
         webhookEnforcement, misroutedHint, takeBodySecret, webhookSecretCheck } from './lib-pending.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { reviewGate, refusalCopy, noMatchCopy, limitedNote, coverageNoteHtml, CONTACT_ADDRESS } from './lib-review-gate.js';
import { fetchNewestReviewAt, PLACE_DETAILS_ASSUMED_USD } from './lib-place-details.js';
import { signPlaceToken, verifyPlaceToken } from './lib-place-token.js';
import { attachPlaceIdentity, dedupePeersByPlaceId, peerReviewVolumes,
         placesResolutionSummary } from './lib-places-peers.js';
import { newLedger, noteSearch, noteResults, summarizeEvidence,
         renderEvidenceSentence, formatCount, evidencePanelHtml } from './lib-evidence.js';
import { findContradictions, COMPARISON_RULE } from './lib-comparisons.js';

// ── ALL-1: the evidence ledger, scoped to one assessment ───────────────────
//
// AsyncLocalStorage rather than an extra argument on every search call. There
// are fourteen search call sites across two products in this file; threading a
// parameter through all of them would touch far more code than the feature is
// worth and would still miss one. A module-level counter would be worse: two
// concurrent assessments would add their searches together and BOTH reports
// would overstate their evidence, which is the exact failure this panel exists
// to stop.
//
// Outside a run (the embedded EVP path, a bare script) getStore() is undefined
// and every note is a no-op, so nothing is counted that is not an RVP
// assessment.
const EVIDENCE = new AsyncLocalStorage();
const currentLedger = () => EVIDENCE.getStore() || null;

// v8.11.10: LOGGING CANNOT INTERRUPT A PURCHASE.
//
// Every line added in v8.11.10 runs inside handlePaymentWebhook, which has
// already answered 200 and is now doing the work: HubSpot, Supabase, the peer
// comparison and the customer's email. A throw there is not a 500 the caller
// sees, it is a genuine buyer silently receiving no report, because a LOG LINE
// failed. This repo has no tests to catch that.
//
// So every new log call goes through safeLog, and every masked address through
// maskAddr. Both are total by construction.
function safeLog(build) {
  try { console.log(build()); } catch (_) { /* logging must never interrupt */ }
}
// v8.11.29: the domain AND the local part length. emailDomainOnly alone made
// two different addresses on one provider print identically, which is how the
// 2026-09-20 misdelivery hid inside a log that was working correctly.
function maskAddr(v) {
  try { return addrLabel(v); } catch (_) { return '(unmaskable)'; }
}
function safeShape(v) {
  try { return describeShape(v); } catch (_) { return '<undescribable>'; }
}
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Single source of truth for the version. /health used to publish a hardcoded
// '8.9.23' literal that had no relationship to package.json, which still said
// 1.0.0. package.json is now the only place the number is written.
const VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;

// ── Analytics benchmark capture (ported from SVP v0.14.0 and EVP v1.5.0) ───
// One row per completed assessment, written to the shared "benchmarks" table.
//
// UNLIKE SVP AND EVP, this service needs no new credentials. SUPABASE_URL and
// SUPABASE_KEY already point at gxinqurxmstvoovfbgqr, the project that holds
// benchmarks alongside subscribers, cohort_taxonomy and analytics_events. So
// there is no separate ANALYTICS_* pair here, and adding one would be a second
// name for the same thing.
//
// The write is gated on credentials present plus BENCHMARK_WRITE_ENABLED set
// explicitly to "true". This lets the release ship inert and be switched on
// separately. Anything other than "true", including unset, means off.
const BENCHMARKS_TABLE = 'benchmarks';
const BENCHMARK_WRITE_ENABLED = String(process.env.BENCHMARK_WRITE_ENABLED || '').trim().toLowerCase() === 'true';
const BENCHMARK_CONFIGURED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const BENCHMARK_ENABLED = BENCHMARK_CONFIGURED && BENCHMARK_WRITE_ENABLED;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const reportStore = new Map();
// ── Annual subscriptions, RETIRED in v8.10.0 ───────────────────────────────
//
// The annual product is gone. Re-run prompting moved to a HubSpot follow-up
// workflow, outside these repos. Removed here: the 6-hourly setInterval
// scheduler, generateProgressReport with its annual-p1 and annual-p2 prompts,
// sendRenewalReminderEmail, updateSubscriberInSupabase, the boot loader, and
// the /trigger-annual-report route with its ADMIN_SECRET guard. ADMIN_SECRET is
// now read by nothing in this file; the Railway variable is left for a
// deliberate cleanup rather than deleted as a side effect here.
//
// NINE COLUMNS ON subscribers ARE HISTORICAL AND NO LONGER WRITTEN. They are
// deliberately NOT dropped: data outlives the code that wrote it, and 87 rows
// carry history. All nine were empty across all 87 rows when this was measured
// on 2026-09-02, so the annual path never completed a cycle.
//
//   report_2, report_3, report_2_score, report_3_score, report_2_date,
//   report_3_date, renewal_reminder_at, renewal_reminder_sent_at,
//   renewal_reminder_sent, subscription_expires, latest_score
//
// THREE COLUMNS ARE SHARED AND STILL WRITTEN by the base paid flow, so do not
// mistake them for annual leftovers: reports_sent is set to 1 by
// createCustomer for every customer, and active and next_report_at are written
// there too, now always false and null since no plan is annual.
//
// This Map SURVIVES the retirement. It is not annual-only: createCustomer
// populates it, and GET /report?token= falls back to it when a Supabase write
// has not yet propagated. Losing the boot loader narrows that fallback to rows
// created in the current process, which is acceptable because the loader only
// ever selected active=true rows and there are now none.
const annualSubscribers = new Map();

// ── SHARED HELPERS (Serper + Claude) ─────────────────────────
// Lifted out when the annual path shared them. That path went in v8.10.0.
// ── REGION-AWARE PLATFORMS ───────────────────────────────────
// Different regions use different review/delivery/employer platforms.
// We map the user-entered country to a region, then build queries tailored
// to that region's dominant platforms. Each query category has a fallback
// chain (region-specific → generic) so non-mapped regions still get coverage.
//
// Phase 1 covers US (default) and LATAM. Phase 2 will add EU, UK, APAC, MENA.
function getRegion(country) {
  if (!country) return 'US';
  const c = String(country).trim().toLowerCase();
  const LATAM = [
    'chile','argentina','uruguay','peru','colombia','mexico','méxico',
    'brazil','brasil','ecuador','bolivia','paraguay','venezuela',
    'costa rica','panama','panamá','dominican republic','república dominicana',
    'guatemala','honduras','nicaragua','el salvador','cuba','puerto rico'
  ];
  if (LATAM.includes(c)) return 'LATAM';
  // Default to US-style queries for everything else for now. Add more regions in Phase 2.
  return 'US';
}

// Per-region query templates. Each category returns an ARRAY of progressive
// fallback queries (most specific → most generic). The first to yield enough
// content wins; if all fall below threshold, the longest result is used.
// Tokens: ${name}, ${location} are substituted by the caller.
function buildRegionQueries(region, name, location) {
  if (region === 'LATAM') {
    return {
      GOOGLE: [
        `${name} ${location} restaurante`,
        `${name} ${location}`
      ],
      REVIEWS: [
        `${name} ${location} opiniones TripAdvisor Google`,
        `${name} ${location} reseñas restaurante`,
        `${name} ${location} reviews`
      ],
      STAFF: [
        `${name} Computrabajo empleos`,
        `${name} LinkedIn empleados`,
        `${name} ${location} trabajar`
      ],
      SOCIAL: [
        `${name} Instagram Facebook ${location}`,
        `${name} redes sociales`,
        `${name} @ ${location}`
      ],
      DELIVERY: [
        `${name} PedidosYa Rappi iFood delivery`,
        `${name} ${location} delivery menú`,
        `${name} ${location} domicilio`
      ],
      COMPETITORS: [
        `mejores restaurantes ${location} competencia ${name}`,
        `restaurantes ${location} similares ${name}`,
        `best restaurants ${location} competitors ${name}`
      ]
    };
  }
  // Default: US/global platforms
  return {
    GOOGLE: [
      `${name} ${location} restaurant`,
      `${name} ${location}`
    ],
    REVIEWS: [
      `${name} ${location} reviews TripAdvisor Yelp OpenTable`,
      `${name} ${location} restaurant reviews`,
      `${name} ${location} ratings`
    ],
    STAFF: [
      `${name} Glassdoor Indeed employees`,
      `${name} ${location} employees jobs`,
      `${name} ${location} working`
    ],
    SOCIAL: [
      `${name} Instagram Facebook social media`,
      `${name} ${location} social`,
      `${name} @`
    ],
    DELIVERY: [
      `${name} Uber Eats DoorDash Grubhub delivery`,
      `${name} ${location} delivery menu`,
      `${name} ${location} order online`
    ],
    COMPETITORS: [
      `best restaurants ${location} competitors ${name}`,
      `restaurants near ${location} similar to ${name}`,
      `top restaurants ${location}`
    ]
  };
}

// search() — Google search via Serper. Returns a text blob for the AI to read.
// Logging: per-query timing and result length so empty results are diagnosable from Railway logs.
// Returns the literal string 'no data' on empty (or 'no api key' / 'err:...' on failure).
async function search(q, opts) {
  opts = opts || {};
  const label = opts.label || 'search';
  const sk = process.env.SERPER_API_KEY;
  if (!sk) { console.log(`[serper] ${label} q="${q}" → NO API KEY`); return 'no api key'; }
  const t0 = Date.now();
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': sk, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: 10 })
    });
    const d = await r.json();
    let o = '';
    if (d.knowledgeGraph) {
      const kg = d.knowledgeGraph;
      o += `[${kg.title||''}] Rating:${kg.rating||'N/A'} (${kg.reviewCount||0} reviews) ${kg.description||''}\n`;
    }
    const organic = d.organic || [];
    // ALL-1: eight is the slice, so eight is what is READ. The ledger records
    // returned and read separately on purpose: they differ, and the difference
    // is the honest part of the panel.
    noteSearch(currentLedger(), { label });
    noteResults(currentLedger(), { organic, read: Math.min(8, organic.length) });
    organic.slice(0,8).forEach(i => { o += `${i.title}: ${i.snippet||''}\n`; });
    const ms = Date.now() - t0;
    const out = o || 'no data';
    const flag = (out === 'no data') ? ' EMPTY' : '';
    console.log(`[serper] ${label} q="${q.slice(0,80)}" → ${out.length}ch ${ms}ms${flag}`);
    return out;
  } catch(e) {
    const ms = Date.now() - t0;
    console.log(`[serper] ${label} q="${q.slice(0,80)}" → ERR ${ms}ms ${e.message}`);
    return 'err:'+e.message;
  }
}

// searchStructured() — variant of search() that returns BOTH the text blob AND
// the structured rating data when Serper provides it via knowledgeGraph.
// Used specifically for user-named competitor lookups where we want the
// star rating extracted authoritatively rather than text-parsed by the AI.
//
// Returns: { text: string, rating: number|null, reviewCount: number|null, title: string|null }
async function searchStructured(q, opts) {
  opts = opts || {};
  const label = opts.label || 'search';
  const sk = process.env.SERPER_API_KEY;
  if (!sk) { console.log(`[serper] ${label} q="${q}" → NO API KEY`); return { text: 'no api key', rating: null, reviewCount: null, title: null }; }
  const t0 = Date.now();
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': sk, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: 10 })
    });
    const d = await r.json();
    let text = '';
    let rating = null;
    let reviewCount = null;
    let title = null;

    // Knowledge graph — the gold standard for restaurant ratings.
    // Serper's KG can put the review count under any of: reviewCount, ratingCount, ratings.
    if (d.knowledgeGraph) {
      const kg = d.knowledgeGraph;
      title = kg.title || null;
      if (typeof kg.rating === 'number' && kg.rating >= 0 && kg.rating <= 5) rating = kg.rating;
      const kgCount = (typeof kg.reviewCount === 'number' && kg.reviewCount >= 0) ? kg.reviewCount
                    : (typeof kg.ratingCount === 'number' && kg.ratingCount >= 0) ? kg.ratingCount
                    : (typeof kg.ratings === 'number' && kg.ratings >= 0) ? kg.ratings
                    : null;
      if (kgCount !== null) reviewCount = kgCount;
      text += `[${kg.title||''}] Rating:${kg.rating||'N/A'} (${kgCount||0} reviews) ${kg.description||''}\n`;
    }

    // Places block — Serper returns a local-business "places" array for
    // location-intent queries. Each place has rating/ratingCount fields.
    // For restaurant lookups this is often more reliable than knowledgeGraph.
    if (Array.isArray(d.places) && d.places.length > 0) {
      const p = d.places[0];
      if (rating === null && typeof p.rating === 'number' && p.rating >= 0 && p.rating <= 5) {
        rating = p.rating;
      }
      if (reviewCount === null && typeof p.ratingCount === 'number' && p.ratingCount >= 0) {
        reviewCount = p.ratingCount;
      }
      if (!title && p.title) title = p.title;
      // Add places summary to the text blob
      d.places.slice(0, 3).forEach(pl => {
        text += `[PLACE] ${pl.title||''} | rating=${pl.rating||'N/A'} | ${pl.ratingCount||0} reviews | ${pl.address||''}\n`;
      });
    }

    // Organic results — also scan snippets for rating patterns when KG/places missed it
    const organicS = d.organic || [];
    // ALL-1: counted here too. searchStructured runs the focal-context probe
    // and every user-named competitor lookup, so leaving it out would
    // undercount the searches actually run on this assessment.
    noteSearch(currentLedger(), { label });
    noteResults(currentLedger(), { organic: organicS, read: Math.min(8, organicS.length) });
    organicS.slice(0,8).forEach(i => {
      const titleTxt = String(i.title||'');
      const snippetTxt = String(i.snippet||'');
      text += `${titleTxt}: ${snippetTxt}\n`;

      // Fallback: pull rating from snippet OR title (TripAdvisor often puts "4.5 of 5 bubbles" in title)
      if (rating === null) {
        const combined = `${titleTxt} ${snippetTxt}`;
        // Patterns we now catch:
        //   "4.5 stars" / "4.5 star"
        //   "Rating: 4.5"
        //   "4.5/5"
        //   "(4.5/5)"
        //   "4.5 of 5"
        //   "4.5 out of 5"
        //   "★★★★½ 4.5"
        //   "⭐ 4.5"
        //   "Rated 4.5"
        //   Yelp-style "4.5 (888 reviews)"
        //   TripAdvisor "4.5 of 5 bubbles"
        const m = combined.match(/(\d\.\d)\s*(?:\/|of|out of)\s*5/i)
              || combined.match(/rated?\s*[:\s]*(\d\.\d)/i)
              || combined.match(/(?:★|⭐|☆)\s*(\d\.\d)/)
              || combined.match(/(\d\.\d)\s*(?:stars?|★|⭐|bubbles?)/i)
              || combined.match(/rating[:\s]+(\d\.\d)/i);
        if (m) {
          const n = parseFloat(m[1]);
          if (n >= 0 && n <= 5) rating = n;
        }
      }
      // Fallback: pull review count — widened to handle "(2,400)", "2.4k reviews", etc.
      // Tightened: reject single-digit "1" matches from "#1" rank patterns; minimum 3 reviews.
      if (reviewCount === null) {
        const combined = `${titleTxt} ${snippetTxt}`;
        // Reject if the snippet's primary context is a rank like "#1", "No. 1", "Top 1"
        // — those would otherwise get picked up by our number-followed-by-"reviews" regex
        // if the snippet structure is "Rated #1 with reviews".
        const rejectPattern = /(?:#\s*|No\.?\s*|Top\s*)1\s*(?:of|in|restaurant|place)/i;
        if (!rejectPattern.test(combined)) {
          let m = combined.match(/([\d,]+)\s*(?:reviews?|ratings?|opiniones|reseñas)/i)
               || combined.match(/(\d[\d,]*)\s*\+\s*(?:reviews?|ratings?)/i);
          if (m) {
            const n = parseInt(m[1].replace(/,/g, ''), 10);
            if (n >= 3 && n < 1000000) reviewCount = n;
          } else {
            const k = combined.match(/(\d+(?:\.\d+)?)\s*k\s*(?:reviews?|ratings?)/i);
            if (k) {
              const n = Math.round(parseFloat(k[1]) * 1000);
              if (n >= 3 && n < 1000000) reviewCount = n;
            }
          }
        }
      }
    });

    const ms = Date.now() - t0;
    text = text || 'no data';
    const ratingFlag = rating !== null ? ` rating=${rating}` : '';
    const countFlag = reviewCount !== null ? ` count=${reviewCount}` : '';
    console.log(`[serper] ${label} q="${q.slice(0,80)}" → ${text.length}ch ${ms}ms${ratingFlag}${countFlag}`);
    return { text, rating, reviewCount, title };
  } catch(e) {
    const ms = Date.now() - t0;
    console.log(`[serper] ${label} q="${q.slice(0,80)}" → ERR ${ms}ms ${e.message}`);
    return { text: 'err:'+e.message, rating: null, reviewCount: null, title: null };
  }
}

// ── fetchPlacesNearby() — Google Places API authoritative competitor source ─
// Replaces text-mined Serper results for AUTO-DISCOVERED competitors with
// structured Google Maps data. Returns an array of nearby restaurants with:
//   { name, rating (0-5), reviewCount, priceLevel (1-4), types[], vicinity, distance }
//
// Two-stage call:
//   1. Geocode the focal restaurant's location string → lat/lng
//   2. Nearby Search within RADIUS_METERS of that point, type=restaurant
//
// Falls back to empty array (no error thrown) when:
//   - GOOGLE_PLACES_API_KEY not configured
//   - Geocoding returns no results
//   - Nearby Search returns no results or rate-limits
//
// Cost: 1 Geocoding call ($0.005) + 1 Nearby Search call ($0.032) per report.
// At 1000 reports/month: ~$37. Negligible vs. quality gain.
// ── Reverse geocode the resolved coordinate (v8.9.33) ──────────────────────
// Populates benchmarks.cohort_metro, and corrects cohort_country.
//
// WHY REVERSE AND NOT FORWARD. Measured on the four Santiago control subjects:
// reverse geocoding the coordinate returns administrative_area_level_2 =
// "Santiago" for all four, while locality splits the same metro into Vitacura,
// Nunoa, Providencia and Santiago. Forward geocoding the location STRING is not
// stable: the same area came back as "Santiago" for one neighbourhood and
// "Santiago Province" for two others, and administrative_area_level_1 came back
// in Spanish for one and English for the others depending on the result type.
// Adding &language=en did not change the reverse result, so that instability is
// a property of forward lookup rather than a parameter.
//
// WHY THIS COSTS A CALL. The happy path never touches the Geocoding API:
// findplacefromtext is primary and requests only geometry and rating fields,
// and the geocoder runs solely as a ZERO_RESULTS fallback. So there are no
// address components in hand and this is one extra call per assessment, made
// only when a coordinate resolved.
//
// The fallback chain records WHICH component answered. On the sample
// administrative_area_level_2 resolved 6 times out of 6, so the chain rarely
// advances, which is the argument FOR recording it: a row whose metro came from
// administrative_area_level_1 is a different kind of value from one that came
// from level 2, and they are indistinguishable in the column otherwise.
const METRO_CHAIN = ['administrative_area_level_2', 'locality', 'administrative_area_level_1'];
async function reverseGeocodeFocal(lat, lng, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const d = await (await fetch(url)).json();
    if (d.status !== 'OK' || !Array.isArray(d.results) || d.results.length === 0) {
      console.log(`[places] reverse geocode: status=${d.status}, metro unavailable`);
      return null;
    }
    const comps = d.results[0].address_components || [];
    const pick = (t) => { const c = comps.find(x => (x.types || []).includes(t)); return c ? c.long_name : null; };
    let metro = null, metroSource = null;
    for (const t of METRO_CHAIN) { const v = pick(t); if (v) { metro = v; metroSource = t; break; } }
    const country = pick('country');
    console.log(`[places] reverse geocode: metro="${metro || 'null'}" via ${metroSource || 'none'}, country="${country || 'null'}"`);
    return { metro, metroSource, country };
  } catch (e) {
    console.log(`[places] reverse geocode threw: ${e.message}`);
    return null;
  }
}

async function fetchPlacesNearby(opts) {
  // `placeId` is the CALLER'S key, and it wins over anything resolved here.
  // Analytics holds one that its peer gate already confirmed; re-resolving the
  // same subject from its name would produce a second id that is usually the
  // same and occasionally not, with nothing recording which. That is the exact
  // ambiguity a stable key exists to remove, so the gated id is preferred
  // whenever the caller has one.
  const { name, location, placeId: suppliedPlaceId, focal } = opts;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.log('[places] GOOGLE_PLACES_API_KEY not set — auto-discovery falling back to Serper only');
    return { places: [], focalRating: null, focalReviewCount: null, focalLatLng: null, focalGeo: null, focalPlaceId: suppliedPlaceId || null };
  }

  const t0 = Date.now();

  // ── Stage 1: Geocode the focal restaurant ─────────────────────────────
  // We geocode "name, location" rather than just location so the lat/lng lands
  // on the actual restaurant when possible (gives us the focal's own rating
  // as a bonus side-effect).
  let lat = null, lng = null, focalRating = null, focalReviewCount = null;
  // Seeded from the caller when it has a gated id, so the branch below never
  // overwrites it.
  let focalPlaceId = suppliedPlaceId || null;
  // THE CONFIRMED RECORD (overnight 2026-09-26). /resolve-place already made
  // this exact findplacefromtext call and the requester approved its answer,
  // carried here in the signed token. Making it again would cost a second
  // call and could land on a different business from the one approved.
  const reuse = focal && typeof focal.lat === 'number' && typeof focal.lng === 'number';
  if (reuse) {
    lat = focal.lat; lng = focal.lng;
    if (typeof focal.rating === 'number') focalRating = focal.rating;
    if (typeof focal.reviewCount === 'number') focalReviewCount = focal.reviewCount;
    if (!focalPlaceId && typeof focal.placeId === 'string') focalPlaceId = focal.placeId;
    console.log(`[places] confirmed focal reused: reviews=${focalReviewCount ?? 'n/a'}, no second Find Place call`);
  }
  if (!reuse) try {
    const geocodeQuery = `${name}, ${location}`;
    // Use Places Find Place From Text — better than Geocoding API for restaurants
    // because it returns the restaurant's place_id which we can use to fetch
    // the focal's own rating in the same shot.
    const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(geocodeQuery)}&inputtype=textquery&fields=place_id,geometry,name,rating,user_ratings_total,price_level,types&key=${apiKey}`;
    const fr = await fetch(findUrl);
    const fd = await fr.json();
    if (fd.status === 'OK' && Array.isArray(fd.candidates) && fd.candidates.length > 0) {
      const top = fd.candidates[0];
      lat = top.geometry?.location?.lat ?? null;
      lng = top.geometry?.location?.lng ?? null;
      // `place_id` has been in this request's field list since the call was
      // written, and the comment above says why, but the response's copy was
      // never read. This is the whole of RVP's half of subject identity.
      if (!focalPlaceId && typeof top.place_id === 'string') focalPlaceId = top.place_id;
      if (typeof top.rating === 'number') focalRating = top.rating;
      if (typeof top.user_ratings_total === 'number') focalReviewCount = top.user_ratings_total;
      console.log(`[places] geocoded focal: name="${top.name||name}", lat=${lat?.toFixed(4)}, lng=${lng?.toFixed(4)}, rating=${focalRating ?? 'n/a'}, reviews=${focalReviewCount ?? 'n/a'}`);
    } else if (fd.status === 'ZERO_RESULTS') {
      console.log(`[places] geocode ZERO_RESULTS for "${geocodeQuery}" — falling back to location-only geocode`);
      // Fallback: geocode just the location string
      const locUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      const lr = await fetch(locUrl);
      const ld = await lr.json();
      if (ld.status === 'OK' && Array.isArray(ld.results) && ld.results.length > 0) {
        lat = ld.results[0].geometry?.location?.lat ?? null;
        lng = ld.results[0].geometry?.location?.lng ?? null;
        console.log(`[places] geocoded location-only: lat=${lat?.toFixed(4)}, lng=${lng?.toFixed(4)}`);
      }
    } else {
      console.log(`[places] geocode failed: status=${fd.status}, error="${fd.error_message || 'unknown'}"`);
    }
  } catch (e) {
    console.log(`[places] geocode threw: ${e.message}`);
  }

  if (lat === null || lng === null) {
    console.log(`[places] no usable lat/lng — returning empty places`);
    return { places: [], focalRating, focalReviewCount, focalLatLng: null, focalGeo: null, focalPlaceId };
  }

  // Runs only when a coordinate resolved. Every exit above returns focalGeo:
  // null, so the benchmark row records null metro and null country rather than
  // a wrong one derived from the location string.
  const focalGeo = await reverseGeocodeFocal(lat, lng, apiKey);

  // ── Stage 2: Nearby Search within radius ──────────────────────────────
  // Default radius: 2km. Good for dense urban areas (Vitacura, Manhattan, SF).
  // For sparse areas this still returns useful matches; Google sorts by
  // prominence so the top results are typically the most relevant peers.
  const RADIUS_METERS = 2000;
  let places = [];
  try {
    const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${RADIUS_METERS}&type=restaurant&key=${apiKey}`;
    const nr = await fetch(nearbyUrl);
    const nd = await nr.json();
    if (nd.status === 'OK' && Array.isArray(nd.results)) {
      places = nd.results.map(p => ({
        name: p.name || '',
        rating: typeof p.rating === 'number' ? p.rating : null,
        reviewCount: typeof p.user_ratings_total === 'number' ? p.user_ratings_total : null,
        priceLevel: typeof p.price_level === 'number' ? p.price_level : null,
        types: Array.isArray(p.types) ? p.types : [],
        vicinity: p.vicinity || '',
        placeId: p.place_id || '',
        lat: p.geometry?.location?.lat ?? null,
        lng: p.geometry?.location?.lng ?? null,
        // Haversine distance from focal in meters (rough but useful for sorting)
        distance: (() => {
          const pLat = p.geometry?.location?.lat;
          const pLng = p.geometry?.location?.lng;
          if (pLat == null || pLng == null) return null;
          const R = 6371000;
          const φ1 = lat * Math.PI/180, φ2 = pLat * Math.PI/180;
          const Δφ = (pLat-lat) * Math.PI/180;
          const Δλ = (pLng-lng) * Math.PI/180;
          const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
          return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
        })()
      }));
      console.log(`[places] nearby search: ${places.length} restaurants within ${RADIUS_METERS}m, ${Date.now()-t0}ms`);
    } else {
      console.log(`[places] nearby search failed: status=${nd.status}, error="${nd.error_message || 'unknown'}"`);
    }
  } catch (e) {
    console.log(`[places] nearby search threw: ${e.message}`);
  }

  // Drop the focal itself from the peer list (it'll typically be the closest match by name)
  const focalNorm = String(name).trim().toLowerCase();
  const filtered = places.filter(p => {
    const pNorm = String(p.name).trim().toLowerCase();
    return pNorm !== focalNorm && !pNorm.includes(focalNorm) && !focalNorm.includes(pNorm);
  });

  return {
    places: filtered,
    focalRating,
    focalReviewCount,
    focalLatLng: { lat, lng },
    focalGeo,
    focalPlaceId
  };
}

// searchWithFallback() — try progressive queries until one yields substantive content.
// `queries` is an array ordered from most-specific to most-general.
// Returns the first result with > MIN_CHARS of content. If all fall below threshold,
// returns the best (longest) attempt rather than 'no data'.
// MIN_CHARS = 120: filters out lone knowledge-graph one-liners that don't give the AI
// enough to triangulate from. Tune up if reports remain thin; tune down if too aggressive.
const FALLBACK_MIN_CHARS = 120;

// ── Corpus budgeting (v8.9.26) ──────────────────────────────────────────────
// Until now the corpus was assembled in fixed order and handed to the model as
// web.slice(0, 2500) for scoring and web.slice(0, 4500) for prose. Measured on
// the four Santiago control subjects, every search category returns 1,100 to
// 1,700 characters, so the SCORING call saw GOOGLE plus 60 to 84 percent of
// REVIEWS and nothing else. STAFF began at 2,752 to 3,164 characters on every
// subject, always past the cut, and SOCIAL, DELIVERY and COMPETITORS after it.
//
// Four of six pillars were therefore scored with no access to their own
// evidence: es, sm, pa and cp. It also explains why p2 wrote specific employee
// prose on runs where p1 returned exactly 50 for Employee Sentiment. The two
// calls read different windows of the same string.
//
// Worse, [GOOGLE-PLACES] sits inside COMPETITORS at roughly 6,900 characters,
// so neither call ever saw it, despite the p2 prompt calling it authoritative
// and instructing the model to use those names verbatim. Across three stored
// runs with 19 Places results in hand, zero of the model's competitor picks
// matched the Places list; the Places names in the report were appended by the
// renderer, not chosen by the model.
//
// Budget per category rather than truncating the tail, so every pillar's
// evidence reaches the call that scores it. A missing category costs only its
// own slot instead of everything after it.
function budgetCorpus(cats, caps) {
  return Object.entries(cats)
    .map(([k, v]) => `${k}:${String(v == null ? '' : v).slice(0, caps[k] || 0)}`)
    .join('\n');
}

// Scoring calls need all six roughly evenly: each pillar needs its own source.
const CORPUS_CAPS_SCORING = { GOOGLE: 1200, REVIEWS: 1200, STAFF: 1200, SOCIAL: 1000, DELIVERY: 1000, COMPETITORS: 2600 };
// Prose calls pick the competitor set, so COMPETITORS gets the room. Measured
// worst case for that blob after the per-section caps below is about 9,200.
const CORPUS_CAPS_PROSE   = { GOOGLE:  900, REVIEWS: 1400, STAFF: 1400, SOCIAL:  900, DELIVERY:  900, COMPETITORS: 9200 };
// Per-section cap inside the COMPETITORS blob. A user-named section measured
// 6,120 characters because lookupUserNamed joins all four query variants; the
// rating and review count are extracted separately into the section header, so
// capping the text keeps the authoritative numbers.
const COMP_SECTION_CAP = 1200;

// ── Dash sanitizer (v8.9.31) ────────────────────────────────────────────────
// Backstop for the prompt rule added in v8.9.30. The rule is the fix; this is
// what catches the runs where it does not hold.
//
// Entities are decoded to their literal first, then the ordered rules apply, so
// "200&ndash;500" becomes "200-500" by the digit rule rather than "200, 500".
// Entity forms matter more here than in the other products: RVP returns JSON and
// renders in the browser, so &mdash; would pass a literal-character check and
// still reach the reader as a dash.
//
// Replace, never strip. Deleting the en-dash from "5,000–50,000" would yield
// "5,00050,000". The rules are ordered, first match wins:
//   1. between digits   -> hyphen   "10-20"
//   2. spaced, so prose -> comma    "lead, and"
//   3. anything else    -> hyphen   "pre-post"
//
// A hit means the prompt rule did not hold. The marker is deliberately
// greppable: `grep dash-sanitizer` over the production logs answers whether the
// prompt is doing its job, or whether only this backstop is.
const DASH_ENTITY_RE = /&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;/gi;
const DASH_RE = /[\u2014\u2013]/;
function decodeDashEntities(s) {
  return s.replace(DASH_ENTITY_RE, (e) => (/ndash|8211|2013/i.test(e) ? '\u2013' : '\u2014'));
}
function stripDashes(s) {
  const decoded = decodeDashEntities(s);
  if (!DASH_RE.test(decoded)) return decoded;
  console.warn(`[dash-sanitizer] em/en dash in generated string, replaced: ${JSON.stringify(s.slice(0, 160))}`);
  return decoded
    .replace(/(\d)\s*[\u2014\u2013]\s*(\d)/g, '$1-$2')
    .replace(/\s+[\u2014\u2013]\s+/g, ', ')
    .replace(/[\u2014\u2013]/g, '-');
}

// sanitizeReportProse walks a NAMED ALLOW-LIST, not the whole object.
//
// SVP could put its sanitizer inside escapeHtml because every model-authored
// string reached the page through that one function. RVP has no such choke
// point: it returns JSON and the browser renders it. So the equivalent of SVP's
// escapeHtml / escapeHtmlRaw split is made here by FIELD instead of by call
// site, and the fields below are display prose only.
//
// DO NOT REPLACE THIS WITH A WALK OVER THE OBJECT, and do not add the fields
// listed here as excluded. The natural instinct on reading an allow-list is to
// wonder what is missing and add it. Each omission below is deliberate:
//
//   competitors[].name   IS A MATCH KEY, not just display text. It is compared
//     by lowercased string equality in at least seven places (placesByLower,
//     the dedup set, existingNamesLower, the focal-exclusion check). Sanitizing
//     it is safe for today's merge, which has already run by the time this
//     executes, but the sanitized name is what gets STORED in
//     subscribers.baseline_report. The annual path reads that back months later
//     and re-matches it against a freshly scraped, unsanitized name, so a
//     restaurant whose real name contains a dash would silently fail to match
//     itself on the follow-up report. A dash in a stored name is a style
//     violation; breaking self-matching a year later is a product failure that
//     would be nearly impossible to attribute. This is the same defect as the
//     SVP v0.15.0 regression, where escapeHtml rewrote enrollment band values
//     that were also wire identifiers, arriving on a twelve-month delay.
//
//   _debug               diagnostic provenance, including finalCompetitors and
//     topNearby names copied from Google. Rewriting it would corrupt the record
//     used to diagnose exactly this kind of problem.
//
//   scoreVerdict         a wire value. It travels to cohort_extra.score_verdict
//     and to HubSpot as diagnostix_verdict.
//
//   enums                pillars.*.status, actions[].priority,
//     reviewVerbatims[].sentiment, competitorSourceLevel. None can contain a
//     dash, and all are matched by equality downstream.
//
//   onlinePresence.channels[].name   platform labels, effectively identifiers.
//
// Mutates in place and returns the same object, so callers that already hold a
// reference (the benchmark write, the annual store) see the cleaned text.
// ── WHY A COMPETITOR HAS NO RATING ──────────────────────────────────────────
//
// "No public rating found" used to be printed for every one of these, which
// collapsed FOUR different facts into one sentence and made two of them false.
// On the Segreta report, 2026-09-04, live Places lookups on the three names the
// report called unrated: "Zulu" is Zûlu Kitchen & Bar at 4.4 with 625 reviews,
// "El Torro" is El Toro Vitacura at 4.6 with 1,755 reviews, and only "Bodega",
// Camino La Bodega, genuinely has none. Two customers' competitors were
// described as having no public presence while carrying 2,380 reviews between
// them.
//
// A business with no reviews is INFORMATION ABOUT A MARKET, not a failure of
// our search, and the copy says so. A name we could not find is our limit and
// the copy owns that instead.
const RATING_STATE = {
  RATED:          'rated',
  NOT_FOUND:      'not_found',       // looked up, nothing came back
  NOT_LOOKED_UP:  'not_looked_up',   // never searched: past the cap at :799
  UNCONFIRMED:    'unconfirmed',     // resolved, but not confidently this business
  LISTED_UNRATED: 'listed_unrated',  // resolved, operating, genuinely no reviews
};

// UNCONFIRMED and LISTED_UNRATED CANNOT BE PRODUCED YET. Both need a resolution
// attempt, which arrives with the Places lookup per owner-supplied name. They
// are defined here so the two renderers share one vocabulary rather than being
// changed twice, and so the second change is copy-free.
const RATING_STATE_COPY = {
  [RATING_STATE.NOT_FOUND]:      'We could not find this business in public listings',
  [RATING_STATE.NOT_LOOKED_UP]:  'We did not look this business up',
  [RATING_STATE.UNCONFIRMED]:    'We found a possible match but could not confirm it is the business you named',
  [RATING_STATE.LISTED_UNRATED]: 'Listed publicly with no reviews yet',
};

// Every report stored before 2026-09-04 carries no ratingState, and there is no
// way to recover which case it was. This says only what is still true of them.
const RATING_STATE_COPY_UNKNOWN = 'No public rating in the data gathered for this report';

function ratingStateCopy(c) {
  const st = c && c.ratingState;
  return (st && RATING_STATE_COPY[st]) || RATING_STATE_COPY_UNKNOWN;
}

// ── HOW MANY OWNER-SUPPLIED NAMES GET LOOKED UP ─────────────────────────────
//
// Was 3, silently, while the parser at the /diagnose body kept everything the
// owner typed and the safety net below looped over ALL of it. Names past the
// cap were therefore never searched, yet still got a card. Measured across the
// 51 stored reports carrying _debug.userCompetitorsParsed: 6 owners supplied
// more than three names, putting 8 names past the cap, and 8 of 8 were stored
// with a null rating. No exceptions.
//
// 6 rather than unbounded because /diagnose has NO TIMEOUT OF ITS OWN and sits
// on the same 300s Railway edge limit that forced the peer cap to 280s, and
// this runs BEFORE payment, so an owner pasting a long list is unmetered work.
// 6 rather than 5 because the display limit and the lookup limit are separate
// decisions: the report shows 5 cards, but everything the owner typed should be
// looked up, and which 5 get shown is then a choice made with data rather than
// by truncating the input.
const USER_COMPETITOR_LOOKUP_CAP = 6;

// ── MATCHING A HAND-TYPED NAME TO A PLACES RESULT ───────────────────────────
//
// Deliberately LOOSER than the peer gate's nameAgreement, and the difference is
// the point. There a false match costs a full assessment and a fabricated peer
// inside a published comparison, so its floor is high: it rejects "El Torro"
// against "El Toro Vitacura" because `el` is a stop token and `torro` shares no
// token with `toro`. Here a false match costs a wrong number on a descriptive
// card, and the input is a name a restaurant owner typed by hand, which is
// exactly where misspellings live. Rejecting the misspelling would reject the
// case this exists to fix.
//
// So: content tokens, accent-folded, with edit distance 1 tolerated on tokens
// of four characters or more. "torro" matches "toro"; "Zulu" matches the
// accented "Zûlu". Nothing is discarded on a miss, it is REPORTED as
// unconfirmed, because a name we found something for but cannot vouch for is
// its own fact and the customer should get it as one.
const COMP_MATCH_STOPWORDS = new Set([
  'restaurant','restaurants','restaurante','restaurantes','bar','bars','cafe','cafes',
  'bistro','grill','lounge','kitchen','pizzeria','pizzerias','bakery','brewery',
  'the','and','of','in','at','de','del','la','el','los','las','y','n',
]);
function compFold(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function compTokens(v, locationHint) {
  const loc = new Set(compFold(locationHint).split(/[^a-z0-9]+/).filter(Boolean));
  return new Set(
    compFold(v).split(/[^a-z0-9]+/)
      .filter(t => t.length > 2 && !COMP_MATCH_STOPWORDS.has(t) && !loc.has(t))
  );
}
function editDistance1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length) { i++; j++; }
    else if (a.length > b.length) i++;
    else j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// True when the typed name and the resolved name share at least one content
// token, allowing a single typo on tokens long enough for that to be safe.
function compNamesAgree(typed, resolved, locationHint) {
  const q = compTokens(typed, locationHint);
  const r = compTokens(resolved, locationHint);
  if (!q.size || !r.size) return false;
  for (const a of q) {
    for (const b of r) {
      if (a === b) return true;
      if (a.length >= 4 && b.length >= 4 && editDistance1(a, b)) return true;
    }
  }
  return false;
}

// One findplacefromtext call for a competitor name. Same endpoint and the same
// field list already used to geocode the focal restaurant, so this adds a call
// site rather than a dependency: no new key, no new service, no cross-project
// hop on the unpaid path.
async function findPlaceForCompetitor(query) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { ok: false, reason: 'no_key' };
  const fields = 'place_id,name,geometry,rating,user_ratings_total,business_status';
  const url = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json'
    + `?input=${encodeURIComponent(query)}&inputtype=textquery&fields=${fields}&key=${apiKey}`;
  try {
    const d = await (await fetch(url)).json();
    const c = Array.isArray(d.candidates) ? d.candidates[0] : null;
    if (d.status !== 'OK' || !c) return { ok: false, reason: d.status || 'UNKNOWN' };
    return {
      ok: true,
      placeId: c.place_id || null,
      name: c.name || null,
      rating: typeof c.rating === 'number' ? c.rating : null,
      reviewCount: typeof c.user_ratings_total === 'number' ? c.user_ratings_total : null,
      businessStatus: c.business_status || null,
    };
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', detail: String(e && e.message).slice(0, 120) };
  }
}

function sanitizeReportProse(report) {
  if (!report || typeof report !== 'object') return report;
  const S = (v) => (typeof v === 'string' ? stripDashes(v) : v);
  const arr = (a) => (Array.isArray(a) ? a.map(S) : a);

  for (const k of ['executiveSummary', 'ownerSentimentSummary', 'sentimentGap',
                   'businessRealityAnalysis', 'perceptionGap', 'employeeSentiment',
                   'competitiveInsight', 'competitorSourceNote']) {
    if (typeof report[k] === 'string') report[k] = stripDashes(report[k]);
  }
  if (Array.isArray(report.strengths)) report.strengths = arr(report.strengths);
  if (Array.isArray(report.risks))     report.risks     = arr(report.risks);
  if (report.themes && typeof report.themes === 'object') {
    for (const k of Object.keys(report.themes)) report.themes[k] = arr(report.themes[k]);
  }
  if (report.pillarGapNarratives && typeof report.pillarGapNarratives === 'object') {
    for (const k of Object.keys(report.pillarGapNarratives)) report.pillarGapNarratives[k] = S(report.pillarGapNarratives[k]);
  }
  for (const c of (report.onlinePresence && report.onlinePresence.channels) || []) if (c) c.note = S(c.note);
  for (const v of report.reviewVerbatims || []) if (v) v.text = S(v.text);
  for (const c of report.competitors || []) if (c) c.note = S(c.note);   // .name deliberately untouched
  for (const a of report.actions || []) { if (!a) continue; a.title = S(a.title); a.desc = S(a.desc); }
  for (const a of report.commercialActions || []) { if (!a) continue; a.title = S(a.title); a.desc = S(a.desc); a.evidence = S(a.evidence); }
  if (report.progress && typeof report.progress === 'object') {
    report.progress.progressNarrative = S(report.progress.progressNarrative);
    if (Array.isArray(report.progress.completedActions))  report.progress.completedActions  = arr(report.progress.completedActions);
    if (Array.isArray(report.progress.ongoingPriorities)) report.progress.ongoingPriorities = arr(report.progress.ongoingPriorities);
  }
  return report;
}
async function searchWithFallback(queries, opts) {
  opts = opts || {};
  const label = opts.label || 'search';
  let best = { out: 'no data', len: 0, attempt: 0 };
  for (let i = 0; i < queries.length; i++) {
    const out = await search(queries[i], { label: `${label} try${i+1}/${queries.length}` });
    const usable = (out && out !== 'no data' && out !== 'no api key' && !out.startsWith('err:'));
    if (usable && out.length >= FALLBACK_MIN_CHARS) {
      if (i > 0) console.log(`[serper] ${label} RECOVERED on attempt ${i+1}/${queries.length}`);
      return out;
    }
    if (usable && out.length > best.len) best = { out, len: out.length, attempt: i+1 };
  }
  if (best.len > 0) {
    console.log(`[serper] ${label} BELOW THRESHOLD — returning best attempt (${best.attempt}/${queries.length}, ${best.len}ch)`);
    return best.out;
  }
  console.log(`[serper] ${label} EXHAUSTED — all ${queries.length} attempts empty`);
  return 'no data';
}

// ── detectFocalContext() — extract cuisine + price tier from focal restaurant ──
// Fast pre-scan via searchStructured() that pulls the restaurant's basic
// Google Knowledge Graph + organic snippets, then text-mines for cuisine
// (e.g. "Peruvian-Chinese fusion", "Japanese", "steakhouse") and price tier
// signals (e.g. "$$$$", "fine dining", "upscale", "casual", "fast-casual",
// "high-end", "budget"). Returns:
//   { cuisine: string|null, tier: 'fine-dining'|'upscale-casual'|'casual'|'budget'|null }
//
// Used to build smarter, tier-aware competitor search queries so we don't
// match a premium fusion concept against random low-rated places.
async function detectFocalContext({ name, location }) {
  const t = Date.now();
  // One quick search — the focal restaurant's main listing is usually enough.
  const result = await searchStructured(`${name} restaurant ${location}`, { label: 'FOCAL-CTX' })
    .catch(e => ({ text: '', rating: null, reviewCount: null, title: null }));
  const text = String(result.text || '').toLowerCase();

  // Cuisine detection — scan for common cuisine words. Order matters: more
  // specific compound terms first (e.g. "peruvian-chinese fusion" before
  // either "peruvian" or "chinese" or "fusion" alone).
  const cuisinePatterns = [
    /peruvian[- ]chinese\s*fusion/, /asian\s*fusion/, /pan[- ]asian/, /latin\s*fusion/,
    /steakhouse/, /churrascaria/, /seafood/, /sushi\s*bar/, /omakase/,
    /italian/, /trattoria/, /pizzeria/, /french/, /bistro/, /brasserie/,
    /japanese/, /chinese/, /thai/, /vietnamese/, /korean/, /indian/,
    /mexican/, /peruvian/, /argentinian/, /brazilian/, /spanish/, /tapas/,
    /mediterranean/, /lebanese/, /greek/, /turkish/,
    /american/, /barbecue|bbq/, /burger/, /vegan/, /vegetarian/,
    /farm[- ]to[- ]table/, /seasonal/, /tasting\s*menu/,
    /breakfast/, /brunch/, /cafe/, /bakery/, /pastry/, /dessert/
  ];
  let cuisine = null;
  for (const pat of cuisinePatterns) {
    const m = text.match(pat);
    if (m) { cuisine = m[0]; break; }
  }

  // Tier detection — price markers + tier keywords.
  // Order: most-specific first. Fall through to default null when no signal.
  let tier = null;
  if (/\$\$\$\$|fine[- ]dining|tasting\s*menu|haute\s*cuisine|michelin/.test(text)) {
    tier = 'fine-dining';
  } else if (/\$\$\$|upscale|premium|high[- ]end|elegant|sophisticated|refined/.test(text)) {
    tier = 'upscale-casual';
  } else if (/\$\$|casual\s*dining|mid[- ]range|family[- ]friendly/.test(text)) {
    tier = 'casual';
  } else if (/\$(?!\$)|fast[- ]casual|budget|cheap|affordable|takeout/.test(text)) {
    tier = 'budget';
  }

  console.log(`[serper] FOCAL-CTX detected: cuisine="${cuisine || '(none)'}", tier="${tier || '(none)'}", rating=${result.rating}, ${Date.now()-t}ms`);
  return { cuisine, tier, rating: result.rating, reviewCount: result.reviewCount };
}

// ── searchCompetitorsMultiple() — multi-pronged competitor discovery ─────
// Replaces the old single-query competitor search with 5 parallel layers:
//   1. User-supplied competitors (highest trust) — each name searched individually
//      so we get ratings/review counts from real Google/TripAdvisor data.
//   2. "Similar to X in Y" search — surfaces Google's "people also search for"
//      relations which match competing concepts.
//   3. Neighborhood-narrowed search — uses the first comma-separated piece of
//      location (e.g. "Vitacura" from "Vitacura, Santiago, Chile") for
//      hyper-local results.
//   4. "Top restaurants in city" — broad fallback that always returns something.
//   5. Region-specific generic competitor queries (the existing fallback).
//
// All 5 layers run in parallel via Promise.all then their outputs are merged
// with category labels so the AI prompt can see which pile each name came from.
// Total elapsed is roughly the slowest single layer, not the sum, so cost is
// minimal vs the old single search.
async function searchCompetitorsMultiple(opts) {
  const { name, location, region, userCompetitors, focalContext, placeId, focal } = opts;

  // Parse "City/Neighborhood, State, Country" or "City, Country" location formats.
  // Real inputs include:
  //   "Larkspur Landing, CA, USA"  → city=Larkspur Landing, state=CA
  //   "Vitacura, Santiago, Chile"   → city=Vitacura, state=Santiago
  //   "Santiago, Chile"             → city=Santiago, state=null
  //   "Brooklyn, NY"                → city=Brooklyn, state=NY
  // The first part is always the local descriptor (neighborhood or city).
  // The last part is the country. Anything in between is state/region.
  const locParts = String(location || '').split(',').map(s => s.trim()).filter(Boolean);
  const localArea = locParts.length > 0 ? locParts[0] : '';
  const stateOrRegion = locParts.length >= 3 ? locParts[locParts.length - 2] : '';
  // Build the strongest location string for search queries: prefer "City, State"
  // (e.g. "Larkspur Landing, CA") over bare "City" because it dramatically
  // narrows results for ambiguous restaurant names like "Left Bank" or "RH".
  const searchLoc = stateOrRegion
    ? `${localArea}, ${stateOrRegion}`
    : localArea || String(location || '');
  // Neighborhood-level queries use just the first part when 3+ parts exist.
  const neighborhood = (locParts.length >= 3) ? localArea : '';

  // Build cuisine + tier descriptors to inject into similar/neighborhood/top queries.
  // E.g. focal is "fine-dining peruvian-chinese fusion" → queries become
  // "best fine-dining peruvian-chinese fusion restaurants Vitacura" instead of
  // a generic "best restaurants Vitacura".
  const fc = focalContext || {};
  const cuisineDesc = fc.cuisine ? fc.cuisine.trim() : '';
  const tierDesc = fc.tier === 'fine-dining' ? (region === 'LATAM' ? 'alta cocina' : 'fine dining')
                 : fc.tier === 'upscale-casual' ? (region === 'LATAM' ? 'premium' : 'upscale')
                 : fc.tier === 'casual' ? (region === 'LATAM' ? 'casual' : 'casual')
                 : fc.tier === 'budget' ? (region === 'LATAM' ? 'económico' : 'budget')
                 : '';
  // Combined descriptor for query injection (skip empties cleanly)
  const tierCuisineEn = [tierDesc, cuisineDesc].filter(Boolean).join(' ').trim();
  // Spanish doesn't use cuisine adjective the same way — keep tier+cuisine readable
  const tierCuisineEs = [tierDesc, cuisineDesc].filter(Boolean).join(' ').trim();

  console.log(`[serper] COMP-MULTI locale: searchLoc="${searchLoc}", neighborhood="${neighborhood || '(none)'}", focal="${tierCuisineEn || '(generic)'}"`);

  // Layer 1: User-supplied competitors. Each name gets 2 parallel searches
  // using searchStructured() which extracts rating/reviewCount directly from
  // Serper's knowledgeGraph and from organic-result snippets. This is more
  // reliable than asking the AI to text-parse the same data, and gives us
  // authoritative rating data we can inject directly into the response.
  //
  // Returns structured per-competitor data alongside the text blob.
  const userNames = Array.isArray(userCompetitors)
    ? userCompetitors.slice(0, USER_COMPETITOR_LOOKUP_CAP).filter(n => n && n.trim().length >= 3)
    : [];

  // Run 2 query variants per user-named competitor in parallel. We keep the
  // best rating found across both — KG-first, then snippet patterns.
  async function lookupUserNamed(competitorName) {
    const queries = [
      // Variant A: Google Maps intent — most likely to return Serper's "places" array
      // with structured rating/ratingCount fields (the cleanest source).
      `${competitorName} restaurant ${searchLoc}`,
      // Variant B: explicit review/rating intent — surfaces TripAdvisor/Yelp pages
      // whose titles often contain "4.5 of 5 bubbles" or "4.5 stars" patterns.
      `${competitorName} ${searchLoc} reviews rating`,
      // Variant C: quoted name — strict matching for ambiguous names like "Left Bank"
      `"${competitorName}" ${searchLoc}`,
      // Variant D: TripAdvisor-targeted — TripAdvisor pages have very consistent
      // rating extraction via knowledgeGraph and snippet patterns like "4.5 of 5 bubbles".
      `${competitorName} ${searchLoc} TripAdvisor`
    ];
    const t = Date.now();
    // Places runs in the SAME Promise.all as the Serper variants, so it costs
    // nothing in wall clock. It is queried the way the peer gate queries a peer,
    // "name, location", because a competitor name arrives with no location of
    // its own.
    const placeQuery = searchLoc ? `${competitorName}, ${searchLoc}` : competitorName;
    const [placeHit, ...results] = await Promise.all([
      findPlaceForCompetitor(placeQuery),
      ...queries.map(q =>
        searchStructured(q, { label: `COMP-USER[${competitorName}]` })
          .catch(e => { console.log(`[serper] COMP-USER[${competitorName}] error: ${e.message}`); return { text: '', rating: null, reviewCount: null, title: null }; })
      ),
    ]);
    // Pick best signal across variants
    let bestRating = null, bestCount = null, bestTitle = null;
    const textChunks = [];
    for (const r of results) {
      textChunks.push(r.text || '');
      if (r.rating !== null && bestRating === null) bestRating = r.rating;
      if (r.reviewCount !== null && (bestCount === null || r.reviewCount > bestCount)) bestCount = r.reviewCount;
      if (r.title && !bestTitle) bestTitle = r.title;
    }
    const text = textChunks.join('\n---\n');
    // A resolved place that does not agree with the typed name is NOT treated as
    // a find. It is reported as unconfirmed, and its rating is withheld: putting
    // 4.6 stars on a card for a business the owner may not have meant is the one
    // outcome worse than no number.
    const placeAgrees = placeHit.ok && compNamesAgree(competitorName, placeHit.name, searchLoc);
    console.log(`[serper] COMP-USER[${competitorName}] aggregated: rating=${bestRating} count=${bestCount} title="${bestTitle||''}" ${Date.now()-t}ms`
      + ` | places: ${placeHit.ok ? `"${placeHit.name}" rating=${placeHit.rating ?? 'none'} reviews=${placeHit.reviewCount ?? 'none'} agrees=${placeAgrees}` : 'miss(' + placeHit.reason + ')'}`);
    return {
      userName: competitorName,
      resolvedTitle: bestTitle,
      rating: bestRating,
      reviewCount: bestCount,
      placeFound: !!placeHit.ok,
      placeAgrees,
      placeName: placeHit.ok ? placeHit.name : null,
      placeId: placeHit.ok ? placeHit.placeId : null,
      placeRating: placeHit.ok ? placeHit.rating : null,
      placeReviewCount: placeHit.ok ? placeHit.reviewCount : null,
      text
    };
  }

  const userSearches = userNames.map(n => lookupUserNamed(n));

  // Layer 2: "Similar to X" + cuisine/tier-narrowed — Google often surfaces "people also
  // search for" panels here, which are great signals for direct concept-overlap competitors.
  // When we know the focal restaurant's cuisine/tier, narrow the queries to filter out
  // mismatched concepts (e.g. avoid surfacing budget burger spots when focal is fine-dining sushi).
  const similarSearches = [
    searchWithFallback(
      region === 'LATAM'
        ? [
            `restaurantes similares a ${name} ${searchLoc}`,
            tierCuisineEs ? `mejores restaurantes ${tierCuisineEs} ${searchLoc}` : `alternativas a ${name} ${searchLoc}`,
            `restaurants like ${name} ${searchLoc}`
          ]
        : [
            `restaurants like ${name} ${searchLoc}`,
            tierCuisineEn ? `best ${tierCuisineEn} restaurants ${searchLoc}` : `restaurants similar to ${name} ${searchLoc}`,
            `alternatives to ${name} ${searchLoc}`
          ],
      { label: 'COMP-SIMILAR' }
    )
  ];

  // Layer 3: Neighborhood-narrowed + cuisine/tier-aware (only when location has 3+ parts).
  const neighborhoodSearches = neighborhood ? [
    searchWithFallback(
      region === 'LATAM'
        ? [
            tierCuisineEs ? `mejores restaurantes ${tierCuisineEs} ${neighborhood} ${stateOrRegion}` : `mejores restaurantes ${neighborhood} ${stateOrRegion}`,
            `restaurantes ${neighborhood}`,
            `dónde comer ${neighborhood}`
          ]
        : [
            tierCuisineEn ? `best ${tierCuisineEn} restaurants ${neighborhood} ${stateOrRegion}` : `best restaurants ${neighborhood} ${stateOrRegion}`,
            `top restaurants ${neighborhood}`,
            `where to eat ${neighborhood}`
          ],
      { label: 'COMP-NEIGHBORHOOD' }
    )
  ] : [];

  // Layer 4: Broad "top restaurants" + cuisine/tier-aware — last-mile fallback.
  const topSearches = [
    searchWithFallback(
      region === 'LATAM'
        ? [
            tierCuisineEs ? `mejores restaurantes ${tierCuisineEs} ${searchLoc} TripAdvisor` : `mejores restaurantes ${searchLoc} TripAdvisor`,
            `top restaurants ${searchLoc}`,
            `restaurantes recomendados ${searchLoc}`
          ]
        : [
            tierCuisineEn ? `top ${tierCuisineEn} restaurants ${searchLoc} TripAdvisor` : `top restaurants ${searchLoc} TripAdvisor`,
            `best restaurants ${searchLoc}`,
            `highly rated restaurants ${searchLoc}`
          ],
      { label: 'COMP-TOP' }
    )
  ];

  // Run all layers in parallel — cost is approximately the slowest single
  // layer, not the sum, because Promise.all multiplexes the Serper requests.
  // userSearches resolve to structured objects { userName, rating, reviewCount, text };
  // other layers resolve to plain text strings.
  // placesPromise resolves to { places, focalRating, focalReviewCount, focalLatLng } —
  // Google Places is the AUTHORITATIVE source for auto-discovered competitors.
  const placesPromise = fetchPlacesNearby({ name, location, placeId, focal });
  const t0 = Date.now();
  const [userResults, placesData, ...otherResults] = await Promise.all([
    Promise.all(userSearches),
    placesPromise,
    ...similarSearches,
    ...neighborhoodSearches,
    ...topSearches
  ]);
  const elapsed = Date.now() - t0;

  // Stitch together with provenance labels so the AI can see which pile each
  // chunk came from. User-supplied names get priority placement at the top.
  const sections = [];
  let otherIdx = 0;
  // [GOOGLE-PLACES] goes FIRST. It is the only structured, authoritative layer,
  // and putting it first means it survives any downstream budget. It used to sit
  // after the user-named sections: measured with three user-named competitors it
  // started 18,342 characters into the blob, so any cap that fit the no-user-named
  // case (where it starts at 0) would have silently dropped it in the case where
  // an owner named competitors. That is the same truncation defect in a rarer and
  // harder to attribute form, which is why the order changed rather than the cap.
  if (placesData && placesData.places && placesData.places.length > 0) {
    const placesLines = placesData.places.slice(0, 15).map((p, i) =>
      `${i+1}. ${p.name} | rating=${p.rating ?? 'n/a'} | reviews=${p.reviewCount ?? 'n/a'} | priceLevel=${p.priceLevel ?? 'n/a'} | distance=${p.distance ?? 'n/a'}m | types=${(p.types || []).slice(0,3).join(',')}`
    ).join('\n');
    sections.push(`[GOOGLE-PLACES] (authoritative, use these names verbatim; ratings are from Google Maps directly)\n${placesLines}`);
  }
  for (const userResult of userResults) {
    const ratingHint = (userResult.rating !== null || userResult.reviewCount !== null)
      ? ` (extracted rating=${userResult.rating ?? 'n/a'}, reviews=${userResult.reviewCount ?? 'n/a'})`
      : '';
    sections.push(`[USER-NAMED: ${userResult.userName}]${ratingHint}\n${String(userResult.text || '').slice(0, COMP_SECTION_CAP)}`);
  }
  sections.push(`[SIMILAR-TO]\n${String(otherResults[otherIdx++] || '').slice(0, COMP_SECTION_CAP)}`);
  if (neighborhoodSearches.length) sections.push(`[NEIGHBORHOOD]\n${String(otherResults[otherIdx++] || '').slice(0, COMP_SECTION_CAP)}`);
  sections.push(`[TOP-IN-CITY]\n${String(otherResults[otherIdx++] || '').slice(0, COMP_SECTION_CAP)}`);

  const merged = sections.join('\n\n---\n\n');
  const ratingsFound = userResults.filter(r => r.rating !== null).length;
  const placesCount = placesData?.places?.length || 0;
  console.log(`[serper] COMP-MULTI: ${sections.length} layers, ${userNames.length} user-named (${ratingsFound} with ratings), ${placesCount} Google Places nearby, ${elapsed}ms, ${merged.length}ch`);
  return { merged, userNames, userResults, placesData };
}

// ── claude() — JSON-output wrapper around Anthropic /v1/messages ─────
// FIXED (v8.3 → v8.4, refined in v8.5): The previous version used max_tokens: 2000, which
// truncated part 2 of /diagnose for restaurants with rich scraped content.
// The truncated JSON then failed JSON.parse with "Unexpected end of JSON input".
//
// Changes in this version:
//   1. max_tokens raised from 2000 → 8000 (Sonnet 4.5 supports far more;
//      8000 is comfortable headroom for the largest current payload).
//   2. stop_reason is checked and logged on every call. Truncation is now
//      visible in Railway logs as "WARNING: stop_reason=max_tokens".
//   3. ```json fences and surrounding prose are stripped before parsing,
//      so wrapped responses no longer fail.
//   4. ONE automatic retry on parse failure at max_tokens=16000 with a
//      "keep strings concise" reinforcement. Self-heals freak long responses.
//
// Callers may optionally pass { label, maxTokens, retryOnParseFail } to
// customise logging and behaviour per call site, but defaults are right
// for /diagnose. The annual caller went in v8.10.0.
// v8.11.52: BEHIND A REBINDABLE NAME, for the same reason node-fetch is.
// A test that cannot replace the model call cannot test a gate that runs on
// the model's output, and the alternative is spending on every test run.
// 2026-09-29 (recommendation 7): the model-call timeout. RVP_MODEL_TIMEOUT_MS
// overrides it (the tests use 60 ms); production sets nothing.
const MODEL_TIMEOUT_MS_DEFAULT = 180000;

let claude = async function claudeImpl(prompt, opts) {
  opts = opts || {};
  const maxTokens         = opts.maxTokens         || 8000;
  const retryOnParseFail  = opts.retryOnParseFail  !== false; // default true
  const label             = opts.label             || 'claude';
  const model             = opts.model             || 'claude-sonnet-4-5-20250929';

  const ak = process.env.ANTHROPIC_API_KEY;
  if (!ak) throw new Error('ANTHROPIC_API_KEY missing');

  // Single Anthropic call — returns {ok:true,data,stopReason} or {ok:false,...diag}
    // v8.11.52: THE BILLED TOKENS, WHEN THE CALLER ASKS FOR THEM.
  //
  // The regeneration script needs input_tokens and output_tokens to compute a
  // measured total, and its first version got them by making a DIRECT
  // Anthropic call instead. That bypass cost it retryOnParseFail, and one of
  // its two measuring calls came back as unparseable JSON with nothing to
  // catch it. A caller should not have to choose between the retry and the
  // measurement.
  const withUsage = opts.withUsage === true;
  let lastUsage = null;

  async function callOnce(tokenBudget, extraInstruction) {
    const systemPrompt = 'You are a JSON API. Output ONLY valid JSON. No markdown. No backticks. Start with { end with }. CRITICAL: All text values in the JSON must be written in English, regardless of the language of the source data or the restaurant\'s location.'
      + (extraInstruction ? ' ' + extraInstruction : '');

    // 2026-09-29 (recommendation 7): EVERY MODEL CALL HAS A TIMEOUT. Before
    // this a hung call held the buyer on the thinking screen until the
    // platform gave up. A timeout, a network failure or a 5xx is marked
    // retryable; the caller below retries it once.
    const timeoutMs = Number(process.env.RVP_MODEL_TIMEOUT_MS) || MODEL_TIMEOUT_MS_DEFAULT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let r, rawBody;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ak,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: tokenBudget,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal,
      });
      // Read body as text first so we can log it on failure (Anthropic 5xx etc.).
      rawBody = await r.text();
    } catch (e) {
      const timedOut = controller.signal.aborted;
      const err = new Error(timedOut ? 'Anthropic call timed out after ' + timeoutMs + ' ms' : 'Anthropic network error: ' + (e && e.message));
      err.retryable = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (r.status >= 500) {
      console.log(`[${label}] Anthropic status ${r.status}:`, String(rawBody).slice(0, 200));
      const err = new Error('Anthropic ' + r.status + ': ' + String(rawBody).slice(0, 120));
      err.retryable = true;
      throw err;
    }
    let d;
    try {
      d = JSON.parse(rawBody);
    } catch(parseErr) {
      console.log(`[${label}] Anthropic returned non-JSON envelope (status ${r.status}):`, rawBody.slice(0, 300));
      throw new Error('Anthropic non-JSON envelope: status ' + r.status);
    }
    if (d.error) {
      console.log(`[${label}] Anthropic error:`, JSON.stringify(d.error));
      throw new Error(d.error.message || 'Anthropic error');
    }

    // Log stop_reason — truncation is now explicit, not silent.
    const stopReason = d.stop_reason || 'unknown';
    const usage = d.usage || {};
    if (stopReason === 'max_tokens') {
      console.log(`[${label}] WARNING: stop_reason=max_tokens (budget=${tokenBudget}, output_tokens=${usage.output_tokens || '?'}) — response was truncated`);
    } else {
      console.log(`[${label}] stop_reason=${stopReason}, output_tokens=${usage.output_tokens || '?'}/${tokenBudget}`);
    }

    // Extract text content from the content array.
    let t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Defensive: strip ```json or ``` fences if Claude wrapped its output
    // despite the system instruction. Cheap insurance.
    if (t.startsWith('```')) {
      t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    // Attempt 1: parse full text as-is.
    lastUsage = usage;
    try { return { ok: true, data: JSON.parse(t), stopReason }; } catch(e) {}

    // Attempt 2: slice between first { and last } in case there is leading/
    // trailing prose. Note: this CANNOT rescue truncated output (no closing }
    // exists), it only saves complete-but-wrapped responses.
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return { ok: true, data: JSON.parse(t.slice(i, j + 1)), stopReason }; } catch(e) {}
    }

    return {
      ok: false,
      stopReason,
      preview: t.slice(0, 200),
      length: t.length,
      truncated: stopReason === 'max_tokens'
    };
  }

  // ONE retry on a timeout, a network failure or a 5xx, after a short pause.
  // A 4xx is not retried: it will fail the same way twice.
  async function callWithRetry(tokenBudget, extraInstruction) {
    try {
      return await callOnce(tokenBudget, extraInstruction);
    } catch (e) {
      if (!e || !e.retryable) throw e;
      console.log(`[${label}] MODEL_RETRY after: ${e.message}`);
      await new Promise((res) => setTimeout(res, Number(process.env.RVP_MODEL_RETRY_DELAY_MS) || 1500));
      return callOnce(tokenBudget, extraInstruction);
    }
  }

  // Attempt 1: normal budget.
  let result = await callWithRetry(maxTokens);
  if (result.ok) return withUsage ? { data: result.data, usage: lastUsage || {}, model } : result.data;

  console.log(`[${label}] parse failed on attempt 1 — stop_reason=${result.stopReason}, length=${result.length}ch, truncated=${result.truncated}, preview="${result.preview}"`);

  if (!retryOnParseFail) {
    throw new Error('JSON parse failed (no retry): ' + result.preview);
  }

  // Attempt 2: larger budget + concise-output reinforcement.
  console.log(`[${label}] retrying with max_tokens=16000 and length reinforcement...`);
  result = await callWithRetry(16000, 'Your previous attempt was truncated. Keep all string values concise (1-2 sentences max per field). Return ONLY valid JSON.');

  if (result.ok) {
    console.log(`[${label}] retry succeeded`);
    return withUsage ? { data: result.data, usage: lastUsage || {}, model } : result.data;
  }

  console.log(`[${label}] retry also failed — stop_reason=${result.stopReason}, length=${result.length}ch, preview="${result.preview}"`);
  throw new Error('JSON parse failed after retry: ' + result.preview);
};

// ── EMAIL VIA RESEND ─────────────────────────────────────────
async function sendEmailViaResend({ to, subject, html, fromName, bcc }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || 'reports@4xi360.com';
  if (!key) {
    console.log('[email] RESEND_API_KEY missing, skipping send to', maskAddr(to));
    return { ok: false, reason: 'missing key' };
  }

  // 2026-09-24 (Simon): a test run says so. scripts/guard-test-env.cjs starts
  // every suite with DIAGNOSTIX_TEST_RUN=1; production never sets it.
  const payload = {
    from: (fromName || 'DiagnostiX') + ' <' + from + '>',
    to: [to],
    subject: (process.env.DIAGNOSTIX_TEST_RUN === '1' ? '[TEST RUN] ' : '') + subject,
    html
  };
  if (bcc && bcc.length) {
    payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
  }

  // Single attempt — returns one of: {ok:true,id}, {ok:false,reason,retryable:bool}
  async function attempt() {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // Resend usually returns JSON, but on timeouts/rate-limits/5xx it can
      // return HTML/text. Read as text first, then try to parse safely.
      const rawBody = await r.text();
      let d;
      try {
        d = rawBody ? JSON.parse(rawBody) : {};
      } catch(parseErr) {
        // Non-JSON response → almost always a transient infra issue (408, 502, 503, 504).
        const retryable = r.status === 408 || r.status === 429 || (r.status >= 500 && r.status < 600);
        console.log('[email] Resend returned non-JSON (status ' + r.status + '):', rawBody.slice(0, 200));
        return { ok: false, reason: 'non-json response (status ' + r.status + ')', retryable };
      }

      if (d.id) {
        return { ok: true, id: d.id };
      }
      // JSON error response — retryable if status code indicates transient issue.
      const retryable = r.status === 408 || r.status === 429 || (r.status >= 500 && r.status < 600);
      console.log('[email] Resend rejected (status ' + r.status + '):', JSON.stringify(d));
      return { ok: false, reason: d.message || d.error || 'unknown', retryable };
    } catch(e) {
      // Network failure (fetch threw) — always worth one retry.
      console.log('[email] send failed:', e.message);
      return { ok: false, reason: e.message, retryable: true };
    }
  }

  // First attempt
  let result = await attempt();
  if (result.ok) {
    console.log('[email] sent to', maskAddr(to), bcc ? '| bcc: ' + maskAddr(Array.isArray(bcc) ? bcc[0] : bcc) : '', '| id:', result.id);
    return result;
  }

  // Retry once on transient errors after a 2s backoff
  if (result.retryable) {
    console.log('[email] transient failure — retrying in 2s:', result.reason);
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = await attempt();
    if (result.ok) {
      console.log('[email] sent to', maskAddr(to), bcc ? '| bcc: ' + maskAddr(Array.isArray(bcc) ? bcc[0] : bcc) : '', '| id:', result.id, '(after retry)');
      return result;
    }
    console.log('[email] retry also failed:', result.reason);
  }

  // 2026-09-29 (recommendation 7): A CUSTOMER EMAIL THAT STILL FAILS IS
  // ALERTED. Before this the final failure was a log line, so the business
  // learned of an undelivered report when the buyer wrote in. The alert names
  // the subject and the reason, never the address (addrLabel only). An alert
  // that fails is never itself alerted: that would loop on a Resend outage.
  if (to !== ALERT_TO) {
    console.log('[email] EMAIL_FAILED_FINAL to=' + addrLabel(to) + ' reason=' + result.reason);
    const escA = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    sendEmailViaResend({
      to: ALERT_TO,
      subject: 'ALERT: a customer email failed, ' + addrLabel(to),
      fromName: 'DiagnostiX Alerts',
      html: '<p><strong>A customer email failed after its retry. The customer has not received it.</strong></p>'
        + '<ul><li>subject: ' + escA(subject) + '</li><li>address: ' + escA(addrLabel(to)) + '</li>'
        + '<li>reason: ' + escA(result.reason) + '</li></ul>',
    }).catch(() => {});
  }
  return result;
}
// The internal inbox every alert goes to (the same address the existing alerts use).
const ALERT_TO = 'hello@4xiconsulting.com';

// 2026-09-29 (recommendation 7): A FAILED ASSESSMENT IS ALERTED. /diagnose
// returned 500 with no row and no alert (C4). Analytics' peer runs call the
// same route (a placeId and no token), so the alert says which caller it was.
async function notifyAssessmentFailed({ name, location, caller, error, ms }) {
  const escA = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    await sendEmailViaResend({
      to: ALERT_TO,
      subject: 'ALERT: an assessment failed, ' + String(name || '(no name)').slice(0, 80),
      fromName: 'DiagnostiX Alerts',
      html: '<p><strong>An assessment failed and returned an error to its caller.</strong></p>'
        + '<ul><li>restaurant: ' + escA(name) + '</li><li>location: ' + escA(location) + '</li>'
        + '<li>caller: ' + escA(caller) + '</li><li>error: ' + escA(error) + '</li>'
        + '<li>elapsed: ' + escA(ms) + ' ms</li></ul>',
    });
  } catch (e) { console.log('[diagnose] failure alert not sent: ' + (e && e.message)); }
}

// ── INTERNAL SUMMARY EMAIL ───────────────────────────────────
// Sent to hello@4xiconsulting.com alongside every customer report.
// Compact plain-text-style summary for at-a-glance triage in inbox.
async function sendInternalSummaryEmail({ subscriber, report, reportNumber, survey }) {
  const INTERNAL_TO = 'hello@4xiconsulting.com';
  const baseUrl = process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app';

  // Subscriber object can arrive in two shapes:
  //   - Supabase shape (snake_case): report_token, restaurant_name, first_name, plan_type
  //   - In-memory shape (camelCase): reportToken, restaurantName, firstName, planType
  // Read each field with a fallback so the email works in both flows.
  const subField = (snake, camel) => subscriber[snake] !== undefined ? subscriber[snake] : subscriber[camel];
  const reportTokenSafe = subField('report_token', 'reportToken') || '';
  const restaurantNameSafe = subField('restaurant_name', 'restaurantName') || '';
  const firstNameSafe = subField('first_name', 'firstName') || '';
  const planTypeSafe = subField('plan_type', 'planType') || '';

  const link = baseUrl + '/report?token=' + reportTokenSafe;
  // v8.11.53: the computed score, never the typed one and never a fabricated 0.
  const rec = recordedScore(report);
  const score = rec.score === null ? 'N/A' : rec.score;
  const verdict = rec.verdict || '';
  const restaurant = restaurantNameSafe || '(unknown)';
  const location = (survey && survey.location) || subscriber.location || '';
  const cuisine = (survey && survey.cuisine) || '';
  const price = (survey && survey.price) || '';
  const ownerName = firstNameSafe;
  const ownerEmail = subscriber.email || '';
  const isOneOff = planTypeSafe === 'one_off';

  // Subject: [DiagnostiX] New {full|annual} report: {restaurant} ({location}) — Score {score}
  const planLabel = isOneOff ? 'full' : 'annual';
  const reportTag = isOneOff
    ? `Full Report (${listPriceLabel()})`
    : `Annual Subscription ($99.99), Report ${reportNumber || 1} of 3`;
  const subject = `[DiagnostiX] New ${planLabel} report: ${restaurant}${location ? ' (' + location + ')' : ''}, Score ${score}`;

  // Pillars summary
  const pillars = Object.values(report?.pillars || {});
  const pillarRows = pillars.map(p =>
    `  ${(p.label || '').padEnd(28)} ${p.score}`
  ).join('\n');

  const escE = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Business metrics — show each metric, or "(not tracked)" when user opted out.
  // This tells you at a glance whether the user shared financials or skipped them,
  // distinct from "flat YoY" (which is also a legitimate response of 0%).
  //
  // Source precedence:
  //   1. survey.businessMetrics (camelCase) — the canonical survey shape, always present in-flight
  //   2. subscriber.guest_count_change (snake_case) — Supabase column shape, present when loaded from DB
  //   3. subscriber.guestCountChange (camelCase) — in-memory subscriber object, present in customer email flow
  // Reading from all three sources ensures metrics show up consistently regardless of
  // whether the email is generated from a live submission, a re-send, or a webhook trigger.
  const fmtBM = (v) => {
    if (v === null || v === undefined || !isFinite(v)) return '<span style="color:#999;font-style:italic">not tracked</span>';
    const sign = v >= 0 ? '+' : '';
    const col = v < 0 ? '#C0392B' : v > 0 ? '#2E7D52' : '#666';
    return `<span style="color:${col};font-weight:700">${sign}${v}%</span>`;
  };
  const surveyBM = (survey && survey.businessMetrics) || {};
  const pickBM = (surveyKey, snakeKey, camelKey) => {
    if (typeof surveyBM[surveyKey] === 'number') return surveyBM[surveyKey];
    if (typeof subscriber[snakeKey] === 'number') return subscriber[snakeKey];
    if (typeof subscriber[camelKey] === 'number') return subscriber[camelKey];
    return null;
  };
  const guestBM  = pickBM('guestCountChange',    'guest_count_change',   'guestCountChange');
  const checkBM  = pickBM('avgCheckChange',      'avg_check_change',     'avgCheckChange');
  const profitBM = pickBM('profitabilityChange', 'profitability_change', 'profitabilityChange');
  const bmShared = [guestBM, checkBM, profitBM].filter(v => v !== null).length;
  const bmRow = `<strong>Business metrics:</strong> ${bmShared}/3 shared
    <pre style="font-family:'SF Mono',Consolas,Menlo,monospace;font-size:13px;background:#f7f5f0;padding:10px 14px;border-radius:6px;margin:6px 0 14px;white-space:pre-wrap;line-height:1.7">  Guest count:    ${fmtBM(guestBM)}
  Average check:  ${fmtBM(checkBM)}
  Profitability:  ${fmtBM(profitBM)}</pre>`;

  // Plain-text body wrapped in minimal HTML (so Resend accepts + email clients render mono-friendly)
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;padding:24px 28px;border-radius:8px;border:1px solid #e5e5e5">
  <div style="font-family:'League Spartan',Arial,sans-serif;font-weight:900;color:#1B1464;font-size:14px;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;border-bottom:2px solid #92278F;padding-bottom:10px">
    DiagnostiX · Internal Summary
  </div>
  <div style="font-size:14px;line-height:1.7;color:#222">
    <strong>Restaurant:</strong> ${escE(restaurant)}<br>
    <strong>Location:</strong> ${escE(location || 'Not provided')}<br>
    ${cuisine ? `<strong>Cuisine:</strong> ${escE(cuisine)}<br>` : ''}
    ${price ? `<strong>Price:</strong> ${escE(price)}<br>` : ''}
    <strong>Submitted by:</strong> ${escE(ownerName || 'Not provided')} (${escE(ownerEmail)})<br>
    <strong>Plan:</strong> ${escE(reportTag)}<br>
    <br>
    <strong>Overall Score:</strong> <span style="font-weight:900;color:${score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24'}">${score} / 100</span> ${verdict ? '(' + escE(verdict) + ')' : ''}<br>
    <br>
    ${bmRow}
    <strong>Pillars:</strong>
    <pre style="font-family:'SF Mono',Consolas,Menlo,monospace;font-size:13px;background:#f7f5f0;padding:12px 14px;border-radius:6px;margin:6px 0 14px;white-space:pre-wrap">${escE(pillarRows || '(none)')}</pre>
    <a href="${link}" style="display:inline-block;background:#1B1464;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:700;font-size:13px;letter-spacing:0.5px">View Full Report &rarr;</a>
    <div style="margin-top:14px;font-size:11px;color:#888;word-break:break-all">${link}</div>
  </div>
</div>
</body></html>`;

  return await sendEmailViaResend({
    to: INTERNAL_TO,
    subject,
    html,
    fromName: 'DiagnostiX Internal'
  });
}

// ── ROOT + HEALTH + TEST ─────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.json({ status: 'running', version: VERSION });
  }
});

// v8.11.50: THE BROWSER GETS THE REAL SCORE LIBRARY, NOT A COPY OF IT.
//
// public/index.html rendered the typed score in nine places and carried two
// band tables of its own on top of the prompt's. Fixing that by writing the
// arithmetic a second time in a browser file is the exact drift this part
// exists to remove, so the module is served and the page imports it.
//
// Read from disk per request, like index.html above, so the two cannot get
// out of step in a way a restart would hide.
function serveScoreLib() {
  return {
    type: 'text/javascript; charset=utf-8',
    body: readFileSync(join(__dirname, 'lib-score.js'), 'utf8'),
  };
}

app.get('/lib-score.js', (req, res) => {
  try {
    const sent = serveScoreLib();
    res.setHeader('Content-Type', sent.type);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(sent.body);
  } catch (e) {
    console.log('[score-lib] could not be served: ' + (e && e.message));
    res.status(500).send('// score library unavailable');
  }
});

app.get('/health', (req, res) => {
  // benchmarks is this endpoint's first configuration handle. Without one there
  // is no way to check capture state from outside, and /health is where that
  // gets checked. Tri-state string, matching the shape EVP uses.
  res.json({
    status: 'ok',
    version: VERSION,
    benchmarks: BENCHMARK_ENABLED
      ? 'on'
      : (BENCHMARK_CONFIGURED ? 'configured but disabled' : 'not configured')
  });
});

// ── /test REMOVED, v8.11.9 ─────────────────────────────────────────────────
//
// It returned `ak_prefix: ANTHROPIC_API_KEY.slice(0,15)` to ANY caller. The
// only middleware in front of it is the CORS block at :35, which sets
// Access-Control-Allow-Origin: * rather than restricting anything, so this was
// unauthenticated key material on the public internet. It also issued a real
// Anthropic request per hit, making it an open spend endpoint.
//
// DELETED RATHER THAN GATED. A route that returns key material has no correct
// access level: an operator does not need the prefix, and anyone who does need
// to know which key is loaded can read the Railway variable. Gating it would
// also leave the per-hit Anthropic call behind an authentication check that
// does not make spend free.
//
// This had to go BEFORE ANTHROPIC_API_KEY is rotated. Rotating first would
// have published the new key's prefix the moment the service restarted, which
// is the rotation achieving nothing.
//
// What it was actually useful for, and where that lives now: /health already
// reports version and the benchmarks tri-state. It does NOT report whether the
// Anthropic or Serper keys WORK, and this route did, by calling them. That is a
// real gap and the swallowed-failure note names it: a config handle saying
// "configured" does not say "works". The replacement is a liveness check that
// reports ok/failed WITHOUT echoing any part of a credential, and it is
// deliberately not written here, because bundling it with a removal would mean
// this commit could not be reverted on its own.

// ── /diagnose ────────────────────────────────────────────────

// ── writeExecutiveSummary (v8.11.52) [B3.2] ─────────────────────────────────
//
// PASS 2. The score and the band are computed between the two passes, by
// lib-score.js, with no model involved, and the summary is then written WITH
// THE BAND IN ITS INPUT.
//
// WHY IT IS A SEPARATE CALL AND NOT A FIELD ON PASS 1. A model asked for a
// score and a summary in one object writes the summary to agree with the score
// it just wrote. That is exactly how 66 of the 105 stored summaries came to
// name a band other than the computed one, skewed 4.2 to 1 toward the higher
// one. The band has to exist before the sentence is written.
//
// IT IS NOT GIVEN THE CORPUS. Pass 1 read the corpus and produced the pillars;
// this writes three sentences from structured input. Handing it the corpus
// again would invite it to re-derive a view of the business and argue with the
// numbers.
//
// THE GATE BLOCKS DELIVERY, WITH ONE RETRY, AND THEN GIVES UP RATHER THAN
// LOOPING. Band words are ordinary English and 92 of 103 stored summaries
// contain one; a gate that retried until clean would never deliver. On a
// second failure the report ships WITHOUT a summary and an alert is raised.
//
// LOSING THREE SENTENCES IS BETTER THAN LOSING THE REPORT, and far better than
// shipping a cover that says Fair above a paragraph that says strong.
// THE TARGET IS WHAT THE PROMPT ASKS FOR. THE LIMIT IS WHAT THE GATE ENFORCES.
// They differ on purpose: see the comment at the gate below.
const SUMMARY_TARGET_WORDS = 70;
const SUMMARY_MAX_WORDS = 80;

async function writeExecutiveSummary({ name, location, report, score, band }) {
  if (!band || typeof score !== 'number') {
    return { text: '', reason: 'no-band' };
  }
  const pillars = report && report.pillars ? report.pillars : {};
  const line = (k) => {
    const p = pillars[k];
    return p ? '  ' + (p.label || k) + ': ' + p.score : null;
  };
  const pillarBlock = ['cs', 'pa', 'es', 'sm', 'cp', 'bg'].map(line).filter(Boolean).join('\n');
  const strengths = (report && report.strengths || []).slice(0, 3).map(x => '  ' + x).join('\n');
  const risks = (report && report.risks || []).slice(0, 3).map(x => '  ' + x).join('\n');

  const basePrompt = [
    'Write the executive summary for a restaurant health report.',
    '',
    'Restaurant: ' + name,
    'Location: ' + location,
    '',
    'PILLAR SCORES, each out of 100:',
    pillarBlock,
    '',
    'THE OVERALL SCORE IS ' + score + ' OUT OF 100, AND ITS BAND IS "' + band + '".',
    'That score is the mean of the six pillar scores above. It is a given fact.',
    'Do not dispute it.',
    '',
    'NEVER WRITE ANY OF THESE NUMBERS IN THE SUMMARY: the overall score, and',
    'any of the six pillar scores. They are printed beside the summary as',
    'tiles and a gauge, so repeating them is duplication and a bare pillar',
    'number beside a different overall number reads as a contradiction.',
    'An earlier version of this instruction said "do not restate it as a',
    'number" and produced "earns a Fair rating with a score of 63 out of 100",',
    'so it is spelled out: the digits ' + score + ' and the six pillar values',
    'must not appear.',
    '',
    'CITE EXTERNAL FACTS ONLY: star ratings, review counts, dates, named',
    'platforms, prices, opening hours. Those come from outside this report and',
    'are what a reader cannot already see.',
    '',
    'AT MOST ' + SUMMARY_TARGET_WORDS + ' WORDS IN TOTAL.',
    '',
    'Bands: 80 and above Excellent, 65 to 79 Good, 45 to 64 Fair, below 45 Needs Attention.',
    '',
    strengths ? 'STRENGTHS FOUND:\n' + strengths : '',
    risks ? 'RISKS FOUND:\n' + risks : '',
    '',
    'Write 2 to 3 sentences, in this shape:',
    '',
    'ONE overall verdict sentence that states the band in its own word,',
    '"' + band + '", exactly once. Then sentences describing SPECIFIC strengths',
    'and specific gaps by name.',
    '',
    'IN THOSE SPECIFIC SENTENCES, DO NOT USE ANY OF THESE WORDS: excellent,',
    'exceptional, outstanding, superb, good, strong, solid, healthy, fair,',
    'mixed, middling, average, adequate, poor, weak, critical, failing,',
    'struggling. They all name bands, and a band word attached to one aspect',
    'reads as a verdict on the business.',
    '',
    'Name the thing instead: what the reviews say, what the rating is, what is',
    'missing. "Rated 4.9 on TripAdvisor" rather than "a strong rating". "No',
    'organic reviews in twelve months" rather than "weak online presence".',
    '',
    'PUNCTUATION, HARD RULE: never use an em-dash or an en-dash, and never',
    'their HTML entity forms. Use a comma, a colon, parentheses, or a full stop',
    'and a second sentence. For a numeric range use a plain hyphen.',
    '',
    // 2026-09-29 (recommendation 4): comparisons agree with their numbers.
    COMPARISON_RULE,
    '',
    'Return ONLY JSON: {"executiveSummary":"..."}',
  ].filter(x => x !== '').join('\n');

  for (let attempt = 1; attempt <= 2; attempt++) {
    let out;
    try {
      const extra = attempt === 1 ? '' : ('\n\n' + writeExecutiveSummary._lastRetry);
      // v8.11.52: SONNET, BY OMISSION, WHICH IS THE DEFAULT AT claude().
      //
      // This was an explicit Haiku override. The existing summaries were
      // written by diagnose-p1, which passes no model and therefore takes the
      // Sonnet default, so Haiku here would have given the corpus two authors:
      // Sonnet for everything delivered before this release, Haiku for
      // everything after. ONE MODEL FOR THE CORPUS.
      out = await claude(basePrompt + extra, {
        label: 'diagnose-summary', maxTokens: 700,
      });
    } catch (e) {
      console.log('[summary] attempt ' + attempt + ' threw: ' + (e && e.message));
      break;
    }
    const text = String((out && out.executiveSummary) || '').trim();
    if (!text) { console.log('[summary] attempt ' + attempt + ' returned nothing'); continue; }

    // TWO HARD RULES, AND THE LENGTH ONE IS NOT THE ONE IN THE PROMPT.
    //
    // The prompt asks for at most 70. The gate enforces 80. That gap is
    // deliberate: measured on 2026-09-23, asking for 70 produced 62, 64, 64,
    // 67, 71, 72, 74, 75, 76 and 79 across ten subjects. The model clusters
    // just above whatever ceiling it is given, so a gate set AT the asked
    // number would retry six times in ten for one to nine words.
    //
    // 80 IS AN EDITORIAL NUMBER, NOT A LAYOUT ONE, and that is worth saying
    // where somebody will look for the reason. The box was measured in real
    // Chrome under print media and holds 338 words on Letter and 366 on A4
    // before it crosses a page boundary. It has no height and no max-height,
    // so it never clips. The layout imposes no useful limit; this one is a
    // judgment about what an executive summary should be.
    const verdict = contradictsBand(text, band);
    const words = text.split(/\s+/).filter(Boolean).length;
    const tooLong = words > SUMMARY_MAX_WORDS;

    if (!verdict.contradicts && !tooLong) {
      console.log('[summary] accepted on attempt ' + attempt + ' band=' + band
        + ' words=' + words);
      return { text, reason: 'accepted-attempt-' + attempt, words };
    }
    if (verdict.contradicts) {
      console.log('[summary] attempt ' + attempt + ' CONTRADICTS band=' + band
        + ' words=' + JSON.stringify(verdict.hits.map(h => h.word)));
    }
    if (tooLong) {
      console.log('[summary] attempt ' + attempt + ' TOO LONG: ' + words
        + ' words, limit ' + SUMMARY_MAX_WORDS);
    }
    // The retry quotes the ACTUAL COUNT back, because "be shorter" is what the
    // prompt already said and it did not land.
    const parts = [];
    if (verdict.contradicts) parts.push(retryInstruction(verdict));
    if (tooLong) {
      parts.push('The previous attempt was ' + words + ' words. The hard limit is '
        + SUMMARY_MAX_WORDS + ' and the target is ' + SUMMARY_TARGET_WORDS
        + '. Cut it to ' + SUMMARY_TARGET_WORDS + ' words or fewer by removing '
        + 'whole clauses, not by compressing them into longer sentences.');
    }
    writeExecutiveSummary._lastRetry = parts.join(' ');
  }

  // THE REPORT SHIPS WITHOUT A SUMMARY RATHER THAN WITH A CONTRADICTION.
  await alertWebhookProblem({
    kind: 'summary-gate-failed',
    detail: 'The executive summary failed the gate twice for ' + name + ' at '
      + score + ' (' + band + '), on the band rule, the ' + SUMMARY_MAX_WORDS
      + ' word limit, or both. The report was delivered without a summary. '
      + 'Every other section is unaffected.',
  }).catch(() => {});
  return { text: '', reason: 'gate-failed-twice' };
}

// ── CONFIRM THE PLACES RECORD BEFORE ANY ASSESSMENT (overnight 2026-09-26) ──
//
// SUBJECT_INTEGRITY_STANDARD.md 3.1. /diagnose used to take the top Places
// candidate for "name, location" and nobody saw which business it was. Now the
// survey calls /resolve-place first: ONE findplacefromtext call, the record
// shown (name, address, review count, rating), and a signed token binding it.
// /diagnose assesses exactly that record and reuses this call's answer, so a
// survey still makes one focal Find Place call, only earlier.
//
// formatted_address and business_status are added to the fields. Both are
// Basic Data fields (ASSUMED from Google's field tiers; read the billing page
// before shipping). rating and user_ratings_total were already requested.
//
// The secret falls back to the recovery secret so this ships without a new
// environment variable, as SVP's does: both key short-lived HMAC tokens.
function placeTokenSecret() {
  return process.env.RVP_IDENTITY_SECRET || process.env.RVP_RECOVERY_SECRET || '';
}

const PLACE_FIELDS = 'place_id,name,formatted_address,geometry,rating,user_ratings_total,business_status';

// noMatchCopy lives in lib-review-gate.js with the coverage refusal, so both
// follow the one refusal layout (2026-09-28).

app.post('/resolve-place', async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const location = typeof b.location === 'string' ? b.location.trim() : '';
  if (!name) return res.status(400).json({ error: 'Restaurant name is required' });
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !placeTokenSecret()) {
    // Without Places there is nothing to confirm; without a secret the
    // approval could not be trusted. Neither is guessed around.
    console.warn('PLACE [confirm] unavailable: places=' + !!apiKey + ' secret=' + !!placeTokenSecret());
    return res.status(503).json({ error: 'Confirmation is unavailable right now. Please try again in a moment.' });
  }
  try {
    const url = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input='
      + encodeURIComponent(location ? name + ', ' + location : name)
      + '&inputtype=textquery&fields=' + PLACE_FIELDS + '&key=' + apiKey;
    const d = await (await fetch(url)).json();
    const top = d && d.status === 'OK' && Array.isArray(d.candidates) && d.candidates[0];
    if (!top || typeof top.place_id !== 'string') {
      if (d && (d.status === 'ZERO_RESULTS' || d.status === 'OK')) {
        console.log('PLACE [confirm] no match');
        await writeOutcome(Object.assign(outcomeRecord({
          kind: 'confirm', decision: 'no-place-match', reason: 'places ' + d.status,
          surveyEmail: b.email, deliveredRestaurant: name,
        }), { coverage_verdict: 'no-place-match', place_id: null, place_confirmed: false }));
        await sendLeadAlert({ kind: 'no Places match', subject: name, location,
          lines: ['Reason: Google Places returned no business for the name and location as typed'] });
        return res.json({ status: 'no-match', copy: noMatchCopy(name, 'page') });
      }
      console.log('PLACE [confirm] places error status=' + (d && d.status));
      return res.status(503).json({ error: 'We could not check the restaurant just now. Please try again in a moment.' });
    }
    const place = {
      placeId: top.place_id,
      name: typeof top.name === 'string' ? top.name : name,
      address: typeof top.formatted_address === 'string' ? top.formatted_address : null,
      rating: typeof top.rating === 'number' ? top.rating : null,
      reviewCount: typeof top.user_ratings_total === 'number' ? top.user_ratings_total : null,
      lat: top.geometry && top.geometry.location && typeof top.geometry.location.lat === 'number' ? top.geometry.location.lat : null,
      lng: top.geometry && top.geometry.location && typeof top.geometry.location.lng === 'number' ? top.geometry.location.lng : null,
    };
    const placeToken = signPlaceToken({ place, secret: placeTokenSecret(), issuedAt: Date.now() });
    console.log('PLACE [confirm] shown reviews=' + place.reviewCount + ' address=' + (place.address ? 'yes' : 'no'));
    return res.json({ status: 'found', placeToken, place: {
      name: place.name, address: place.address, rating: place.rating, reviewCount: place.reviewCount,
      closed: top.business_status === 'CLOSED_PERMANENTLY' } });
  } catch (e) {
    console.log('PLACE [confirm] error ' + (e && e.message));
    return res.status(503).json({ error: 'We could not check the restaurant just now. Please try again in a moment.' });
  }
});

// "No, let me correct it." Recorded whatever the token says: a declined match
// is exactly the event the confirmation exists to catch, so a bad token only
// loses the place id, never the row.
app.post('/decline-place', async (req, res) => {
  const b = req.body || {};
  const v = verifyPlaceToken({ token: b.placeToken, secret: placeTokenSecret() });
  const place = v.ok ? v.place : null;
  await writeOutcome(Object.assign(outcomeRecord({
    kind: 'confirm', decision: 'declined-by-user',
    reason: v.ok ? 'requester said this is not their restaurant' : 'requester declined; token ' + v.reason,
    surveyEmail: b.email, deliveredRestaurant: place ? place.name : null,
  }), { coverage_verdict: 'declined-by-user', place_id: place ? place.placeId : null, place_confirmed: false,
        subject_review_count: place ? place.reviewCount : null }));
  return res.json({ ok: true });
});

app.post('/diagnose', async (req, res) => EVIDENCE.run(newLedger(), async () => {
  // ALL-1: everything this handler awaits runs inside one ledger, including the
  // searches launched in parallel below, because AsyncLocalStorage follows the
  // await chain rather than the call stack.
  //
  // Measured from handler entry so totalMs covers everything the caller waits
  // for. See the totalMs note in the _debug block below for why this exists.
  const t0 = Date.now();
  const body = req.body;
  if (!body || !body.name) return res.status(400).json({ error: 'Restaurant name is required' });
  const ak = process.env.ANTHROPIC_API_KEY;
  const sk = process.env.SERPER_API_KEY;
  if (!ak) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
  if (!sk) return res.status(500).json({ error: 'SERPER_API_KEY missing' });
  const name = String(body.name);
  const location = String(body.location || '');
  const s = body.sentiment || {};
  console.log(`[diagnose] ${name} | ${location}`);

  try {
    const tSearch = Date.now();
    // Extract country from location (form sends "City, State, Country") → resolve region.
    const locParts = location.split(',').map(s => s.trim()).filter(Boolean);
    const country = locParts.length > 0 ? locParts[locParts.length - 1] : '';
    const region = getRegion(country);
    console.log(`[diagnose] region=${region} (country=${country || 'none'})`);
    const queries = buildRegionQueries(region, name, location);

    // Parse user-supplied competitor names from the survey form. Field is a
    // free-text comma-separated list (e.g. "Boragó, Ambrosía, La Mar"). Splits
    // on commas and semicolons; trims; drops empties.
    // A caller that has ALREADY resolved this subject sends its id. Analytics
    // does, from its peer gate. A browser does not, and RVP resolves its own.
    const suppliedPlaceId = typeof body.placeId === 'string' && body.placeId.trim()
      ? body.placeId.trim() : null;
    if (suppliedPlaceId) console.log(`[diagnose] caller supplied placeId=${suppliedPlaceId}`);

    // ── THE CONFIRMED PLACE (overnight 2026-09-26) ──
    //
    // Two callers, told apart by what they send:
    //   Analytics  placeId, no token: a peer its own gate already confirmed.
    //              Not gated here (contract/diagnose-request.contract.json).
    //   survey     a signed place token from /resolve-place, REQUIRED. The
    //              record the requester said Yes to is assessed; its name is
    //              never re-resolved, and its Find Place answer is reused.
    // A request with neither is refused before anything is spent. The page
    // reads `code` and never turns these into an estimated report.
    let confirmedPlace = null;
    if (!suppliedPlaceId) {
      if (!body.placeToken) {
        return res.status(400).json({ error: 'Please confirm your restaurant first.', code: 'confirmation-required' });
      }
      const v = verifyPlaceToken({ token: body.placeToken, secret: placeTokenSecret() });
      if (!v.ok) {
        console.log('PLACE [confirm] token rejected at /diagnose: ' + v.reason);
        return res.status(400).json(v.reason === 'expired'
          ? { error: 'Your confirmation expired. Please confirm your restaurant again.', code: 'confirmation-expired' }
          : { error: 'Your confirmation could not be read. Please confirm your restaurant again.', code: 'confirmation-invalid' });
      }
      confirmedPlace = v.place;
    }

    // 2026-09-24 (Simon, Q5): TWO NAMES FOR ONE CONFIRMED PLACE.
    //   displayName  the Places record the requester said Yes to. Every
    //                customer-facing line: the prose prompts, the summary, the
    //                limited note and refusal copy, report.subject (which the
    //                page puts on the cover and saves as the survey's name).
    //   name         the owner's TYPED name, kept as the alias for QUERIES:
    //                every Serper search, every Places text query, and the
    //                subject the purchase sends to Analytics' peer comparison.
    // Analytics' own call has no confirmed place, so both are its name.
    const displayName = confirmedPlace && confirmedPlace.name ? String(confirmedPlace.name) : name;

    // ── THE REVIEW GATE (lib-review-gate.js), before ANY spend ──
    //
    // On the CONFIRMED record's own Google review count, never
    // evidence.reviewsTotal (a sum over the neighbors too). Analytics' peers
    // are not gated: a peer with few reviews is still a peer, and refusing it
    // would shrink a cohort without anyone deciding to.
    let coverage;
    let intakeNewestReviewAt = null;
    if (confirmedPlace) {
      // THE NEWEST REVIEW DATE (2026-09-24, lib-place-details.js): one paid
      // Place Details call for the CONFIRMED place, only when the count alone
      // does not already refuse (a refused subject needs no date). Here and not
      // at /resolve-place, which would pay for every "No" and every candidate.
      // A failed call leaves recency unknown and never blocks the sale.
      if (reviewGate({ subjectReviewCount: confirmedPlace.reviewCount }).state !== 'refused-coverage') {
        const rd = await fetchNewestReviewAt({ placeId: confirmedPlace.placeId, apiKey: process.env.GOOGLE_PLACES_API_KEY, fetchFn: fetch });
        intakeNewestReviewAt = rd.newestReviewAt;
        console.log('PLACE_DETAILS [places] ' + (rd.ok ? 'ok' : 'failed') + ' reason=' + rd.reason
          + ' reviewsRead=' + rd.reviewsRead + ' newest=' + (rd.newestReviewAt || 'none') + ' ms=' + rd.ms);
        // Counted for the spend ledger. The price is ASSUMED from Google's page.
        if (rd.called) console.log('SPEND [places] place-details=1 skus=Places Details,Atmosphere Data assumedUsdUpTo='
          + PLACE_DETAILS_ASSUMED_USD.worst);
      }
      const gate = reviewGate({ subjectReviewCount: confirmedPlace.reviewCount, newestReviewAt: intakeNewestReviewAt });
      coverage = { state: gate.state, reason: gate.reason, subjectReviewCount: gate.subjectReviewCount,
        recency: gate.recency, note: limitedNote({ subject: displayName, gate }) };
      console.log('COVERAGE [coverage] ' + gate.state + ' reviews=' + gate.subjectReviewCount
        + ' recency=' + gate.recency + ' reason=' + gate.reason);
      await writeOutcome(Object.assign(outcomeRecord({
        kind: 'coverage',
        // The coverage state itself, as SVP and EVP write it (standard 5, row 16).
        decision: gate.state,
        reason: gate.reason + ' reviews=' + gate.subjectReviewCount
          + ' min=' + gate.thresholds.MIN_SUBJECT_REVIEWS + ' limitedBelow=' + gate.thresholds.LIMITED_BELOW_REVIEWS
          + ' recency=' + gate.recency,
        surveyEmail: body.email, deliveredRestaurant: displayName,
      }), {
        coverage_verdict: gate.state,
        place_id: confirmedPlace.placeId,
        place_confirmed: true,
        subject_review_count: gate.subjectReviewCount,
        subject_newest_review_at: gate.newestReviewAt,
      }));
      if (gate.state === 'refused-coverage') {
        await sendLeadAlert({ kind: 'review coverage refused', subject: displayName, location,
          lines: ['Reason: ' + gate.reason, 'Google reviews: ' + (gate.subjectReviewCount === null ? 'none listed' : gate.subjectReviewCount),
            'Rule: at least ' + gate.thresholds.MIN_SUBJECT_REVIEWS, 'Typed as: ' + name] });
        return res.json({ refused: true, benchmarkId: null,
          coverage: Object.assign({}, coverage, { copy: refusalCopy({ subject: displayName, gate, channel: 'page' }) }) });
      }
    }

    const userCompetitorsRaw = String(body.competitors || '');
    const userCompetitors = userCompetitorsRaw
      .split(/[,;]/)
      .map(s => s.trim())
      .filter(s => s.length >= 3 && s.length <= 60);
    if (userCompetitors.length) {
      console.log(`[diagnose] user-named competitors: ${userCompetitors.join(' | ')}`);
    }

    console.log('[diagnose] searching...');
    // Run focal-context detection in parallel with the other 5 searches.
    // The competitor search waits for focal context to complete before
    // launching (so it can build tier-aware queries), then runs its
    // sub-layers in parallel internally. Net overhead: one extra Serper call
    // (~700ms) added serially before the competitor batch.
    const focalCtxPromise = detectFocalContext({ name, location });
    const compSearchPromise = (async () => {
      const focalContext = await focalCtxPromise;
      return searchCompetitorsMultiple({ name, location, region, userCompetitors, focalContext,
        placeId: suppliedPlaceId || (confirmedPlace && confirmedPlace.placeId) || null, focal: confirmedPlace });
    })();
    const [g,rv,st,so,dl,compResult,focalContext] = await Promise.all([
      searchWithFallback(queries.GOOGLE,      { label: 'GOOGLE' }),
      searchWithFallback(queries.REVIEWS,     { label: 'REVIEWS' }),
      searchWithFallback(queries.STAFF,       { label: 'STAFF' }),
      searchWithFallback(queries.SOCIAL,      { label: 'SOCIAL' }),
      searchWithFallback(queries.DELIVERY,    { label: 'DELIVERY' }),
      compSearchPromise,
      focalCtxPromise
    ]);
    const co = compResult.merged;
    const compUserResults = compResult.userResults || [];
    // v8.11.26 [RVP-A]: focalPlaceId added to the fallback shape. Without it
    // the fallback silently produced a focal with no id, which now means no
    // focal review count at all rather than a wrong one.
    const compPlacesData = compResult.placesData || { places: [], focalRating: null, focalReviewCount: null, focalGeo: null, focalPlaceId: null };

    // Scraping summary: count which categories returned 'no data' so empty-report cases are visible in logs.
    const cats = { GOOGLE:g, REVIEWS:rv, STAFF:st, SOCIAL:so, DELIVERY:dl, COMPETITORS:co };
    const webScoring = budgetCorpus(cats, CORPUS_CAPS_SCORING);
    const webProse   = budgetCorpus(cats, CORPUS_CAPS_PROSE);
    const rawCorpusChars = Object.values(cats).reduce((a, v) => a + String(v || '').length, 0);
    console.log(`[diagnose] corpus budget: scoring=${webScoring.length}ch prose=${webProse.length}ch raw=${rawCorpusChars}ch`);
    const empties = Object.entries(cats).filter(([k,v]) => v === 'no data' || v === 'no api key' || v.startsWith('err:')).map(([k]) => k);
    const ok = 6 - empties.length;
    console.log(`[diagnose] scraping summary: ${ok}/6 succeeded, ${Date.now()-tSearch}ms total, ${rawCorpusChars} chars raw` + (empties.length ? ` | EMPTY: ${empties.join(',')}` : ''));
    const sv = `REVIEWER SELF-ASSESSMENT (1=low 10=high):
- Overall business performance satisfaction: ${s.perf||5}/10
- Customer volume vs capacity: ${s.cap||5}/10
- Staff retention & team stability: ${s.ret||5}/10
- Venue ambiance & physical condition: ${s.amb||5}/10
- Level of repeat/return customers: ${s.repeat||5}/10
- How far in advance fully booked: ${s.book||5}/10
- Menu strength & appeal: ${s.menu||5}/10
- Online presence effectiveness: ${s.online||5}/10
- Pricing vs value delivered: ${s.price||5}/10
- 12-month business optimism: ${s.future||5}/10
Reviewer average score: ${Math.round(Object.values(s).reduce((a,b)=>a+(b||5),0)/10*10)/10}/10`;

    // Build business-metrics block. Each metric is either:
    //   - a number (user moved the slider; 0 = "flat YoY", -5 = "down 5%", etc.)
    //   - null (user checked "I don't track this metric")
    // Null is preserved end-to-end so the AI knows the difference between
    // "user reports flat" (real signal) and "user didn't share" (no signal).
    const bm = body.businessMetrics || {};
    const isNum = (v) => (typeof v === 'number' && isFinite(v));
    const guestN  = isNum(bm.guestCountChange)    ? bm.guestCountChange    : null;
    const checkN  = isNum(bm.avgCheckChange)      ? bm.avgCheckChange      : null;
    const profitN = isNum(bm.profitabilityChange) ? bm.profitabilityChange : null;
    const providedCount = [guestN, checkN, profitN].filter(v => v !== null).length;
    const fmtPct = (v) => v === null ? 'Not tracked (user opted out)' : (v >= 0 ? '+' : '') + v + '%';

    // If user opted out of ALL three metrics, suppress the entire financial block
    // from the prompt so the AI won't fabricate financial commentary. The prompt
    // explicitly tells the AI: in this case, leave all financial-related fields empty.
    let bmBlock;
    if (providedCount === 0) {
      bmBlock = `REVIEWER-REPORTED BUSINESS METRICS: The user opted out of sharing all three financial metrics (guest count, average check, profitability).
CRITICAL: Return empty string "" for businessRealityAnalysis, empty string "" for perceptionGap, and empty strings "" for ALL pillarGapNarratives entries. Do NOT fabricate financial commentary. The report will fall back to qualitative analysis only.`;
    } else {
      bmBlock = `REVIEWER-REPORTED BUSINESS METRICS (year-over-year change):
- Guest count change:    ${fmtPct(guestN)}
- Average check change:  ${fmtPct(checkN)}
- Profitability change:  ${fmtPct(profitN)}

CRITICAL, INTEGRATE QUALITATIVE WITH QUANTITATIVE, BUT ONLY FOR METRICS THE USER SHARED:
A metric marked "Not tracked (user opted out)" means the user did NOT share that number. You MUST NOT mention or analyze it. Do NOT speculate about its value. Do NOT include it in businessRealityAnalysis. Return empty string "" for its pillarGapNarratives entry.

For metrics the user DID share (those with a percentage value): blend them with the qualitative pillar scores and web data to produce holistic findings. Examples:
  • If guest count is down but Customer Sentiment pillar is high → "Sentiment among existing customers is strong, but acquisition is failing. The issue isn't the experience, it's getting people through the door."
  • If average check is down but Pricing pillar is high → "Pricing strategy reads well from the menu, but operators aren't capturing the upside in real ticket value. Likely an upselling or menu-mix execution gap."
  • If profitability is down but revenue stable → "Top line holds but margins erode. This is a cost-control problem, not a demand problem."
  • If all shared metrics are flat (0%) → treat as a "stable baseline" signal and lean more on qualitative+web evidence.

When writing businessRealityAnalysis: 2-3 sentences that EXPLICITLY weave the SHARED financial numbers together with the relevant qualitative pillars. Name the pillars. Show how the numbers either confirm or contradict the qualitative picture. Only reference metrics the user actually shared.
When writing perceptionGap: 1-2 sentences ONLY if there is a meaningful divergence between reviewer self-perception and the shared financial reality. If broadly aligned, or if fewer than 2 metrics were shared, return empty string "".`;
    }
    console.log('[diagnose] business metrics:', fmtPct(guestN), '|', fmtPct(checkN), '|', fmtPct(profitN), '| provided:', providedCount + '/3');

    // Build USER-NAMED COMPETITORS block — a structured, separate hand-off so
    // the AI cannot miss or skip these. They appear in their own clearly labeled
    // section right at the top of the COMPETITORS data, with an explicit
    // imperative instruction. This is belt-and-braces with the prompt rules.
    // Includes pre-extracted rating/reviewCount hints from Serper's structured
    // API response so the AI has authoritative values rather than having to
    // text-parse them out of snippets.
    let userCompBlock;
    if (userCompetitors.length) {
      const list = compUserResults.map((r, i) => {
        const hint = (r.rating !== null || r.reviewCount !== null)
          ? ` [EXTRACTED FROM SERPER: rating=${r.rating ?? 'null'}, reviewCount=${r.reviewCount ?? 'null'}${r.resolvedTitle ? `, resolvedName="${r.resolvedTitle}"` : ''}]`
          : ' [NO STRUCTURED RATING DATA, check the [USER-NAMED] web data section below for snippets]';
        return `  ${i+1}. ${r.userName}${hint}`;
      }).join('\n');
      userCompBlock = `USER-NAMED COMPETITORS (the restaurant owner explicitly identified these as their direct competitors. These MUST appear in your competitors array):
${list}

IMPERATIVE: Your competitors array MUST include every name above. For each:
- If a rating/reviewCount value is shown in [EXTRACTED FROM SERPER: ...] above, USE THOSE EXACT VALUES. They came directly from Google's knowledge graph. Do NOT override them with null.
- If the EXTRACTED block shows "null" for rating, scan the [USER-NAMED: X] section in the COMPETITORS web data for any rating signal (4.5/5, 4.5 stars, etc) and extract it. Only use null if you genuinely cannot find any signal anywhere.
- Use the resolvedName from Serper if provided (it's more accurate, e.g. "Hog Island Oyster Co." instead of "Hog Island"); otherwise keep the user's input name.
- Write a 1-sentence note describing the competitor's position relative to the focal restaurant.

After listing all user-named competitors, you MUST add UP TO 2 auto-discovered competitors from the [GOOGLE-PLACES] section first (these are AUTHORITATIVE: the names, ratings, and review counts come from Google Maps directly; use them VERBATIM and do not modify the numbers). If [GOOGLE-PLACES] does not have 2 strong tier/cuisine matches, fall back to [SIMILAR-TO] / [NEIGHBORHOOD] / [TOP-IN-CITY] for the remainder. Target: 3 user-named + up to 2 auto-discovered = 5 total (minimum 3). Follow the FOCAL PROFILE tier/cuisine matching rules below.`;
    } else {
      userCompBlock = '';
    }

    // Build FOCAL PROFILE block — gives the AI explicit cuisine + tier signals
    // detected from the focal restaurant's own Serper data, plus matching rules.
    // This is what turns "find any restaurants in Vitacura" into "find similar-tier
    // similar-cuisine restaurants in Vitacura" and rejects obvious mismatches like
    // a 2.0-star traditional Japanese place being compared to a premium fusion concept.
    let focalProfileBlock = '';
    if (focalContext && (focalContext.cuisine || focalContext.tier)) {
      const detected = [];
      if (focalContext.cuisine) detected.push(`Cuisine: ${focalContext.cuisine}`);
      if (focalContext.tier)    detected.push(`Tier: ${focalContext.tier}`);
      if (focalContext.rating !== null && focalContext.rating !== undefined) detected.push(`Focal rating: ${focalContext.rating}`);
      focalProfileBlock = `FOCAL RESTAURANT PROFILE (detected from web data):
  ${detected.join(' | ')}

COMPETITOR MATCHING RULES, apply these to non-user-named competitors:
1. TIER MATCH (REQUIRED): The competitor must be at a similar quality tier to the focal restaurant. If the focal is "fine-dining" or "upscale", REJECT competitors that are clearly fast-casual, budget, or hotel/lobby/airport restaurants. If the focal is "casual", do not include $$$$ fine-dining as a competitor.
2. CUISINE MATCH (PREFERRED, NOT REQUIRED): Same-cuisine peers are ideal: Italian fine-dining for an Italian focal, Asian fusion for a fusion focal, etc. HOWEVER, when the focal is an upscale or fine-dining concept, other upscale restaurants in the same neighborhood ARE legitimate competitors regardless of cuisine, because they compete for the same diner, same occasion, and same wallet. For Vitacura fine-dining: a 4.5-star Italian restaurant 1km away is a real competitor to a 4.5-star Asian-fusion restaurant, they both fight for the same Saturday night reservation. Use cuisine as a tiebreaker, not a gate.
3. RATING FLOOR: Skip any competitor with a rating below 3.5 stars UNLESS the focal restaurant itself has a rating below 3.5.
4. REVIEW VOLUME FLOOR: Skip any competitor with fewer than 50 reviews, too small to be a meaningful benchmark for an established focal restaurant.
5. REJECT NON-RESTAURANTS: Skip hotels (e.g. "Hotel Bidasoa"), pubs, fast-food chains (McDonald's, Burger King, KFC), bakeries-only, cafes-only, and clearly different formats. These appear in Google Places data but are not relevant peers.
6. PROXIMITY MATTERS: When [GOOGLE-PLACES] data is available, prefer restaurants within 1500m of the focal, they're literally fighting for the same foot traffic.
7. FILL TO 5 WHEN POSSIBLE: With 3 user-named competitors as the base, ALWAYS try to add 2 more from [GOOGLE-PLACES] to reach exactly 5. The [GOOGLE-PLACES] data is authoritative and contains the strongest peer signals. Only return fewer than 5 if Places + Serper genuinely contain no additional tier-matched restaurants.
8. NOTE QUALITY: For each non-user-named competitor, write a note that explains their competitive position, not why they're "different." Frame them as peers, not outliers. Good: "Established Italian fine-dining alternative with strong Vitacura presence, competes for the same upscale dinner occasion." Bad: "Italian rather than fusion, different cuisine concept."`;
    }

    console.log('[diagnose] claude part1 + part2 in parallel (p2 uses Haiku for speed)...');
    const tClaude = Date.now();
    const [p1, p2] = await Promise.all([
      claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language.\n\nRestaurant:${displayName}\nLocation:${location}\nWebData:\n${webScoring}\n\n${sv}\n\n${bmBlock}\n\nReturn JSON. Use WebData for scores. Use Reviewer Self-Assessment to write ownerSentimentSummary (2 sentences interpreting what the reviewer thinks vs what data shows) and sentimentGap (1 sentence on biggest gap between reviewer perception and reality). businessRealityAnalysis and perceptionGap follow the rules above. When business metrics are provided, ALSO populate pillarGapNarratives with one short sentence per relevant pairing (guest count ↔ Customer Sentiment pillar; average check ↔ Pricing & Accessibility pillar; profitability ↔ Brand Experience & Growth pillar). Each narrative should be 1 punchy sentence interpreting the gap or alignment between the financial metric and the qualitative pillar score. If a metric is not provided, return empty string "" for its narrative.\n{"cuisineDetected":"from data","priceDetected":"$$","pillars":{"cs":{"score":<integer 0-100>,"label":"Customer Sentiment","status":"good"},"pa":{"score":<integer 0-100>,"label":"Pricing & Accessibility","status":"good"},"es":{"score":<integer 0-100>,"label":"Employee Sentiment","status":"warn"},"sm":{"score":<integer 0-100>,"label":"Social Media Impact","status":"warn"},"cp":{"score":<integer 0-100>,"label":"Competitive Positioning","status":"good"},"bg":{"score":<integer 0-100>,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":<integer 0-100>,"channels":[{"name":"Google Business","score":<integer 0-100>,"note":"real"},{"name":"Yelp","score":<integer 0-100>,"note":"real"},{"name":"TripAdvisor","score":<integer 0-100>,"note":"real"},{"name":"OpenTable","score":<integer 0-100>,"note":"real"},{"name":"Social Media","score":<integer 0-100>,"note":"real"},{"name":"Delivery Platforms","score":<integer 0-100>,"note":"real"}]},"ownerSentimentSummary":"2 sentences","sentimentGap":"1 sentence","businessRealityAnalysis":"","perceptionGap":"","pillarGapNarratives":{"guest":"","check":"","profit":""}}\nRules:good>=65 warn=45-64 bad<45 for each pillar status. DO NOT return an overall score, an overall verdict or an executive summary. The overall score is COMPUTED from the six pillar scores by the application, not written here. NOTE: Do NOT change the pillar scores based on businessMetrics. The pillar scores remain qualitative+web-data driven. Financial metrics are reported separately via businessRealityAnalysis, perceptionGap, and pillarGapNarratives.\n\nPUNCTUATION, HARD RULE: never use an em-dash (—) or an en-dash (–) in any string you return, and never use their HTML entity forms. This is 4xi house style and it is absolute. It applies to every field without exception: pillar labels, owner sentiment summary, sentiment gap, business reality analysis, perception gap, pillar gap narratives and online presence notes. Where you would reach for one, use a comma, a colon, parentheses, or a full stop and a second sentence, chosen to suit that sentence rather than substituted mechanically. For a numeric range use a plain hyphen ("10-20", never "10–20").`, { label: 'diagnose-p1' }),
      claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language. Translate any non-English review quotes into English.\n\nRestaurant:${displayName}\nLocation:${location}\nWebData:\n${webProse}\n\n${bmBlock}\n\n${userCompBlock}\n\n${focalProfileBlock}\n\nReturn JSON with real data.\n\nIMPORTANT, TWO DISTINCT ACTION LISTS:\n1. "actions": 5 OPERATIONAL recommendations driven by the qualitative pillars and web data (customer experience, staff, social media, brand, competitive positioning). These exist regardless of whether financial metrics were provided. Do NOT mention specific financial numbers in these actions.\n2. "commercialActions": 2-3 COMMERCIAL/FINANCIAL recommendations driven SPECIFICALLY by the business metrics the user SHARED. Rules: (a) If the businessMetrics block says all metrics are "Not tracked (user opted out)", return empty array []. (b) Each item MUST reference only a metric the user actually shared, never reference a "Not tracked" metric or speculate about one. (c) Each item must include "title", "desc", and "evidence" (a short phrase referencing the specific shared financial metric, e.g. "Guest count -12% YoY" or "Profitability -8% YoY").\n\nCommercial action guidance (only for shared metrics): declining guest count → acquisition/awareness/traffic actions; declining average check → menu mix, pricing strategy, upselling actions; declining profitability with stable revenue → cost control, prime cost management, supplier/labor optimization. Strong growth → reinvestment/expansion suggestions.\n\nIMPORTANT, COMPETITORS schema: list 3 TO 5 actual competing restaurants (minimum 3, maximum 5) from the COMPETITORS web data (NOT the focal restaurant itself). The COMPETITORS web data is organised into LABELED SECTIONS. Their order reflects source reliability, not importance: a user-named competitor is top priority wherever its section appears. [USER-NAMED: X] (the restaurant owner identified X as a direct competitor. TOP PRIORITY, always include each user-named competitor if any data exists); [GOOGLE-PLACES] (nearby restaurants from Google Maps within 2km. AUTHORITATIVE source for auto-discovered competitors, ratings/reviewCounts here come directly from Google so use them VERBATIM and do not modify the numbers); [SIMILAR-TO] (concept overlap surfaced via \"restaurants like X\" queries); [NEIGHBORHOOD] (neighborhood/district results); [TOP-IN-CITY] (broad city-level fallback). RULES: (1) Only include competitors whose NAMES appear VERBATIM in the web data, never invent names like \"Restaurant Market\" or generic placeholders. (2) Fewer real competitors is better than padded fakes. If you only have 3 strong, return 3. Do not pad to 5 with weak matches. (3) Skip restaurants that are clearly a different tier (fast-food, hotel restaurants, chain fast-food when focal is fine-dining). Different cuisine is fine when tier matches and proximity is close, an Italian fine-dining restaurant next door IS a competitor to an Asian-fusion fine-dining restaurant. (4) For each named competitor, ACTIVELY SEARCH the web data for star ratings (Google, TripAdvisor, Yelp ratings typically appear as \"4.5\", \"4.5/5\", \"4.5 stars\", or similar). Convert to a number 0-5. Only use null if you genuinely cannot find any rating signal, do not default to null out of excessive caution. (5) Same for reviewCount: look for \"850 reviews\", \"1.2k reviews\", \"(642)\" patterns. Convert k-suffixed numbers (1.2k → 1200). Only null if truly absent. (6) Do NOT include the focal restaurant in this list, it will be added by the renderer.\n\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":<integer 1-5>,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":<integer 1-5>,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":<integer 1-5>,"sentiment":"negative"},{"text":"real quote","source":"Google","stars":<integer 1-5>,"sentiment":"negative"}],"strengths":["real strength 1","real strength 2","real strength 3"],"risks":["real risk 1","real risk 2","real risk 3"],"themes":{"positive":["t1","t2","t3"],"negative":["t1","t2"],"neutral":["t1","t2"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real competitor name","rating":<number 0-5, or null if unknown>,"reviewCount":<integer, or null if unknown>,"note":"1 sentence on their position"},{"name":"real competitor name","rating":<number 0-5, or null if unknown>,"reviewCount":<integer, or null if unknown>,"note":"1 sentence"},{"name":"real competitor name","rating":<number 0-5, or null if unknown>,"reviewCount":<integer, or null if unknown>,"note":"1 sentence"},{"name":"real competitor name","rating":<number 0-5, or null if unknown>,"reviewCount":<integer, or null if unknown>,"note":"1 sentence"},{"name":"real competitor name","rating":<number 0-5, or null if unknown>,"reviewCount":<integer, or null if unknown>,"note":"1 sentence"}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based, operational"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}],"commercialActions":[{"title":"t","desc":"d","evidence":"financial metric reference"},{"title":"t","desc":"d","evidence":"financial metric reference"}]}\n\nPUNCTUATION, HARD RULE: never use an em-dash (—) or an en-dash (–) in any string you return, and never use their HTML entity forms. This is 4xi house style and it is absolute. It applies to every field without exception: review quotes, strengths, risks, themes, employee sentiment, competitive insight, competitor notes, actions and commercial actions. Where you would reach for one, use a comma, a colon, parentheses, or a full stop and a second sentence, chosen to suit that sentence rather than substituted mechanically. For a numeric range use a plain hyphen ("10-20", never "10–20").\n\n${COMPARISON_RULE}`, { label: 'diagnose-p2', model: 'claude-haiku-4-5-20251001' })
    ]);
    console.log('[diagnose] both Claude calls complete in', Date.now() - tClaude, 'ms');
    console.log('[diagnose] p1 score:', p1.healthCheckScore);
    console.log('[diagnose] p2 actions:', p2.actions?.length);
    // Log competitor shape — helps diagnose renderer issues from logs alone.
    if (Array.isArray(p2.competitors) && p2.competitors.length) {
      const shapes = p2.competitors.slice(0,3).map(c => {
        const keys = Object.keys(c || {}).sort().join(',');
        return `{${keys}}`;
      }).join(' ');
      console.log('[diagnose] p2 competitors shape:', shapes);
    }
    const report = Object.assign({}, p1, p2);
    // v8.11.52 [B3.1]: THE PILLARS ARE THE REQUIRED FIELD NOW.
    // healthCheckScore is no longer requested, so requiring it would fail
    // every assessment.
    if (!report.pillars) throw new Error('missing fields: '+Object.keys(report).join(','));

    // v8.11.52 [B3.2]: THE SCORE IS COMPUTED HERE, BETWEEN THE PASSES, and the
    // summary is written against it rather than alongside it.
    const computed = computeOverall(report.pillars);
    const computedBand = verdictFor(computed.score);
    console.log('[diagnose] computed score=' + computed.score + ' band=' + computedBand
      + (computed.ok ? '' : ' reason=' + computed.reason));

    // v8.11.53: THE RESPONSE CARRIES THE COMPUTED SCORE AS healthCheckScore.
    //
    // Analytics reads /diagnose for every peer assessment and REJECTS a
    // response without a numeric healthCheckScore (diagnostix-analytics
    // lib/orchestrator.js:230). 8.11.52 stopped the model writing that field
    // and put nothing in its place, so every peer failed and the report said
    // "against 0 comparable businesses". The value is the cover's own
    // computeOverall, never a model number. With fewer than six pillars it is
    // null, and Analytics refuses the peer rather than being fed a guess.
    report.healthCheckScore = computed.ok ? computed.score : null;

    const summary = await writeExecutiveSummary({
      name: displayName, location, report, score: computed.score, band: computedBand,
    });
    report.executiveSummary = summary.text;
    report.summaryGate = summary.reason;

    // ── User-named competitor safety net ─────────────────────────────────
    // Even with explicit imperative prompts, Haiku occasionally drops
    // user-named competitors. This guarantees they always appear in the
    // final response, in the order the user listed them.
    //
    // Strategy:
    //   1. Build a map of competitors the AI returned, keyed by lowercased name.
    //   2. For each user-named competitor (in input order):
    //      - If AI returned a match, promote that entry to the top.
    //        Then override its rating/reviewCount with the Serper-extracted
    //        values IF AI gave null but Serper has authoritative data.
    //      - If AI did NOT return a match, synthesize a card using the
    //        Serper-extracted rating data (or null when none was found).
    //   3. Fill remaining slots with AI's other competitors (up to 5 total).
    if (userCompetitors.length && Array.isArray(report.competitors)) {
      const aiList = report.competitors.slice();
      const norm = (str) => String(str || '').trim().toLowerCase();
      // Fuzzy name match: AI may return "Hog Island Oyster Co." when user
      // typed "Hog Island". Match if either contains the other as a substring.
      const findAiMatch = (userName) => {
        const u = norm(userName);
        for (let i = 0; i < aiList.length; i++) {
          const a = norm(aiList[i] && aiList[i].name);
          if (!a) continue;
          if (a === u || a.includes(u) || u.includes(a)) return i;
        }
        return -1;
      };
      // Build a quick lookup from user-name → Serper-extracted result
      const serperByName = new Map();
      for (const r of compUserResults) {
        serperByName.set(norm(r.userName), r);
      }

      // ONE place decides what a competitor's rating is and why it is missing.
      // The promote and synthesize branches below both call this, because the
      // same name resolving differently depending on whether the model happened
      // to return it would be a defect nobody could reproduce.
      //
      // Order matters. Places is authoritative for a rating, but only once the
      // name agrees. Serper is consulted BEFORE declaring a business unrated,
      // because Google having no reviews and TripAdvisor having some are both
      // true at once, and "no reviews yet" must not be asserted over a rating we
      // actually hold.
      const resolveRating = (sd) => {
        if (sd === undefined) {
          return { rating: null, reviewCount: null, state: RATING_STATE.NOT_LOOKED_UP, name: null };
        }
        if (sd.placeFound && !sd.placeAgrees) {
          return { rating: null, reviewCount: null, state: RATING_STATE.UNCONFIRMED, name: null };
        }
        if (sd.placeAgrees && sd.placeRating !== null) {
          return { rating: sd.placeRating, reviewCount: sd.placeReviewCount, state: RATING_STATE.RATED, name: sd.placeName };
        }
        if (sd.rating !== null) {
          return { rating: sd.rating, reviewCount: sd.reviewCount, state: RATING_STATE.RATED, name: sd.placeAgrees ? sd.placeName : sd.resolvedTitle };
        }
        if (sd.placeAgrees) {
          return { rating: null, reviewCount: sd.placeReviewCount, state: RATING_STATE.LISTED_UNRATED, name: sd.placeName };
        }
        return { rating: null, reviewCount: null, state: RATING_STATE.NOT_FOUND, name: null };
      };

      const merged = [];
      const usedAiIdx = new Set();
      let synthesized = 0;
      let promoted = 0;
      let overridden = 0;

      for (const userName of userCompetitors) {
        const aiIdx = findAiMatch(userName);
        const serperData = serperByName.get(norm(userName));

        if (aiIdx >= 0) {
          // AI returned this competitor — promote it. Then upgrade with Serper
          // data: Serper's knowledgeGraph/places API data is more authoritative
          // than the AI's text-parsing of the same source, so it ALWAYS wins
          // when present — not just when the AI returned null.
          const entry = Object.assign({}, aiList[aiIdx]);
          const rr = resolveRating(serperData);
          if (rr.rating !== null) {
            if (entry.rating !== rr.rating) {
              console.log(`[diagnose] safety-net override ${entry.name}: rating ${entry.rating} → ${rr.rating}`);
              overridden++;
            }
            entry.rating = rr.rating;
            if (rr.reviewCount !== null) entry.reviewCount = rr.reviewCount;
          } else {
            // An unconfirmed or unrated resolution WITHDRAWS a rating the model
            // invented. The model reads ratings out of prose and is the least
            // reliable source in the chain; leaving its number in place would
            // let the state and the number contradict each other on one card.
            entry.rating = null;
            entry.reviewCount = null;
          }
          entry.ratingState = rr.state;
          // Prefer a longer resolved name (e.g. "Hog Island Oyster Co.") over the
          // owner's shorthand, from whichever source agreed.
          if (rr.name && norm(entry.name).length < norm(rr.name).length) entry.name = rr.name;
          merged.push(entry);
          usedAiIdx.add(aiIdx);
          promoted++;
        } else {
          // AI dropped this competitor — synthesize using Serper data when available.
          // `serperData` is undefined only when this name was never looked up,
          // which the cap at USER_COMPETITOR_LOOKUP_CAP now makes rare rather
          // than routine. The distinction is kept because the cap can be hit
          // again and the note must not claim a lookup that did not happen.
          const rr = resolveRating(serperData);
          const NOTE = {
            [RATING_STATE.RATED]:          'Owner-identified direct competitor, rating taken from public listings.',
            [RATING_STATE.NOT_FOUND]:      'Owner-identified direct competitor. We could not find this business in public listings.',
            [RATING_STATE.NOT_LOOKED_UP]:  'Owner-identified direct competitor. This name was not looked up for public review data.',
            [RATING_STATE.UNCONFIRMED]:    'Owner-identified direct competitor. We found a possible match but could not confirm it is the business named.',
            [RATING_STATE.LISTED_UNRATED]: 'Owner-identified direct competitor, publicly listed with no reviews yet.',
          };
          merged.push({
            name: rr.name || (serperData && serperData.resolvedTitle) || userName,
            rating: rr.rating,
            reviewCount: rr.reviewCount,
            ratingState: rr.state,
            note: NOTE[rr.state],
          });
          synthesized++;
        }
      }
      // Fill remaining slots with AI's other competitors (up to 5 total)
      for (let i = 0; i < aiList.length && merged.length < 5; i++) {
        if (!usedAiIdx.has(i)) merged.push(aiList[i]);
      }
      report.competitors = merged;
      console.log(`[diagnose] user-competitor safety net: ${promoted} promoted, ${synthesized} synthesized, ${overridden} ratings overridden from Serper, ${merged.length} total`);
    }

    // ── Non-restaurant name filter ─────────────────────────────────
    // The AI occasionally invents location/district names ("Marin Country Mart
    // Dining District", "Restaurant Row") that aren't actual restaurants.
    // Reject only when the name OBVIOUSLY refers to a district/area, not a venue.
    // We require both a generic area word AND a "dining/shopping/restaurant" qualifier
    // immediately adjacent — this catches "Dining District" but spares a restaurant
    // that happens to live in Larkspur Landing.
    if (Array.isArray(report.competitors) && report.competitors.length) {
      const userLowered = new Set(userCompetitors.map(n => n.toLowerCase()));
      // Explicit area-name patterns. Must be a tight match — adjacent words.
      // "Dining District", "Shopping Center", "Restaurant Row", "Food Court", etc.
      const areaPatterns = [
        /\bdining\s+(district|area|row|zone|hub)\b/i,
        /\bshopping\s+(center|centre|district|complex|mall|plaza)\b/i,
        /\brestaurant\s+(row|district|zone|area)\b/i,
        /\bfood\s+(court|hall|district)\b/i,
        /\b(dining|culinary|restaurant)\s+scene\b/i
      ];
      const before = report.competitors.length;
      report.competitors = report.competitors.filter(c => {
        const n = String(c.name || '').trim();
        if (!n) return false;
        // Exempt user-named entries (exact OR substring match — names may have been resolved by Serper)
        const nLower = n.toLowerCase();
        for (const u of userLowered) {
          if (nLower === u || nLower.includes(u) || u.includes(nLower)) return true;
        }
        // Reject only on tight area-name patterns
        for (const pat of areaPatterns) {
          if (pat.test(n)) {
            console.log(`[diagnose] non-restaurant filter: rejected "${n}"`);
            return false;
          }
        }
        return true;
      });
      if (report.competitors.length !== before) {
        console.log(`[diagnose] non-restaurant filter: ${before - report.competitors.length} entries rejected, ${report.competitors.length} remain`);
      }
    }

    // ── AI-discovered competitor backfill — Places first, Serper fallback ──
    // After the user-named safety net runs, the array may still contain
    // AI-discovered competitors with null ratings. We backfill in two stages:
    //   1. Match by name against compPlacesData.places (FREE — already fetched
    //      in the parallel scrape) — most accurate, no extra API call needed.
    //   2. For names that didn't match Places, fall back to Serper structured
    //      lookup (slower but works when Places didn't surface the venue).
    // Wrapped in try/catch — any error here MUST NOT empty report.competitors.
    try {
      if (Array.isArray(report.competitors) && report.competitors.length) {
        const userLoweredSet = new Set(userCompetitors.map(n => n.toLowerCase()));
        const needsBackfill = report.competitors
          .map((c, idx) => ({ c, idx }))
          .filter(({ c }) => {
            const nLower = String(c.name || '').trim().toLowerCase();
            // Skip user-named entries (handled in safety net), skip entries that already have ratings.
            let isUserNamed = false;
            for (const u of userLoweredSet) {
              if (nLower === u || nLower.includes(u) || u.includes(nLower)) { isUserNamed = true; break; }
            }
            const hasNullRating = (c.rating === null || c.rating === undefined);
            return !isUserNamed && hasNullRating && c.name;
          });

        if (needsBackfill.length) {
          const t = Date.now();

          // Stage 1: Match against Google Places by fuzzy name (substring both ways)
          const placesByLower = new Map();
          for (const p of (compPlacesData.places || [])) {
            placesByLower.set(String(p.name || '').trim().toLowerCase(), p);
          }
          const findPlacesMatch = (compName) => {
            const cLower = String(compName || '').trim().toLowerCase();
            // Exact match first
            if (placesByLower.has(cLower)) return placesByLower.get(cLower);
            // Substring match (handles "Hog Island" → "Hog Island Oyster Co.")
            for (const [pLower, p] of placesByLower.entries()) {
              if (cLower.length >= 3 && pLower.length >= 3 && (cLower.includes(pLower) || pLower.includes(cLower))) {
                return p;
              }
            }
            return null;
          };

          let backfilledFromPlaces = 0;
          const stillNeedsSerper = [];
          for (const item of needsBackfill) {
            const placeMatch = findPlacesMatch(item.c.name);
            if (placeMatch && placeMatch.rating !== null) {
              report.competitors[item.idx].rating = placeMatch.rating;
              if (placeMatch.reviewCount !== null) {
                report.competitors[item.idx].reviewCount = placeMatch.reviewCount;
              }
              // Upgrade name to Places' canonical form when longer/more specific
              if (placeMatch.name && placeMatch.name.length > String(item.c.name).length) {
                report.competitors[item.idx].name = placeMatch.name;
              }
              backfilledFromPlaces++;
            } else {
              stillNeedsSerper.push(item);
            }
          }
          console.log(`[diagnose] AI-competitor backfill: ${backfilledFromPlaces}/${needsBackfill.length} matched in Google Places`);

          // Stage 2: Serper fallback for names that didn't match Places
          if (stillNeedsSerper.length) {
            console.log(`[diagnose] AI-competitor backfill: looking up ${stillNeedsSerper.length} remaining names via Serper`);
            const locParts = String(location || '').split(',').map(s => s.trim()).filter(Boolean);
            const cityLoc = locParts.length >= 3 ? `${locParts[0]}, ${locParts[locParts.length - 2]}` : (locParts[0] || location);
            const lookups = await Promise.all(
              stillNeedsSerper.map(({ c }) =>
                searchStructured(`${c.name} restaurant ${cityLoc}`, { label: `BACKFILL[${c.name}]` })
                  .catch(e => { console.log(`[diagnose] BACKFILL[${c.name}] error: ${e.message}`); return { text: '', rating: null, reviewCount: null, title: null }; })
              )
            );
            let backfilledFromSerper = 0;
            stillNeedsSerper.forEach(({ idx }, i) => {
              const lookup = lookups[i] || {};
              if (lookup.rating !== null && lookup.rating !== undefined) {
                report.competitors[idx].rating = lookup.rating;
                if (lookup.reviewCount !== null && lookup.reviewCount !== undefined) {
                  report.competitors[idx].reviewCount = lookup.reviewCount;
                }
                if (lookup.title && lookup.title.length > report.competitors[idx].name.length) {
                  report.competitors[idx].name = lookup.title;
                }
                backfilledFromSerper++;
              }
            });
            console.log(`[diagnose] AI-competitor backfill: ${backfilledFromSerper}/${stillNeedsSerper.length} matched via Serper, total ${Date.now() - t}ms`);
          }
        }
      }
    } catch (e) {
      console.error('[diagnose] AI-competitor backfill FAILED (continuing without backfill):', e.message);
    }

    // ── DETERMINISTIC PLACES FILL — guaranteed slots 4-5 ─────────────────
    // The AI sometimes returns only the user-named competitors and skips
    // Places candidates, even when the prompt instructs it to fill up to 5.
    // To make the 5-card target deterministic, we bypass the AI's judgment
    // and inject top-quality Places candidates server-side. We apply the
    // same tier-quality filters server-side, then write a generic note that
    // the AI does not author.
    try {
      const currentCount = (report.competitors || []).length;
      const targetCount = 5;
      const needed = targetCount - currentCount;
      if (needed > 0 && Array.isArray(compPlacesData.places) && compPlacesData.places.length > 0) {
        const existingNamesLower = new Set(
          (report.competitors || []).map(c => String(c.name || '').trim().toLowerCase())
        );
        const userLoweredSet = new Set(userCompetitors.map(n => n.toLowerCase()));
        // Helper: is this name already in the competitor list (exact or substring)?
        const isAlreadyIncluded = (placeName) => {
          const pLower = String(placeName || '').trim().toLowerCase();
          if (!pLower) return true;
          if (existingNamesLower.has(pLower)) return true;
          for (const existing of existingNamesLower) {
            if (existing.length >= 4 && (existing.includes(pLower) || pLower.includes(existing))) return true;
          }
          for (const u of userLoweredSet) {
            if (u.length >= 4 && (u.includes(pLower) || pLower.includes(u))) return true;
          }
          return false;
        };

        // Non-restaurant patterns — same set used in the quality filter,
        // applied here pre-emptively so we don't propose hotels/fast-food.
        const nonRestaurantPatterns = [
          /^hotel\s/i, /\shotel\b/i,
          /^(mc\s*donald|burger king|kfc|subway|starbucks|dunkin|domino|pizza hut|taco bell|wendy|chipotle)/i,
          /\bpub\b/i,
          /\b(food\s*court|food\s*hall|airport|gas\s*station|service\s*station)\b/i
        ];
        const isNonRestaurant = (placeName) => {
          for (const pat of nonRestaurantPatterns) {
            if (pat.test(placeName || '')) return true;
          }
          return false;
        };

        // Build a ranked candidate list from Places. Score = composite of
        // rating (higher = better), reviewCount (more = more established),
        // and distance (closer = more direct competitor). Then take top N.
        const focalRating = focalContext && typeof focalContext.rating === 'number' ? focalContext.rating : null;
        const ratingFloor = (focalRating !== null && focalRating < 3.5) ? focalRating : 3.5;

        const ranked = compPlacesData.places
          .filter(p => {
            if (!p.name) return false;
            if (isAlreadyIncluded(p.name)) return false;
            if (isNonRestaurant(p.name)) return false;
            if (typeof p.rating !== 'number' || p.rating < ratingFloor) return false;
            if (typeof p.reviewCount !== 'number' || p.reviewCount < 50) return false;
            return true;
          })
          .map(p => ({
            ...p,
            // Composite score: rating weighted heavily, log(reviews) bonus,
            // distance penalty (closer is better)
            _score: (p.rating * 20)
                    + Math.min(10, Math.log10(Math.max(1, p.reviewCount)) * 2)
                    - ((p.distance || 2000) / 1000) * 1.5
          }))
          .sort((a, b) => b._score - a._score);

        const toAdd = ranked.slice(0, needed);
        if (toAdd.length > 0) {
          console.log(`[diagnose] PLACES-FILL: injecting ${toAdd.length} tier-peer(s) from Google Places: ${toAdd.map(p => `${p.name} (${p.rating}★, ${p.reviewCount}r, ${p.distance}m)`).join(' | ')}`);
          for (const p of toAdd) {
            // Build a competitor entry with a programmatically-generated note.
            // The note style mirrors the AI's framing — "established peer
            // competing for same dining occasion" — so all 5 cards read as
            // a coherent set. Title-case the location segment so it reads
            // naturally regardless of whether the user typed it lower / upper / mixed.
            const distKm = p.distance ? (p.distance / 1000).toFixed(1) : null;
            const reviewLabel = p.reviewCount >= 1000
              ? (p.reviewCount/1000).toFixed(1).replace(/\.0$/, '') + 'k'
              : String(p.reviewCount);
            const locSegRaw = (location.split(',')[0] || 'the area').trim();
            const locSeg = locSegRaw
              .toLowerCase()
              .replace(/\b(\w)/g, (m) => m.toUpperCase());
            const note = `Established neighborhood peer with ${reviewLabel} reviews${distKm ? `, ${distKm}km away` : ''}, competes for the same upscale dining occasion in ${locSeg}.`;
            report.competitors.push({
              name: p.name,
              rating: p.rating,
              reviewCount: p.reviewCount,
              note: note,
              // v8.11.26 [RVP-A]: this peer CAME from Places, so its identity
              // is already known and costs nothing. Dropping it here was why
              // an injected peer later had to be re-matched by name.
              placeId: p.placeId || null,
              placeName: p.name,
              reviewCountSource: (typeof p.reviewCount === 'number' && p.reviewCount > 0) ? 'places' : 'none',
              // v8.11.28: the rating is Places-sourced here too, by the same
              // argument as the count.
              ratingSource: (typeof p.rating === 'number' && Number.isFinite(p.rating)) ? 'places' : 'none',
              noDataReason: null,
            });
            existingNamesLower.add(String(p.name).trim().toLowerCase());
          }
          console.log(`[diagnose] PLACES-FILL: competitor count ${currentCount} → ${report.competitors.length}`);
        } else {
          console.log(`[diagnose] PLACES-FILL: no qualifying Places candidates to inject (had ${compPlacesData.places.length} candidates, all filtered out)`);
        }
      }
    } catch (e) {
      console.error('[diagnose] PLACES-FILL FAILED (continuing):', e.message);
    }

    // ── Quality filter (post-AI, post-backfill) ─────────────────────────
    // After the AI returns and Serper backfill runs, evaluate each non-user-named
    // competitor against quality floors. Rejects:
    //   - Rating below 3.0 (unless focal restaurant also rates below 3.0)
    //   - Review count below 5 (truly tiny no-info listings only)
    //   - AI note containing self-disqualifying language that EXPLICITLY states
    //     the restaurant is not a competitor (narrow regex set to avoid false
    //     positives on benign descriptive language like "alternative" or
    //     "smaller-scale")
    // User-named competitors are EXEMPT — owner knows their own market.
    try {
      if (Array.isArray(report.competitors) && report.competitors.length) {
        const focalRating = focalContext && typeof focalContext.rating === 'number' ? focalContext.rating : null;
        const ratingFloor = (focalRating !== null && focalRating < 3.5) ? focalRating : 3.5;
        const userLowered = new Set(userCompetitors.map(n => n.toLowerCase()));
        // Self-disqualifying phrases — narrowed to only the most damning explicit
        // "not a competitor" statements. We trust the prompt rules to keep the AI
        // from including bad matches; this filter is the last-line safety net.
        const disqualifyPatterns = [
          /not\s+a?\s*direct\s+competitor/i,
          /not\s+(?:really\s+)?a\s+competitor/i,
          /weak\s+competitor/i,
          /poor\s+(?:positioning|match)/i,
          /different\s+(?:concept|cuisine|category)\s+entirely/i,
          /minimal\s+overlap/i,
          /loosely?\s+related/i
        ];
        // Non-restaurant / wrong-format chains that sometimes appear in Google
        // Places nearby_search results. These compete on convenience or hotel
        // captive audiences, NOT against the focal restaurant.
        const nonRestaurantPatterns = [
          /^hotel\s/i, /\shotel\b/i,
          /^(mc\s*donald|burger king|kfc|subway|starbucks|dunkin|domino|pizza hut|taco bell|wendy|chipotle)/i,
          /\bpub\b/i,
          /\b(food\s*court|food\s*hall|airport)\b/i
        ];
        const before = report.competitors.length;
        const rejections = [];
        report.competitors = report.competitors.filter(c => {
          const nLower = String(c.name || '').trim().toLowerCase();
          // User-named entries are exempt
          let isUserNamed = false;
          for (const u of userLowered) {
            if (nLower === u || nLower.includes(u) || u.includes(nLower)) { isUserNamed = true; break; }
          }
          if (isUserNamed) return true;

          // Non-restaurant filter (hotels, fast-food chains, pubs etc)
          for (const pat of nonRestaurantPatterns) {
            if (pat.test(c.name || '')) {
              rejections.push(`"${c.name}" (non-restaurant format: ${pat.source})`);
              return false;
            }
          }
          // Rating floor check (only applies when we have a rating)
          if (typeof c.rating === 'number' && c.rating < ratingFloor) {
            rejections.push(`"${c.name}" (rating ${c.rating} < floor ${ratingFloor})`);
            return false;
          }
          // Review volume floor — meaningful peer benchmark needs real reach
          if (typeof c.reviewCount === 'number' && c.reviewCount < 50 && c.reviewCount > 0) {
            rejections.push(`"${c.name}" (${c.reviewCount} reviews < 50)`);
            return false;
          }
          // Self-disqualifying note text
          const note = String(c.note || '');
          for (const pat of disqualifyPatterns) {
            if (pat.test(note)) {
              rejections.push(`"${c.name}" (note self-disqualifies: ${pat.source})`);
              return false;
            }
          }
          return true;
        });
        if (rejections.length) {
          console.log(`[diagnose] quality filter rejected ${rejections.length}: ${rejections.join(' | ')}`);
          console.log(`[diagnose] quality filter: ${before} → ${report.competitors.length} remaining (rating floor=${ratingFloor}, review floor=5)`);
        }
      }
    } catch (e) {
      console.error('[diagnose] quality filter FAILED (continuing):', e.message);
    }

    // _debug: attach scraping provenance so issues are diagnosable from the
    // browser DevTools network tab without needing Railway log access.
    report._debug = {
      version: VERSION,
      focalContext: focalContext || null,
      userCompetitorsReceived: userCompetitorsRaw,
      userCompetitorsParsed: userCompetitors,
      serperExtracted: compUserResults.map(r => ({
        name: r.userName,
        resolvedTitle: r.resolvedTitle,
        rating: r.rating,
        reviewCount: r.reviewCount,
        // The Places verdict, kept so a later reader can tell which source a
        // stored rating came from and why a state was chosen. Reconstructing
        // this after the fact is impossible: the ratings move.
        placeName: r.placeName,
        placeId: r.placeId,
        placeRating: r.placeRating,
        placeReviewCount: r.placeReviewCount,
        placeAgrees: r.placeAgrees
      })),
      googlePlaces: {
        count: compPlacesData.places?.length || 0,
        focalLatLng: compPlacesData.focalLatLng || null,
        topNearby: (compPlacesData.places || []).slice(0, 10).map(p => ({
          name: p.name, rating: p.rating, reviewCount: p.reviewCount,
          priceLevel: p.priceLevel, distance: p.distance
        }))
      },
      aiReturnedCompetitorNames: Array.isArray(p2.competitors)
        ? p2.competitors.map(c => c && c.name).filter(Boolean)
        : [],
      aiReturnedCompetitorCount: Array.isArray(p2.competitors) ? p2.competitors.length : 0,
      finalCompetitors: Array.isArray(report.competitors)
        ? report.competitors.map(c => ({ name: c.name, rating: c.rating, reviewCount: c.reviewCount }))
        : [],
      competitorWebDataChars: (co || '').length,
      competitorSectionLabels: (co || '').match(/\[(USER-NAMED|GOOGLE-PLACES|SIMILAR-TO|NEIGHBORHOOD|TOP-IN-CITY)[^\]]*\]/g) || [],

      // -- totalMs: how long this request took ------------------------------
      //
      // Mirrors what /evp/diagnose has recorded since v1.0. RVP had no timing
      // anywhere, and on 2026-09-03 that made a live question unanswerable.
      // /diagnose runs SILENT on Railway public networking, which closes a
      // request after 5 minutes with no data transferred, so a route running
      // past 300s would be killed mid-request and the client would fall back to
      // buildFallback, showing self-assessment scores rather than an error.
      //
      // The exposure was recorded; whether it was LIVE could not be, because
      // nothing stored measured a single /diagnose end to end. benchmarks has
      // no timing column, analytics_events is empty, and this object carried
      // provenance only. The answer had to be DERIVED, from gaps between
      // consecutive benchmarks rows of the same subject inside a bulk run:
      // 18 observations, min 21.4s, median 24.6s, max 30.7s, none within a
      // factor of nine of the limit. Theoretical risk on that evidence.
      //
      // ONE GAP REMAINS AND THIS FIELD CLOSES IT. All 18 came from Analytics
      // calling with { name, location } only. A customer also sends survey
      // sentiment and user-named competitors, which add [USER-NAMED] Serper
      // layers a bulk call never triggers. Those layers run inside the same
      // Promise.all, so the cost is parallel rather than additive and is
      // probably small - but probably is not measured, and there are ZERO
      // observations of the request shape a paying customer actually sends.
      //
      // This lands in subscribers.baseline_report, verified 2026-09-03: 50 of
      // 87 stored rows already carry _debug and every recent one does. It is
      // also printed by the [diagnose] _debug log line below, so it is
      // greppable without a database read.
      //
      // Read at _debug construction, so it excludes buildBenchmarkRow and the
      // JSON serialisation that follow. Both are synchronous and small: this is
      // the customer's wait to within a few milliseconds, not to the byte.
      totalMs: Date.now() - t0
    };
    // ── Competitor source disclosure (v8.9.25) ───────────────────────────
    // When Google Places cannot anchor the search to a coordinate, the
    // competitor set is assembled from search-result text instead. That
    // degradation was previously invisible: the report read identically to one
    // where Places worked, and the only trace was a log line. A run on
    // 2026-08-31 named restaurants in Mexico City and Lima as competitors for a
    // Santiago restaurant and nothing in the output said so.
    //
    // Two conditions, deliberately worded differently because the reader's
    // takeaway is the same but the cause is not:
    //   A  no coordinate at all, the geocode failed
    //   B  coordinates resolved but no nearby results came back. Reachable in
    //      sparse areas, and also when nearbysearch returns only the focal
    //      restaurant, which the filter then removes leaving an empty list.
    //
    // No note in the healthy case. This is a disclosure, not a methodology
    // section. The cost is that a reader cannot tell "no note, everything
    // worked" from "no note, older report", which is an argument for a proper
    // source line later rather than for a bigger note now.
    // v8.9.29: the wording no longer draws a contrast with the healthy case.
    //
    // Both strings used to say the competitors were identified from search
    // results "rather than by mapped proximity", which described the healthy
    // path by implication and described it wrongly. When that note was written,
    // neither model call could see the [GOOGLE-PLACES] section at all (the
    // corpus was truncated before it), so the distinction it drew did not
    // exist. v8.9.26 fixed that, and post-fix runs matched 63 of 79 model-named
    // competitors to the Places list. Better, but still roughly a fifth named
    // from search prose, plus entries the renderer injects afterwards.
    //
    // So each string now states what is true of the report in front of the
    // reader, without claiming anything about what a different run would do.
    // That also means the wording survives the match rate changing again.
    const placesCount = compPlacesData.places?.length || 0;
    if (!compPlacesData.focalLatLng) {
      report.competitorSourceNote = 'Location data was unavailable when this report ran, so the competitors below were identified from search results alone, with no check on whether they are near your restaurant. Some may not be. Treat the competitive comparison as indicative.';
      report.competitorSourceLevel = 'risk';
    } else if (placesCount === 0) {
      report.competitorSourceNote = 'No nearby restaurants were returned for this location, so the competitors below were identified from search results alone, with no check on whether they are near your restaurant. Treat the competitive comparison as indicative.';
      report.competitorSourceLevel = 'risk';
    } else {
      // The healthy case now says something too. Silence implied a purity the
      // peer set does not have: it mixes restaurants matched from the mapped
      // nearby list with businesses named from search prose. A disclosure that
      // appears only when something is wrong also teaches a reader to ignore
      // it, and it left "no note" ambiguous between "everything worked" and
      // "older report predating the note".
      report.competitorSourceNote = 'Competitors are drawn from restaurants mapped near you, combined with named businesses found in search. Not every comparison is a direct competitor.';
      report.competitorSourceLevel = 'info';
    }
    if (report.competitorSourceLevel === 'risk') {
      console.warn(`[diagnose] COMPETITOR_SOURCE_DEGRADED note added: focalLatLng=${compPlacesData.focalLatLng ? 'present' : 'null'} placesCount=${placesCount}`);
    }

    // ── v8.11.26 [RVP-A]: every peer carries a Google Places id ─────────────
    //
    // Peers arrive from three places: injected by PLACES-FILL (identity known
    // already), named by the model, or named by the owner. Only the first had
    // an id. The other two were matched by NAME, which produced both defects
    // this release fixes: "Scoma's Restaurant" twice with 7,211 and 6,396, and
    // the focal Zulu count of 4,552 from a knowledge graph against 625 from
    // Places for the same restaurant.
    //
    // One findplacefromtext call per unresolved peer, all in parallel, after
    // the model has already answered. Same endpoint and field list the focal
    // geocode uses, so this adds call sites rather than a dependency.
    //
    // A peer that does not resolve keeps its name and its note and LOSES its
    // review count. That is deliberate: a number with no place id is a number
    // with no provenance, and the report is better with a gap than with a
    // figure a reader cannot check.
    try {
      const peersIn = Array.isArray(report.competitors) ? report.competitors : [];
      const needLookup = peersIn.filter(c => c && typeof c === 'object' && !c.placeId);
      const searchLoc = location || '';
      const hits = await Promise.all(needLookup.map(c => {
        const q = searchLoc ? `${c.name}, ${searchLoc}` : String(c.name || '');
        return findPlaceForCompetitor(q).catch(e => ({ ok: false, reason: 'threw' }));
      }));
      const hitByRef = new Map();
      needLookup.forEach((c, i) => hitByRef.set(c, hits[i]));

      const resolved = peersIn.map(c => {
        if (!c || typeof c !== 'object') return c;
        if (c.placeId) return c;                      // already identified
        return attachPlaceIdentity(c, hitByRef.get(c));
      });
      const beforeCount = resolved.length;
      report.competitors = dedupePeersByPlaceId(resolved);
      const summary = placesResolutionSummary(report.competitors);
      console.log('[diagnose] PLACES-ID ' + summary.line
        + (beforeCount !== report.competitors.length
            ? ', ' + (beforeCount - report.competitors.length) + ' duplicate(s) merged on place id'
            : ', no duplicates'));
    } catch (e) {
      // Never worth failing an assessment for. The peers keep whatever they
      // had, and the evidence panel will simply count fewer of them.
      console.log('[diagnose] PLACES-ID failed, peers left as they were: ' + (e && e.message));
    }

    console.log('[diagnose] _debug:', JSON.stringify(report._debug));

    // ── ALL-1: the evidence base panel, computed here and never by the model ──
    //
    // The counts come from the ledger, which recorded what the searches
    // actually returned and how much of it entered the corpus. The review
    // volumes come from Google Places user_ratings_total for the focal
    // restaurant and each peer: exact integers, already fetched, already tied
    // to a place_id. RVP is the only one of the three products where the
    // volumes need no name matching, so there is no subject test here to get
    // wrong.
    //
    // GOOGLE PLACES ONLY, AND THAT RESTRICTION IS THE WHOLE POINT.
    //
    // report.competitors[].reviewCount is MIXED PROVENANCE: some figures come
    // from Places, some from a Serper knowledge-graph lookup, some from the
    // Serper backfill. The knowledge graph is not reliable for this. On the
    // 2026-09-19 Zulu assessment the KG reported 4,552 reviews for the focal
    // restaurant while Places reported 625 for the same business. Summing the
    // competitor list would therefore have published a number that is wrong by
    // a factor of seven and impossible for a reader to check.
    //
    // So the volumes are taken from compPlacesData alone: focalReviewCount for
    // the subject, and the places array for the peers, matched by name. A peer
    // that reached the report through Serper contributes nothing, which
    // undercounts rather than overstates, and undercounting is the side to err
    // on for a figure printed as evidence.
    //
    // ONE FIGURE PER DISTINCT BUSINESS, largest wins. The competitor list has
    // carried the same restaurant under two spellings ("Pizzeria Tiramisu" and
    // "Pizzería Tiramisú" on the Starnberg run), so the key is accent folded.
    try {
      const ev = summarizeEvidence(currentLedger());
      // v8.11.26 [RVP-A]: counted by PLACE ID, not by folded name. The focal
      // figure comes from its own place id or is omitted, which is what stops
      // a knowledge-graph number being printed as a Places one.
      const focalForVolumes = {
        placeId: (compPlacesData && compPlacesData.focalPlaceId) || null,
        reviewCount: (compPlacesData && compPlacesData.focalReviewCount) || null,
      };
      const vol = peerReviewVolumes({ focal: focalForVolumes, peers: report.competitors || [] });

      // Recorded so a later audit can check this panel against its inputs.
      // focalReviewCount was absent from _debug until now, which is why the
      // stored reports cannot be rehearsed for the focal figure.
      if (report._debug && report._debug.googlePlaces) {
        report._debug.googlePlaces.focalReviewCount =
          (compPlacesData && typeof compPlacesData.focalReviewCount === 'number')
            ? compPlacesData.focalReviewCount : null;
        report._debug.googlePlaces.volumesCountedFrom = 'place-id-only';
        report._debug.googlePlaces.focalPlaceIdPresent =
          !!(compPlacesData && compPlacesData.focalPlaceId);
        report._debug.googlePlaces.peersUnresolved = vol.unresolved;
      }
      const reviewsTotal = vol.total;
      const sourcesCounted = vol.counted;

      report.evidence = {
        searchesRun:     ev.searchesRun,
        resultsReturned: ev.resultsReturned,
        resultsRead:     ev.resultsRead,
        distinctSites:   ev.distinctSites,
        // Omitted rather than zeroed when nothing could be counted: a printed
        // zero reads as a finding about the subject, when it is really an
        // absence of instrumentation.
        reviewsTotal:    reviewsTotal > 0 ? reviewsTotal : null,
        sourcesCounted:  sourcesCounted > 0 ? sourcesCounted : null,
        reviewsSentence: renderEvidenceSentence({ reviewsTotal, sourcesCounted }),
      };
      console.log('[diagnose] EVIDENCE searches=' + ev.searchesRun
        + ' returned=' + ev.resultsReturned + ' read=' + ev.resultsRead
        + ' sites=' + ev.distinctSites
        + ' reviewVolumes=' + (reviewsTotal > 0 ? formatCount(reviewsTotal) : '(none)')
        + ' across=' + sourcesCounted
        + ' peersWithoutPlaceId=' + vol.unresolved);
    } catch (e) {
      // The panel is never worth failing an assessment for. A report with no
      // evidence block renders no panel, which is the zero case by design.
      console.log('[diagnose] EVIDENCE failed, panel omitted: ' + (e && e.message));
      report.evidence = null;
    }

    // Sanitize here, where the object is complete: the competitor merge, both
    // filters, _debug and the source note have all run. buildBenchmarkRow below
    // reads this same object, so the response and the benchmark row both get the
    // cleaned text from one pass.
    sanitizeReportProse(report);

    // ── Analytics benchmark capture (v8.9.24, id returned since v8.9.35) ──
    //
    // The row is BUILT before the response and WRITTEN after it. Nothing is
    // awaited, every error is logged and swallowed, so a Supabase outage still
    // cannot reach the user. That constraint is unchanged.
    //
    // What changed is that the caller now learns the row's id. buildBenchmarkRow
    // generates it rather than leaving it to the column default, so it is known
    // without waiting for the insert.
    //
    // WHAT report.benchmarkId IS AND IS NOT. It is a claim that a write will be
    // ATTEMPTED with that id. It is not proof that a row exists: a Supabase
    // failure after the response leaves the id pointing at nothing. That matters
    // because bulk_run_subjects.benchmark_id is a real foreign key to
    // benchmarks(id), so an orchestrator that inserts this id without checking
    // would violate the constraint whenever a write failed. Verify the row
    // exists, or set the reference in a second pass. Do not treat this id as a
    // guarantee.
    //
    // Null means no row is coming, and benchmarkSkip says why. Three of the four
    // reasons are known synchronously, so a caller learns "capture is off" or
    // "no usable score" immediately instead of inferring it from a row that
    // never appears. The fourth, a Supabase failure, cannot be known in advance
    // and is exactly the case the caveat above is about.
    const benchmarkRow = buildBenchmarkRow({
      report, name, location, country, region, focalContext,
      focalGeo: compPlacesData.focalGeo || null,
      focalPlaceId: compPlacesData.focalPlaceId || null,
      focalReviewCount: compPlacesData.focalReviewCount,
      newestReviewAt: intakeNewestReviewAt,
    });
    const benchmarkSkip = benchmarkSkipReason(benchmarkRow);
    report.benchmarkId = benchmarkSkip ? null : benchmarkRow.id;
    report.benchmarkSkip = benchmarkSkip;
    // The gate's state travels with the report, so the page and the delivered
    // report can print the limited note. Absent on an Analytics call.
    if (coverage) report.coverage = coverage;
    // The confirmed place's two names, so the page can print Google's and save
    // the typed one beside it for the purchase's peer query. Absent on an
    // Analytics call (no confirmed place).
    if (confirmedPlace) report.subject = { name: displayName, typedName: name, placeId: confirmedPlace.placeId };

    console.log('[diagnose] SUCCESS score:', report.healthCheckScore,
      benchmarkSkip ? `benchmark=skipped(${benchmarkSkip})` : `benchmarkId=${benchmarkRow.id}`);
    res.status(200).json(report);

    if (!benchmarkSkip) {
      writeBenchmarkRow(benchmarkRow).catch(err => {
        console.error('[benchmark] capture chain error:', err.message || err);
      });
    }
    return;
  } catch(e) {
    console.error('[diagnose] FAILED:', e.message);
    res.status(500).json({ error: e.message });
    notifyAssessmentFailed({ name, location, error: e.message, ms: Date.now() - t0,
      caller: body.placeToken ? 'survey (confirmed place)' : body.placeId ? 'Analytics peer run' : 'survey' });
    return;
  }
}));

// ── /translate ───────────────────────────────────────────────
app.post('/translate', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { lang, langName, data } = req.body;
  if (!lang || !data) return res.status(400).json({ error: 'lang and data required' });
  if (lang === 'en') return res.json(data);

  const ak = process.env.ANTHROPIC_API_KEY;
  if (!ak) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  console.log(`[translate] Translating report to ${langName} (${lang})`);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: `You are a professional translator. Translate all string values in the JSON object into ${langName}. 
Output ONLY valid JSON with the exact same structure and keys. No markdown. No backticks. Start with { end with }.
Rules:
- Translate every string value. Do not translate keys.
- Keep numbers, null, and boolean values unchanged.
- For arrays of strings, translate each string.
- Preserve proper nouns (restaurant names, platform names like Google, TripAdvisor, etc.).
- Keep the same professional tone as the original.`,
        messages: [{ role: 'user', content: `Translate this JSON into ${langName}:\n${JSON.stringify(data)}` }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let parsed;
    try { parsed = JSON.parse(t); }
    catch(e) {
      const i = t.indexOf('{'), j = t.lastIndexOf('}');
      if (i >= 0 && j > i) parsed = JSON.parse(t.slice(i, j + 1));
      else throw new Error('JSON parse failed');
    }
    console.log(`[translate] Success → ${langName}`);
    return res.status(200).json(parsed);
  } catch(e) {
    console.error('[translate] FAILED:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── /save-report ─────────────────────────────────────────────
//
// v8.11.11: WRITES THROUGH TO A TABLE, KEEPS THE MAP AS A CACHE.
//
// Until now a finished survey lived only in an in-memory Map, so every deploy
// and every restart destroyed the report of anyone sitting between the survey
// and the payment. That is not a rare window: the 12:47 test purchase on
// 2026-09-19 missed for a different reason, but the same handler is one
// restart away from losing a paid customer's only copy.
//
// G4, DEPLOY SAFETY. The table write is BEST EFFORT and comes last. If the
// table does not exist, if the credentials are missing, if Supabase is down or
// slow, the Map is already written and the response is already 200. A failure
// is logged under a greppable marker and changes nothing the caller sees. This
// can therefore be deployed before the migration is run, in either order.
//
// THE ROUTE IS OPEN. No auth, CORS '*', and now it writes to a database, so it
// gains a size cap and a small rate limit. Both are deliberately far above
// anything a real survey produces: the largest report ever stored is 21,469
// bytes against a 262,144 byte cap, and a real operator saves once.
const SAVE_RATE = { byEmail: new Map(), byIp: new Map() };
const SAVE_RATE_WINDOW_MS = 60 * 60 * 1000;
const SAVE_RATE_MAX_EMAIL = 5;
const SAVE_RATE_MAX_IP = 30;

function saveRateExceeded(bucket, key, max, now) {
  if (!key) return false;
  const hits = (bucket.get(key) || []).filter(t => now - t < SAVE_RATE_WINDOW_MS);
  hits.push(now);
  bucket.set(key, hits);
  // Opportunistic sweep so the Map cannot grow without bound.
  if (bucket.size > 5000) {
    for (const [k, v] of bucket) {
      const live = v.filter(t => now - t < SAVE_RATE_WINDOW_MS);
      if (live.length) bucket.set(k, live); else bucket.delete(k);
    }
  }
  return hits.length > max;
}

// Best effort, never throws, never blocks the response.
// v8.11.21 [C1]: RETURNS THE ROW ID, NOT A BOOLEAN.
//
// The id is the link between the Map entry and the row that can be claimed.
// Linking by id rather than by timestamp is the point: two surveys saved in
// the same second under the same address would be indistinguishable by
// savedAt, and a clock skew between this process and Postgres would make a
// timestamp comparison wrong in a way nothing would ever notice.
//
// Returns the id on success, or null on every failure. A null id makes the
// entry fall into the "trust memory and log it" branch of memoryHitVerdict,
// which is the same behaviour this code had before C1.
// ── Duplicate submissions (v8.11.33) ──────────────────────────────
//
// The Drum & Monkey was saved twice under one address on 2026-09-20, three
// minutes apart, and both rows are still unclaimed. The older one is
// unreachable: a payment buys the newest, and nothing revisits the rest.
//
// The older row is marked claimed_by = 'superseded-duplicate' rather than
// deleted. A delete would destroy a report that cannot be regenerated without
// re-running the assessment, and the label is the record of why the row stopped
// being a candidate.
//
// BEST EFFORT, AND AFTER THE NEW ROW EXISTS. Nothing here may fail a save: the
// survey is already in the Map and already answered 200 by this point, and a
// failure to tidy an older row is not a reason to lose a new one.
async function supersedeDuplicateRows({ key, newRowId, survey, savedAt }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey || !newRowId) return 0;
  try {
    const since = new Date(Number(savedAt) - DUPLICATE_WINDOW_MS).toISOString();
    const r = await fetch(url + '/rest/v1/pending_reports?select=id,email_normalized,survey,saved_at,claimed_at'
      + '&claimed_at=is.null&email_normalized=eq.' + encodeURIComponent(key)
      + '&saved_at=gte.' + encodeURIComponent(since) + '&order=saved_at.desc&limit=10',
      { headers: { apikey: dbKey, Authorization: 'Bearer ' + dbKey } });
    if (!r.ok) { console.log('DUPLICATE [pending] lookup failed ' + r.status); return 0; }
    const rows = await r.json();
    const incoming = { id: newRowId, survey, saved_at: Number(savedAt), claimed_at: null };
    let n = 0;
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const existing = { id: row.id, survey: row.survey, saved_at: Date.parse(row.saved_at),
                         claimed_at: row.claimed_at };
      if (!isDuplicateSubmission({ existing, incoming })) continue;
      const ok = (await claimPendingReport({ id: row.id, claimedBy: DUPLICATE_CLAIM_LABEL })).claimed;
      if (ok) {
        n++;
        console.log('DUPLICATE [pending] superseded row=' + row.id
          + ' by=' + newRowId + ' reason=same-restaurant-within-'
          + (DUPLICATE_WINDOW_MS / 60000) + 'min addr=' + addrLabel(key));
      }
    }
    if (n === 0) console.log('DUPLICATE [pending] none to supersede addr=' + addrLabel(key));
    return n;
  } catch (e) {
    console.log('DUPLICATE [pending] error ' + (e && e.message));
    return 0;
  }
}

async function persistPendingReport({ key, report, survey, product, savedAt }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) { console.log('PENDING_WRITE [pending] skipped: supabase not configured'); return null; }
  try {
    const r = await fetch(url + '/rest/v1/pending_reports', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: dbKey,
        Authorization: 'Bearer ' + dbKey,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        email_normalized: key,
        product: product || 'full',
        report: report || null,
        survey: survey || null,
        saved_at: new Date(savedAt).toISOString(),
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.log('PENDING_WRITE [pending] failed ' + r.status + ' ' + txt.slice(0, 160));
      return null;
    }
    let id = null;
    try {
      const rows = await r.json();
      id = Array.isArray(rows) && rows.length && rows[0] && rows[0].id ? String(rows[0].id) : null;
    } catch (_) { id = null; }
    console.log('PENDING_WRITE [pending] ok domain=' + addrLabel(key)
      + ' row=' + (id || 'unknown'));
    // v8.11.33: the same survey submitted twice is one survey. Best effort,
    // after the row exists, and never allowed to fail the save.
    if (id) await supersedeDuplicateRows({ key, newRowId: id, survey, savedAt });
    return id;
  } catch (e) {
    console.log('PENDING_WRITE [pending] error ' + (e && e.message));
    return null;
  }
}

//
// v8.11.16 [A5]: THE LIMITS PROTECT THE DATABASE WRITE, NOT THE SAVE.
//
// The first version of this returned 413 and 429 before touching the Map,
// which put a brand new failure mode in front of a survey that used to
// succeed: a caller over the limit lost their report entirely, and the report
// cannot be regenerated without re-running the assessment. That is a worse
// outcome than the open door the limits exist to close.
//
// So the in-memory save and the 200 ALWAYS happen, exactly as they did before
// any of this work. The limits decide one thing only: whether the row is also
// written to the database. A limited request logs PENDING_WRITE skipped and
// nothing else about it changes.
//
// CLIENT IP BEHIND RAILWAY. Express is not configured with 'trust proxy'
// anywhere in this service, so req.ip is Railway's edge address and is the
// SAME for every caller: rate limiting on it would be a single global bucket
// that one busy customer could exhaust for everyone. The forwarded address is
// therefore the one used, taking the FIRST entry of x-forwarded-for, which is
// the value Railway sets. It is client-supplied and spoofable, which is why it
// is a mitigation on a database write and not an authentication decision, and
// why the per-address bucket exists beside it.
app.post('/save-report', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { email, report, survey, product } = req.body || {};
  if (!email || !report) {
    return res.status(400).json({ error: 'email and report required' });
  }

  const key = normalizeEmail(email);
  const now = Date.now();

  // The Map first, and the response next. Nothing below can change either.
  //
  // v8.11.21 [C1]: pendingId starts null and is filled in when the row lands.
  // Until then the entry reads as "no pending id", which means memory is
  // trusted, which is exactly the behaviour that existed before C1. A survey
  // paid for in the two seconds before the insert returns is therefore
  // delivered, not refused.
  reportStore.set(key, { report, survey, product: product || 'full', savedAt: now, pendingId: null });
  const bytes = saveSizeBytes(report, survey);
  console.log('[save-report] Saved for domain:', addrLabel(key), 'bytes=' + bytes);
  res.status(200).json({ ok: true });

  // Everything from here decides only whether the DATABASE also gets it.
  let skip = null;
  if (bytes > MAX_SAVE_BYTES) {
    skip = 'oversize-' + bytes + '-cap-' + MAX_SAVE_BYTES;
  } else {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || req.ip || '';
    if (saveRateExceeded(SAVE_RATE.byEmail, key, SAVE_RATE_MAX_EMAIL, now)) skip = 'rate-limit-address';
    else if (saveRateExceeded(SAVE_RATE.byIp, ip, SAVE_RATE_MAX_IP, now)) skip = 'rate-limit-ip';
  }

  if (skip) {
    console.log('PENDING_WRITE [pending] skipped reason=' + skip + ' domain=' + addrLabel(key));
    return;
  }

  persistPendingReport({ key, report, survey, product, savedAt: now })
    .then((pendingId) => {
      if (!pendingId) return;
      // Guarded on savedAt: if the same address saved a NEWER survey while this
      // insert was in flight, the Map already holds that one and stamping this
      // id onto it would point the newer entry at the older row.
      const cur = reportStore.get(key);
      if (cur && cur.savedAt === now) {
        reportStore.set(key, Object.assign({}, cur, { pendingId }));
      } else {
        console.log('PENDING_WRITE [pending] row ' + pendingId
          + ' not linked to memory: a newer survey replaced the entry');
      }
    })
    .catch(e => console.log('PENDING_WRITE [pending] unexpected ' + (e && e.message)));
});

// ── /get-report ──────────────────────────────────────────────
app.get('/get-report', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });

  const saved = reportStore.get(email);
  if (!saved) {
    console.log('[get-report] Not found for:', email);
    return res.status(404).json({ error: 'Report not found or expired' });
  }

  if (Date.now() - saved.savedAt > 2 * 60 * 60 * 1000) {
    reportStore.delete(email);
    return res.status(404).json({ error: 'Report expired' });
  }

  console.log('[get-report] Retrieved for:', email);
  res.status(200).json({ report: saved.report, survey: saved.survey, product: saved.product });
});

// ── HUBSPOT (legacy contact sync, kept for compatibility) ────
async function saveToHubSpot(email, firstName, restaurantName, location, report) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !email) return;
  try {
    const properties = {
      email,
      firstname:               firstName || '',
      restaurant_name:         restaurantName || '',
      restaurant_location:     location || '',
      // v8.11.53: computed from the pillars. 0 was recorded on every 8.11.52 sale.
      diagnostix_score:        recordedScore(report).score ?? 0,
      diagnostix_verdict:      recordedScore(report).verdict || '',
      diagnostix_cuisine:      report.cuisineDetected || '',
      diagnostix_online_score: report.onlinePresence && report.onlinePresence.overall ? report.onlinePresence.overall : 0,
      diagnostix_date:         new Date().toISOString().split('T')[0],
      report_purchased:        false,
      lead_source:             'DiagnostiX'
    };
    const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ properties })
    });
    const createData = await createRes.json();
    if (createData.status === 'error' && createData.message && createData.message.includes('already exists')) {
      const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] })
      });
      const searchData = await searchRes.json();
      if (searchData.results && searchData.results[0]) {
        await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + searchData.results[0].id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ properties })
        });
      }
    }
    console.log('[hubspot] Contact saved:', maskAddr(email));
  } catch(e) {
    console.log('[hubspot] Failed:', e.message);
  }
}

// ── Peer comparison, fetched from Analytics ────────────────────────────────
//
// Called from /payment-webhook after createCustomer returns and before the
// report email. The subscriber row and its token exist by then, which is why
// there and not earlier.
//
// THE EMAIL WAITS, CAPPED. The webhook already responded 200 at the top of the
// handler, so nothing upstream is waiting on this. But a hang here would delay
// a paid customer's only email indefinitely, so the cap is hard and the report
// always arrives. A report that changes under the reader between views is worse
// than one that takes five minutes, which is why the email waits rather than
// sending first and backfilling.
//
// THE CAP IS 280s. It was 150, raised to 300 before the first live run, then
// lowered to 280 once the platform limit was read.
//
// 150 came from arithmetic: five peers at two assessments each is ten /diagnose
// calls at concurrency 3, which fits. The measurement said otherwise.
//
// THE 3x SPREAD IS REAL, re-verified from the stored rows 2026-09-03 rather than
// restated. The two swept runs took 106.5s and 320.4s measured from the run
// rows' created_at and completed_at, and the work was genuinely identical: both
// record api_calls {geocode:1, nearbysearch:53, rvp_diagnose:11} and both cost
// $1.701. Previously written here as "107s and 322s"; 320.4 is the measured
// figure. Verify a call count from api_calls.rvp_diagnose and NOT from
// bulk_run_subjects.assessments_run, which is null on the older run because
// migration 007 postdates it and reads as zero assessments if trusted.
//
// The first live comparison, 2026-09-03, took 108.8s for eleven calls, so 150
// would in fact have fitted and the raise is not vindicated by that run. It is
// not refuted either, and the reason is sharper than one fast sample: a peer run
// SKIPS DISCOVERY, so its 108.8s is assessment alone, while the fast swept run's
// 106.5s covers eleven assessments PLUS a geocode and 53 nearbysearch calls.
// The peer run is therefore slightly SLOWER per assessment than the swept run it
// looks comparable to, not faster. How much of a swept run is discovery is
// recorded nowhere, so the 320.4s cannot be decomposed.
//
// THE SLOW END IS DISCOVERY, NOT ASSESSMENT. MEASURED 2026-09-03, AND IT
// CORRECTS WHAT THIS COMMENT SAID EARLIER THE SAME DAY.
//
// The superseded claim, kept visible because it drove the paragraph above:
// "eleven assessments at the slow end of a 3x spread is on the order of 300s of
// assessment alone, so a peer comparison hitting the slow end cannot complete at
// all". That was inferred from the run totals and never checked against the
// per-call data. It is wrong.
//
// Decomposing all three stored runs by benchmarks.created_at, which marks the
// moment each /diagnose responded because res.json fires BEFORE the
// fire-and-forget benchmark write:
//
//   run         total     start -> first row      first -> last row
//   1bf33960    320.4s    226.7s  (discovery)     93.0s
//   86fcae1f    106.5s     23.8s                  81.3s
//   abf353a8    108.8s     25.1s  (no discovery)  83.5s
//
// The assessment phases agree within 14%. The ENTIRE 3x spread sits before the
// first benchmark row, in discovery. A single /diagnose is 21.4s to 30.7s across
// 18 observations, median 24.6s, and even the slow run's own calls were normal
// at 22.3 to 28.2s.
//
// A PEER RUN SKIPS DISCOVERY ENTIRELY, so the variance that justified raising
// this cap belongs to a phase this path does not execute. The peer assessment
// phase should stay near 85 to 110s, and 280s is roughly a 2.5x margin rather
// than the near-miss the earlier paragraph described.
//
// Two caveats, because this is a check RETIRING a finding and that direction
// deserves more scrutiny than one confirming it. It rests on ONE slow run whose
// discovery cause is unexplained: both swept runs recorded identical api_calls
// and both inserted 930 subject rows, so the stored data does not distinguish
// them. And all 18 observations are of Analytics calling with { name, location }
// only, never the heavier shape a customer sends. The totalMs field added to
// _debug in v8.11.3 closes the second gap for every future customer call.
//
// WHY NOT 300. Railway public networking closes a request after 5 MINUTES WITH
// NO DATA TRANSFERRED, and allows 15 minutes only if data keeps moving. This
// call transfers nothing for its whole duration, so 300s is the binding limit
// and a 300000 cap sat EXACTLY on it. At the boundary the platform and the
// AbortController race, and if the platform wins the catch below reports
// reason=error rather than reason=timeout, a misleading log line at the one
// moment somebody needs a clear one. 280000 makes this service lose that race
// deliberately and name its own failure honestly.
//
// THE CAP CANNOT BE RAISED AGAIN ON PUBLIC NETWORKING. A future 400s or 600s
// would be fiction: the edge closes the connection first and the number in this
// file would describe nothing. If the slow end of the spread ever has to be
// accommodated, the options are transferring data during the run, which moves
// the call into the 15 minute bucket and means this stops being a single JSON
// response, or private networking, which needs checking because RVP and
// Analytics sit in DIFFERENT Railway projects.
//
// The only cost of the longer cap is a paid customer's email arriving later,
// and five minutes after a payment is unremarkable. What it buys is that the
// absent sentence means something went wrong rather than that the day was slow,
// which is the difference between a signal and noise.
//
// SAME EXPOSURE ON /diagnose, which is NOT fixed here. It is on the same public
// networking and also transfers nothing while it runs, so a /diagnose that ran
// past 300s would be closed identically, with a paying customer on the other
// end rather than a service. The orchestrator caps its own calls at 120s so the
// peer path is safe; the customer-facing path has no such cap. Recorded in the
// analytics README under Known drift.
//
// AUTH: the shared TEAM_PASSWORD. It is a human credential used by every
// operator, so rotating it breaks this call at the same moment it logs everyone
// out, and nothing distinguishes this caller from a person. A per-service
// credential is the right answer and a separate change. Recorded here so the
// next person does not discover it during an incident.
const PEER_COMPARISON_TIMEOUT_MS = 280000;

async function fetchPeerComparison({ subjectName, displayName, subjectLocation, subjectPillars, peerNames }) {
  const base = process.env.ANALYTICS_URL;
  const pass = process.env.ANALYTICS_TEAM_PASSWORD;
  if (!base || !pass) return { ok: false, reason: 'not_configured' };
  if (!Array.isArray(peerNames) || !peerNames.length) return { ok: false, reason: 'no_peer_names' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PEER_COMPARISON_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(String(base).replace(/\/$/, '') + '/peer-comparison', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('rvp:' + pass).toString('base64'),
      },
      // displayName (contract/peer-comparison-request.contract.json): the name the
      // customer sees, for the heading; subjectName stays Analytics' Places query.
      body: JSON.stringify(Object.assign({ subjectName, subjectLocation, subjectPillars, peerNames },
        displayName && displayName !== subjectName ? { displayName } : {})),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: 'http_' + res.status, detail: text.slice(0, 200), ms: Date.now() - started };
    let data;
    try { data = JSON.parse(text); }
    catch { return { ok: false, reason: 'unparseable', ms: Date.now() - started }; }
    if (!data.ok || !data.html) {
      return { ok: false, reason: data.error ? 'refused' : 'no_html', detail: data.error || '', stats: data.stats || null, ms: Date.now() - started };
    }
    // v8.11.53: A RUN THAT ASSESSED NOBODY IS NOT A COMPARISON. Analytics
    // answers ok:true with a fragment even when every peer failed, and on
    // 2026-09-23 the paid report read "against 0 comparable businesses" above a
    // table of zeros. Treated as unavailable, so the report carries
    // PEER_COMPARISON_ABSENT and the internal alert fires.
    if (data.stats && data.stats.assessed === 0) {
      return { ok: false, reason: 'zero_assessed', detail: 'named=' + data.stats.named
        + ' resolved=' + data.stats.resolved, stats: data.stats, ms: Date.now() - started };
    }
    return { ok: true, html: data.html, stats: data.stats || null, runId: data.runId || null, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'error', detail: e.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// The absent state is a SENTENCE, never a hidden block. A comparison that is
// simply missing reads as a report with a section left out; a comparison that
// says it could not be produced reads as a report that knows what it does not
// have. The customer has paid either way.
const PEER_COMPARISON_ABSENT =
  'A peer comparison could not be produced for this report. Your own scores are '
  + 'unaffected. Contact hello@4xiconsulting.com and we will send it separately.';

// Same shape as CACHE_MISS in v8.9.37: a greppable marker carrying uptimeSec,
// plus an internal alert, so frequency is measurable from the first occurrence
// rather than after somebody asks.
async function notifyPeerComparisonUnavailable({ email, restaurantName, reason, detail, ms }) {
  console.log('[webhook] PEER_COMPARISON_UNAVAILABLE addr=' + addrLabel(email)
    + ' reason=' + reason
    + ' elapsedMs=' + (ms || 0)
    + ' uptimeSec=' + Math.round(process.uptime()));
  const INTERNAL_TO = 'hello@4xiconsulting.com';
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  try {
    await sendEmailViaResend({
      to: INTERNAL_TO,
      subject: 'Peer comparison missing on a paid report, ' + addrLabel(email),
      fromName: 'DiagnostiX Alerts',
      html: '<p><strong>A paid report shipped without its peer comparison.</strong></p>'
        + '<ul><li>address: ' + esc(addrLabel(email)) + '</li>'
        + '<li>restaurant: ' + esc(restaurantName || '(not supplied)') + '</li>'
        + '<li>reason: ' + esc(reason) + '</li>'
        + '<li>detail: ' + esc(detail || '') + '</li>'
        + '<li>elapsed: ' + esc(ms || 0) + 'ms of a ' + PEER_COMPARISON_TIMEOUT_MS + 'ms cap</li>'
        + '<li>uptime: ' + Math.round(process.uptime()) + 's</li></ul>'
        + '<p>The customer received the report with a sentence explaining the absence. '
        + 'reason=timeout points at Analytics being slow; reason=not_configured means '
        + 'ANALYTICS_URL or ANALYTICS_TEAM_PASSWORD is unset on this service.</p>',
    });
  } catch (e) {
    console.log('[webhook] PEER_COMPARISON_UNAVAILABLE alert failed:', e.message);
  }
}

// ── Cache miss on a PAID order ──────────────────────────────────────────────
//
// A customer has paid and their report is not in memory. Nothing here can
// recover it: the report cannot be regenerated without re-running the
// assessment, and no payment provider API is called anywhere in this service,
// so a refund is not reachable from code. What is reachable is telling the
// customer plainly and telling us at the same time, which is what this does.
//
// This replaces SILENCE, not something better. Before v8.9.37 a cache miss
// marked the HubSpot contact purchased and sent nobody anything.
async function notifyCacheMiss({ email, firstName, product, restaurantName, offerRecovery }) {
  const INTERNAL_TO = 'hello@4xiconsulting.com';
  // Local, matching the pattern at :2624 and :4624. There is no module-scope
  // escapeHtml in this service: the name appears only in comments about SVP,
  // which is exactly how it came to be called here.
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const who = restaurantName ? ` for ${esc(restaurantName)}` : '';

  // v8.11.13: the buyer is no longer told to wait for us. The commonest cause
  // of this email is that the address on their Wix account is not the one they
  // typed into the survey, and they are the only person who knows the other
  // one. The link lets them say it. If RVP_RECOVERY_SECRET is unset the link
  // is omitted and the email reads exactly as it did before, which is what
  // makes this deployable before the variable is set.
  // offerRecovery is decided by the caller from the webhook's secret status.
  // Undefined means an older caller; treat that as NOT allowed, because the
  // safe default for a bearer credential is not to issue one.
  const recoverUrl = offerRecovery === true ? buildRecoveryUrl(email) : null;
  if (offerRecovery === true && recoverUrl) {
    console.log('RECOVERY_LINK [recover] included in cache-miss email domain=' + addrLabel(email));
  } else {
    console.log('RECOVERY_LINK [recover] omitted, offerRecovery=' + String(offerRecovery)
      + ' secretConfigured=' + (recoverySecret() ? 'yes' : 'no'));
  }
  // v8.11.35: the recovery link is a button, and the template moved to
  // lib-email.js so a test can see the finished email. The link itself, its
  // signing, its expiry and the secret gate are untouched.
  const built = buildCacheMissEmail({ firstName, restaurantName, recoverUrl, internalTo: INTERNAL_TO });

  try {
    await sendEmailViaResend({
      to: email,
      subject: built.subject,
      fromName: 'DiagnostiX',
      html: built.html,
    });
  } catch (e) {
    console.log('[webhook] CACHE_MISS customer email failed:', e.message);
  }
  try {
    await sendEmailViaResend({
      to: INTERNAL_TO,
      subject: 'ACTION: paid order with no cached report, ' + addrLabel(email),
      fromName: 'DiagnostiX Alerts',
      html: `<p><strong>A paid order could not be matched to a report.</strong></p>
<ul>
<li>email: ${esc(email)}</li>
<li>product: ${esc(String(product || ''))}</li>
<li>restaurant: ${esc(restaurantName || '(not supplied)')}</li>
<li>uptime at miss: ${Math.round(process.uptime())}s</li>
</ul>
<p>Low uptime points at the in-memory report cache having been wiped by a
restart. High uptime points at the paying email differing from the survey
email, which is the case the removed rules were covering.</p>`,
    });
  } catch (e) {
    console.log('[webhook] CACHE_MISS internal alert failed:', e.message);
  }
}

// NOTE ON THE NAME: this marks a HubSpot contact as purchased and adds a note.
// It sends the CUSTOMER nothing, despite "AndEmail". The name reads as though
// delivery is covered here and it is not, which is why a cache miss was silent
// for so long.
async function markPurchasedAndEmail(email, firstName, restaurantName, report, product) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !email) return;
  try {
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results && searchData.results[0] ? searchData.results[0].id : null;

    if (contactId) {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties: {
          report_purchased:   true,
          subscription_active: product === 'annual'
        }})
      });
      // v8.11.14 [B5]: domain only. This line printed a customer's address on
      // every purchase, matched or not, and it is the one that fired for the
      // 2026-09-19 cache miss.
      console.log('[hubspot] Marked purchased domain:', addrLabel(email), product);

      await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          properties: {
            hs_note_body: 'DiagnostiX ' + product + ' report purchased. Score: ' + (recordedScore(report).score ?? 'N/A') + '. Restaurant: ' + restaurantName,
            hs_timestamp: new Date().toISOString()
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
          }]
        })
      });
    }
    console.log('[hubspot] Note added for domain:', addrLabel(email));
  } catch(e) {
    console.log('[hubspot] markPurchasedAndEmail failed:', e.message);
  }
}

// ── HUBSPOT — 20-PROPERTY CONTEXT PUSH ───────────────────────
async function pushReportContextToHubSpot({ subscriber, report, reportNumber, reportUrl, baseline }) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !subscriber?.email) return;

  // Subscriber can arrive as Supabase shape (snake_case) or in-memory shape (camelCase).
  const subField = (snake, camel) => subscriber[snake] !== undefined ? subscriber[snake] : subscriber[camel];
  const planTypeSafe = subField('plan_type', 'planType') || 'annual';
  const reportTokenSafe = subField('report_token', 'reportToken') || '';
  // v8.11.45: an absent amount now sends NO PROPERTY. It used to coerce to 0,
  // which would have stamped every contact with "paid 0 US dollars" the moment
  // amount_paid became null. That is a worse claim than the wrong hard-coded
  // amount it replaces: zero reads as "this customer paid nothing".
  const amountFields = hubspotAmountFields(subscriber);
  const subscribedAtRaw = subField('subscribed_at', 'subscribedAt');
  // subscribedAt in-memory is a ms timestamp; subscribed_at in Supabase is ISO string.
  const subscribedAtIso = typeof subscribedAtRaw === 'number'
    ? new Date(subscribedAtRaw).toISOString()
    : (subscribedAtRaw || new Date().toISOString());

  const isAnnual = planTypeSafe === 'annual';
  // v8.11.53: computed from the pillars of each report, not read from a field.
  const score = recordedScore(report).score ?? 0;
  const baselineScore = recordedScore(baseline).score ?? 0;

  const trajectory = reportNumber === 1 ? '' : (
    score - baselineScore >= 3 ? 'improving' :
    score - baselineScore <= -3 ? 'declining' : 'flat'
  );

  const weakestPillar = (() => {
    const pillars = report?.pillars || {};
    let lowest = null;
    for (const k of Object.keys(pillars)) {
      const p = pillars[k];
      if (typeof p.score === 'number' && (!lowest || p.score < lowest.score)) {
        lowest = { score: p.score, label: p.label || k };
      }
    }
    return lowest?.label || '';
  })();

  const lifecycle = (() => {
    if (!isAnnual) return 'one_off';
    const daysSinceSubscribe = Math.floor((Date.now() - new Date(subscribedAtIso).getTime()) / (24*60*60*1000));
    if (daysSinceSubscribe < 30) return 'new_buyer';
    if (daysSinceSubscribe >= 365) return 'lapsed';
    if (daysSinceSubscribe >= 305) return 'near_renewal';
    return 'mid_cycle';
  })();

  const properties = {
    email: subscriber.email,
    diagnostix_plan_type:           planTypeSafe,
    diagnostix_subscription_status: subscriber.active === false && isAnnual ? 'expired' : isAnnual ? 'active' : 'completed',
    ...amountFields,
    diagnostix_report_url:          reportUrl,
    diagnostix_report_token:        reportTokenSafe,
    diagnostix_reports_delivered:   reportNumber,
    diagnostix_latest_score:        score,
    diagnostix_score_trajectory:    trajectory,
    diagnostix_weakest_pillar:      weakestPillar,
    diagnostix_lifecycle_stage:     lifecycle,
    diagnostix_subscribed_at:       subscribedAtIso.split('T')[0]
  };

  if (reportNumber === 1) {
    properties.diagnostix_baseline_score = score;
    if (isAnnual) {
      properties.diagnostix_next_report_due = new Date(subscriber.next_report_at).toISOString().split('T')[0];
      properties.diagnostix_subscription_expires = new Date(
        new Date(subscriber.subscribed_at).getTime() + (365*24*60*60*1000)
      ).toISOString().split('T')[0];
    }
  } else if (reportNumber === 2) {
    properties.diagnostix_report_2_score = score;
    properties.diagnostix_next_report_due = new Date(subscriber.next_report_at).toISOString().split('T')[0];
  } else if (reportNumber === 3) {
    properties.diagnostix_report_3_score = score;
    properties.diagnostix_next_report_due = null;
  }

  if (report?.pillars?.cs?.score != null) properties.diagnostix_customer_sentiment_score = report.pillars.cs.score;
  if (report?.pillars?.pa?.score != null) properties.diagnostix_pricing_score = report.pillars.pa.score;
  if (report?.pillars?.es?.score != null) properties.diagnostix_employee_sentiment_score = report.pillars.es.score;

  try {
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: subscriber.email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results?.[0]?.id;

    if (contactId) {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties })
      });
      console.log('[hubspot-ctx] Updated', maskAddr(subscriber.email), '|', subscriber.plan_type, '| report', reportNumber, '| score', score);
    } else {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties })
      });
      console.log('[hubspot-ctx] Created', maskAddr(subscriber.email), '|', subscriber.plan_type);
    }
  } catch(e) {
    console.log('[hubspot-ctx] Push failed for', maskAddr(subscriber.email), e.message);
  }
}

// Fire-and-forget update of last_engaged_at when a report is viewed.
async function pushLastEngaged(email) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token || !email) return;
  try {
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] })
    });
    const searchData = await searchRes.json();
    const contactId = searchData.results?.[0]?.id;
    if (!contactId) return;
    await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ properties: { diagnostix_last_engaged_at: new Date().toISOString().split('T')[0] } })
    });
  } catch(e) { /* best-effort */ }
}

// ── CUSTOMER WELCOME / REPORT EMAIL ──────────────────────────
async function sendCustomerReportEmail({ subscriber, report, reportNumber, survey, provenance, swapUrl }) {
  // v8.11.35: the template moved to lib-email.js so a test can see a finished
  // email. Nothing about what is sent changed in the move.
  const { subject, html } = buildCustomerReportEmail({
    subscriber, report, reportNumber, survey, provenance, swapUrl,
    baseUrl: process.env.APP_BASE_URL,
  });


  // Send customer email (with BCC to internal address) first, then fire compact internal summary.
  // Sequential with a small pause to stay safely under Resend's 2/sec rate limit on the free tier.
  // Internal summary failures are logged but do NOT affect the customer email result.
  const INTERNAL_BCC = 'hello@4xiconsulting.com';
  const customerResult = await sendEmailViaResend({
    to: subscriber.email,
    subject,
    html,
    fromName: 'DiagnostiX',
    bcc: [INTERNAL_BCC]
  });

  // Fire-and-forget the internal summary — don't block return, don't propagate failure.
  setTimeout(() => {
    sendInternalSummaryEmail({ subscriber, report, reportNumber, survey })
      .catch(e => console.log('[email-internal] failed:', e.message));
  }, 600);

  return customerResult;
}

// ── /report VIEWER ───────────────────────────────────────────
app.get('/report', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token || token.length < 16) {
    return res.status(400).send(renderErrorPage(
      'Invalid link',
      'This report link is malformed. Please use the link from your DiagnostiX welcome email.'
    ));
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  // Try Supabase first (primary store), fall back to in-memory annualSubscribers
  // Map. The in-memory fallback covers two cases:
  //   1. Race condition — Supabase write hasn't propagated yet when user clicks link
  //   2. Supabase unconfigured — local dev or env vars missing
  let sub = null;
  if (url && key) {
    try {
      const r = await fetch(
        url + '/rest/v1/subscribers?report_token=eq.' + encodeURIComponent(token) + '&select=*',
        { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key } }
      );
      const rows = await r.json();
      sub = Array.isArray(rows) ? rows[0] : null;
      if (sub) console.log(`[/report] found in Supabase: ${sub.email}`);
    } catch(e) {
      console.log('[/report] Supabase lookup error:', e.message);
    }
  }

  // Fallback to in-memory store (annualSubscribers Map is keyed by report_token)
  if (!sub) {
    const memSub = annualSubscribers.get(token);
    if (memSub) {
      console.log(`[/report] found in-memory fallback: ${memSub.email}`);
      // Adapt in-memory shape (camelCase) to expected snake_case shape used downstream
      sub = {
        email:                memSub.email,
        first_name:           memSub.firstName,
        restaurant_name:      memSub.restaurantName,
        location:             memSub.location,
        website:              memSub.website,
        report_token:         memSub.reportToken,
        plan_type:            memSub.planType,
        amount_paid:          memSub.amountPaid,
        baseline_score:       recordedScore(memSub.reports?.[0]?.report).score ?? 0,
        baseline_report:      memSub.reports?.[0]?.report || null,
        guest_count_change:   memSub.guestCountChange,
        avg_check_change:     memSub.avgCheckChange,
        profitability_change: memSub.profitabilityChange
      };
    }
  }

  if (!sub) {
    console.log(`[/report] token not found anywhere: ${token.slice(0, 8)}...`);
    return res.status(404).send(renderErrorPage(
      'Report not found',
      'We could not find a report matching this link. It may have been revoked. Please contact support.'
    ));
  }

  try {
    // baseline_report is the only payload now. The two branches that replaced
    // it with report_2 and report_3 went with the annual product in v8.10.0.
    // That replacement mattered beyond the annual path: anything written into
    // baseline_report vanished from this page the moment a progress report
    // landed, which is why the retirement was sequenced ahead of the peer
    // comparison rather than alongside it.
    const report = sub.baseline_report;
    const reportLabel = sub.plan_type === 'one_off' ? 'Full Report' : 'Baseline Report (Day 0)';

    pushLastEngaged(sub.email).catch(() => {});

    const html = renderReportHtml({ subscriber: sub, report, reportLabel });
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch(e) {
    console.log('[/report] render error:', e.message);
    return res.status(500).send(renderErrorPage(
      'Something went wrong',
      'We could not load your report right now. Please try again in a few minutes.'
    ));
  }
});

function renderErrorPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}, DiagnostiX</title>
<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4f7fa;color:#0a2540;
margin:0;padding:40px 20px}.box{max-width:560px;margin:60px auto;background:#fff;border-radius:12px;
padding:40px;box-shadow:0 2px 12px rgba(10,37,64,.08);text-align:center}
h1{font-size:24px;margin:0 0 16px}p{font-size:16px;line-height:1.5;color:#6b7280}
.brand{font-weight:700;letter-spacing:.5px;color:#0a2540;margin-bottom:24px}
</style></head><body><div class="box"><div class="brand">DIAGNOSTIX</div>
<h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function renderReportHtml({ subscriber, report, reportLabel }) {
  const restaurant = subscriber.restaurant_name || 'Your restaurant';

  // v8.11.50: THE SCORE IS COMPUTED HERE, FROM THE SIX PILLARS PRINTED BELOW.
  //
  // It used to be report.healthCheckScore, which the model produced in the
  // same JSON object as the pillars and which is HIGHER than their mean on 102
  // of the 103 stored reports, median by 7. The report showed its working and
  // the working did not add up.
  //
  // NO FALLBACK. When the six pillars are not all there the score is null and
  // this page says so. `?? 0` would print a hard zero, and `?? healthCheckScore`
  // would put the inflated number back on exactly the payloads nobody checks.
  const overall    = computeOverall(report?.pillars);
  const score      = overall.score;
  const hasScore   = overall.ok;
  const verdict    = verdictFor(score) || '';
  const summary    = report?.executiveSummary || '';

  // 2026-09-29 (recommendation 4): a comparison whose words contradict its
  // numbers is FLAGGED here and left as written (lib-comparisons.js says why).
  const comparisonFlags = findContradictions(report);
  if (comparisonFlags.length) {
    console.log('COMPARISON_CHECK [render] flagged=' + comparisonFlags.length + ' restaurant=' + JSON.stringify(restaurant)
      + ' ' + comparisonFlags.map((f) => f.path + ':' + f.kind).join(','));
  }

  // THE REWRITTEN EXECUTIVE SUMMARY DISCLOSES ITSELF.
  //
  // 73 stored payloads had their summary replaced on 2026-09-23: 114 blocking
  // band contradictions across 66 rows, plus eight that agreed with their band
  // but ran long. The originals are kept forever in
  // meta.executiveSummaryOriginal.
  //
  // This page renders at READ time, so a customer reopening an older link gets
  // prose they were never sent. Same failure as the v8.11.50 method
  // disclosure, one layer up: a paragraph that changes under a reader with no
  // explanation is worse than either paragraph.
  //
  // THE DATE COMES FROM THE PAYLOAD AND IS NEVER MANUFACTURED. An unparseable
  // timestamp still discloses the rewrite, without a date, because the rewrite
  // happened either way and "Invalid Date" must never reach a customer.
  const replacedAt = report?.meta?.executiveSummaryReplacedAt;
  const replacedDay = (() => {
    if (!replacedAt) return null;
    const t = Date.parse(replacedAt);
    return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
  })();
  const summaryRevisedNote = replacedAt
    ? 'The executive summary on this page was rewritten'
      + (replacedDay ? ' on ' + replacedDay : '')
      + ' to agree with the computed overall score. The wording first issued '
      + 'with this report is retained in our records.'
    : '';
  const cuisine    = report?.cuisineDetected || '';
  const price      = report?.priceDetected || '';
  const location   = subscriber.location || '';

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // The same cutoffs the pillar tiles use, which is now also the band table:
  // green 65 and up, amber 45 to 64, red below 45. They agree because the
  // overall is the mean of those tiles and lives on their scale.
  const scoreColor = !hasScore ? '#6b7280'
    : score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24';

  // Circular score gauge SVG (matches survey's dialSVG)
  const r = 48, cx = 56, cy = 56;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(100, hasScore ? score : 0)) / 100);
  const gaugeSvg = !hasScore ? '' : `<svg viewBox="0 0 112 112" width="112" height="112" aria-hidden="true" style="display:block">
    <defs>
      <filter id="scoreShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.35"/>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${scoreColor}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy+2}" text-anchor="middle" dominant-baseline="middle"
      font-family="League Spartan, Arial, sans-serif" font-weight="900" font-size="30" fill="#ffffff" filter="url(#scoreShadow)">${score}</text>
    <text x="${cx}" y="${cy+22}" text-anchor="middle" dominant-baseline="middle"
      font-family="League Spartan, Arial, sans-serif" font-weight="700" font-size="9" letter-spacing="1.5" fill="#ffffff" opacity="0.85">/ 100</text>
  </svg>`;

  // Pillars — score-bar rows like survey's .sc-row
  const pillars = Object.values(report?.pillars || {});
  const statusColor = (s) => s === 'good' ? '#00A651' : s === 'bad' ? '#ED1C24' : '#F7941D';
  const pillarRows = pillars.map(p => {
    const c = statusColor(p.status);
    const pct = Math.max(0, Math.min(100, p.score || 0));
    return `<div class="sc-row">
      <div class="sc-label">${esc(p.label)}</div>
      <div class="sc-bar"><div class="sc-fill" style="width:${pct}%;background:${c}"></div></div>
      <div class="sc-num" style="color:${c}">${p.score}</div>
    </div>`;
  }).join('');

  // Strengths / risks
  const strengths = (report?.strengths || []).map(s =>
    `<li>${esc(s)}</li>`).join('');
  const risks = (report?.risks || []).map(rr =>
    `<li>${esc(rr)}</li>`).join('');

  // Themes as tag pills
  const tagClass = (kind) => kind === 'positive' ? 'tag-pos' : kind === 'negative' ? 'tag-neg' : 'tag-neu';
  const themeBlock = (label, items, kind) => {
    if (!items || !items.length) return '';
    const chips = items.map(t => `<span class="tag ${tagClass(kind)}">${esc(t)}</span>`).join('');
    return `<div class="theme-row"><div class="theme-label">${label}</div><div class="theme-chips">${chips}</div></div>`;
  };
  const themes = report?.themes || {};
  const themesHtml = themeBlock('Positive', themes.positive, 'positive')
                   + themeBlock('Negative', themes.negative, 'negative')
                   + themeBlock('Neutral',  themes.neutral,  'neutral');

  // Review verbatims
  const verbatims = (report?.reviewVerbatims || []).map(rv => {
    const kind = rv.sentiment === 'positive' ? 'pos' : rv.sentiment === 'negative' ? 'neg' : 'neu';
    const stars = (rv.stars && rv.stars > 0) ? '★'.repeat(rv.stars) + '☆'.repeat(5 - rv.stars) : '';
    return `<div class="qblock qblock-${kind}">
      <div class="qtext">&ldquo;${esc(rv.text)}&rdquo;</div>
      <div class="qmeta">
        ${esc(rv.source || '')}
        ${stars ? '<span class="qstars">' + stars + '</span>' : ''}
        ${rv.sentiment ? '<span class="tag ' + tagClass(rv.sentiment) + '" style="margin-left:6px">' + esc(rv.sentiment) + '</span>' : ''}
      </div>
    </div>`;
  }).join('');

  // Competitors — DESCRIPTIVE CARDS, NOT A COMPARISON SET.
  //
  // THE GRID WAS DISSOLVED RATHER THAN RE-SCALED, AND THE REASON IS A
  // MEASUREMENT. Until v8.11.5 this rendered the subject at NN/100 beside peers
  // at N.N / 5 ★ in one six-card grid, with a comment arguing the scale suffix
  // made that safe. It did not: putting two quantities in one grid IS the claim
  // that they rank against each other, and a reader takes position from
  // adjacency whatever the labels say.
  //
  // The obvious repair, giving peers their assessed DiagnostiX score so the grid
  // is single-scale, IS WORSE, and this is the part to read before putting a
  // comparison back here. Measured across the 132 stored RVP benchmark rows on
  // 2026-09-04, the pipeline against ITSELF: Bocanáriz spans 65 to 88 over 19
  // assessments, La Lonchera 38 to 58 over 17, and La Mesa, an actual peer on
  // the Segreta report, scores 62, 62 and 72. A grid reading "Segreta 82,
  // La Mesa 62" would publish a 20 point lead of which 10 is the instrument.
  //
  // Analytics already solved this and its solution is the one in this report.
  // `lib/render.js` compares BY BAND, not by raw score, on bands 16 points wide
  // because 16 is the worst measured run-to-run spread; it fixed raw > and < on
  // 2026-09-03 after a peer scoring 71 against a subject's 72 was reported as
  // below. Re-creating the raw comparison here would reintroduce a defect that
  // service has already fixed, one layer up, wearing the costume of a feature.
  //
  // So: ONE comparison, in ONE place, on ONE scale, and it is the peer band
  // table rendered directly below this block. These cards say WHO the
  // competitors are and HOW THEY LOOK PUBLICLY. They carry no subject card and
  // no ranking claim, which is why there is nothing here for a star rating to be
  // mismatched against.
  //
  // Star ratings stay because they are real, sourced, and for a peer with no
  // assessment they are the only public signal there is. What changed is that
  // they are no longer sitting next to a composite pretending to be its rival.
  //
  // ── The legacy `score` field, and why it is NOT one thing ──
  // Reports written before 2026-05-24 carry {name, score, note}. Measured across
  // all 80 stored legacy entries: 70 are 61 to 98, genuine 0-100 composites, and
  // 10 are 4.1, 4.6, 4.8, 4.9, which are STAR RATINGS the model put in the wrong
  // field. Both readings are correct for their own rows, so the field is split by
  // magnitude rather than coerced. The removed branch divided a composite by 20
  // and printed it as stars, which is a number presented as a measurement of
  // something it never measured.

  const competitorList = Array.isArray(report?.competitors) ? report.competitors : [];

  // A star rating, 0-5, or null. c.rating is the current schema. c.score at or
  // below 5 is the legacy field carrying a star rating, which is what those ten
  // rows are. NO /20 CONVERSION: see above.
  function interpretCompetitorRating(c) {
    if (typeof c?.rating === 'number' && isFinite(c.rating) && c.rating >= 0 && c.rating <= 5) {
      return c.rating;
    }
    if (typeof c?.score === 'number' && isFinite(c.score) && c.score > 0 && c.score <= 5) {
      return c.score;
    }
    // Strings like "4.5★" or "4.5 stars" from a model that ignored the type.
    const s = typeof c?.rating === 'string' ? c.rating : typeof c?.score === 'string' ? c.score : null;
    const m = s ? s.match(/([0-5](?:\.\d)?)/) : null;
    return m ? parseFloat(m[1]) : null;
  }

  // A legacy 0-100 composite, or null. Only ever from the old `score` field, and
  // only above 5, so it cannot swallow the ten star-rating rows above.
  function interpretLegacyScore(c) {
    if (typeof c?.score === 'number' && isFinite(c.score) && c.score > 5 && c.score <= 100) {
      return Math.round(c.score);
    }
    return null;
  }

  function interpretReviewCount(c) {
    if (typeof c?.reviewCount === 'number' && isFinite(c.reviewCount)) return Math.round(c.reviewCount);
    if (typeof c?.reviews === 'number' && isFinite(c.reviews)) return Math.round(c.reviews);
    const s = c?.reviewCount || c?.reviews;
    if (typeof s === 'string') {
      const m = s.replace(/,/g, '').match(/(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // Filter out any competitor whose name matches the focal restaurant. The model
  // is told not to include it and sometimes does anyway.
  const focalNameLower = String(restaurant || '').trim().toLowerCase();
  const peers = competitorList.filter(c => {
    const peerName = String(c?.name || '').trim().toLowerCase();
    return peerName && peerName !== focalNameLower;
  });

  const competitors = peers.slice(0, 5).map(c => {
    const ratingRaw = interpretCompetitorRating(c);
    const legacyScore = ratingRaw === null ? interpretLegacyScore(c) : null;
    const reviewCount = interpretReviewCount(c);

    let bigBlock, metricLabel;
    if (ratingRaw !== null) {
      const ratingColor = ratingRaw >= 4.5 ? '#00A651' : ratingRaw >= 4.0 ? '#F7941D' : '#ED1C24';
      bigBlock = `<div class="comp-big" style="color:${ratingColor}">${ratingRaw.toFixed(1)}<span class="comp-big-scale"> / 5 ★</span></div>`;
      metricLabel = reviewCount !== null
        ? (reviewCount >= 1000 ? (reviewCount / 1000).toFixed(1) + 'k' : String(reviewCount)) + ' public reviews'
        : 'Public rating';
    } else if (legacyScore !== null) {
      // Shown as itself rather than converted or discarded. The label says which
      // method produced it, because this number is not comparable with a score
      // from the current pipeline.
      bigBlock = `<div class="comp-big">${legacyScore}<span class="comp-big-scale">/100</span></div>`;
      metricLabel = 'Scored by an earlier method';
    } else {
      // The card still shows no number, but the LABEL now says which of the
      // states it is, so "no reviews yet" reads as a fact about that business
      // rather than as our search failing. See RATING_STATE above.
      bigBlock = '<div class="comp-no-rating">No public rating</div>';
      metricLabel = ratingStateCopy(c);
    }

    return `<div class="comp-card">
      <div class="comp-name">${esc(c.name || 'Unknown')}</div>
      ${bigBlock}
      <div class="comp-metric-label">${esc(metricLabel)}</div>
      <div class="comp-note">${esc(c.note || '')}</div>
    </div>`;
  }).join('');

  // Online presence channels
  const onlineChannels = (report?.onlinePresence?.channels || []).map(c => {
    const cColor = c.score >= 65 ? '#00A651' : c.score >= 45 ? '#F7941D' : '#ED1C24';
    const pct = Math.max(0, Math.min(100, c.score || 0));
    return `<div class="pres-row">
      <div class="pres-name">${esc(c.name)}</div>
      <div class="pres-bar"><div class="pres-fill" style="width:${pct}%;background:${cColor}"></div></div>
      <div class="pres-num" style="color:${cColor}">${c.score}</div>
    </div>`;
  }).join('');
  const onlineOverall = report?.onlinePresence?.overall;

  // Actions grouped by priority
  const priorityLabel = { urgent: 'Urgent', '30days': 'Next 30 Days', ongoing: 'Ongoing' };
  const priorityClass = { urgent: 'pri-hi', '30days': 'pri-med', ongoing: 'pri-lo' };
  const actionsByPriority = {};
  (report?.actions || []).forEach(a => {
    const p = a.priority || 'ongoing';
    if (!actionsByPriority[p]) actionsByPriority[p] = [];
    actionsByPriority[p].push(a);
  });
  let actionNum = 0;
  const actionsHtml = ['urgent', '30days', 'ongoing']
    .filter(p => actionsByPriority[p])
    .map(p => {
      const items = actionsByPriority[p].map(a => {
        actionNum++;
        return `<div class="act">
          <div class="act-num">${String(actionNum).padStart(2,'0')}</div>
          <div class="act-body">
            <div class="act-head">
              <div class="act-title">${esc(a.title)}</div>
              <span class="act-pri ${priorityClass[p]}">${priorityLabel[p]}</span>
            </div>
            <div class="act-desc">${esc(a.desc)}</div>
          </div>
        </div>`;
      }).join('');
      return items;
    }).join('');

  // Owner perception vs reality
  const ownerSummary = report?.ownerSentimentSummary || '';
  const sentimentGap = report?.sentimentGap || '';
  const ownerBlock = (ownerSummary || sentimentGap) ? `
    <h2 class="rpt-h">Reviewer perception vs reality</h2>
    ${ownerSummary ? '<p class="body-p">' + esc(ownerSummary) + '</p>' : ''}
    ${sentimentGap ? '<div class="gap-block"><div class="gap-label">Gap to close</div><div class="gap-text">' + esc(sentimentGap) + '</div></div>' : ''}
  ` : '';

  // Business reality block — financial metrics + pillar pairings + AI's analysis.
  // Renders only when at least one financial metric is present.
  // Color bands: red when worse than -5%, amber -5% to 0%, green >= 0%. Profitability widens slightly.
  // Source precedence: survey.businessMetrics first (when passed), then subscriber
  // snake_case (Supabase row), then subscriber camelCase (in-memory).
  // NOTE: when called from /report viewer endpoint, `survey` is not in scope —
  // typeof check below handles that gracefully without throwing ReferenceError.
  const surveyBMC = (typeof survey !== 'undefined' && survey && survey.businessMetrics) || {};
  const pickBMC = (surveyKey, snakeKey, camelKey) => {
    if (typeof surveyBMC[surveyKey] === 'number') return surveyBMC[surveyKey];
    if (typeof subscriber[snakeKey] === 'number') return subscriber[snakeKey];
    if (typeof subscriber[camelKey] === 'number') return subscriber[camelKey];
    return null;
  };
  const guestChg  = pickBMC('guestCountChange',    'guest_count_change',   'guestCountChange');
  const checkChg  = pickBMC('avgCheckChange',      'avg_check_change',     'avgCheckChange');
  const profitChg = pickBMC('profitabilityChange', 'profitability_change', 'profitabilityChange');
  const hasAnyBM = guestChg !== null || checkChg !== null || profitChg !== null;
  const businessAnalysis = report?.businessRealityAnalysis || '';
  const perceptionGap    = report?.perceptionGap || '';

  const bandColor = (v, redAt, amberAt) => {
    if (v === null) return '#999';
    if (v <= redAt) return 'var(--red)';
    if (v < amberAt) return 'var(--amber)';
    return 'var(--green)';
  };
  const metricChip = (v, label, redAt, amberAt) => {
    if (v === null) return `
      <div style="flex:1;min-width:170px;background:#f7f5f0;border-radius:8px;padding:12px 14px;border:1px solid #e8e3d8">
        <div style="font-size:10.5px;letter-spacing:1.5px;color:#999;text-transform:uppercase;font-weight:700;margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:18px;font-weight:700;color:#bbb">Not tracked</div>
      </div>`;
    const color = bandColor(v, redAt, amberAt);
    const sign = v >= 0 ? '+' : '';
    return `
      <div style="flex:1;min-width:170px;background:#f7f5f0;border-radius:8px;padding:12px 14px;border-left:4px solid ${color}">
        <div style="font-size:10.5px;letter-spacing:1.5px;color:#666;text-transform:uppercase;font-weight:700;margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:24px;font-weight:900;color:${color};font-family:'League Spartan',Arial,sans-serif">${sign}${v}%</div>
        <div style="font-size:11px;color:#888;margin-top:2px">vs same time last year</div>
      </div>`;
  };

  // Pillar pairing mini-grid — pairs each financial metric with the qualitative pillar
  // most relevant to it. Helps operators see at a glance whether perception matches reality.
  // Pairing logic (justified in the prompt):
  //   Guest count       ↔ Customer Sentiment (cs)
  //   Average check     ↔ Pricing & Accessibility (pa)
  //   Profitability     ↔ Brand Experience & Growth (bg)
  const pp = report?.pillars || {};
  const pillarColor = (s) => s === 'good' ? 'var(--green)' : s === 'bad' ? 'var(--red)' : 'var(--amber)';
  const pillarPairRow = (metricVal, metricLabel, metricRedAt, metricAmberAt, pillarObj, gapNarrative) => {
    if (metricVal === null) return ''; // skip if metric not tracked
    if (!pillarObj || typeof pillarObj.score !== 'number') return '';
    const mColor = bandColor(metricVal, metricRedAt, metricAmberAt);
    const pColor = pillarColor(pillarObj.status);
    const sign = metricVal >= 0 ? '+' : '';
    return `
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:18px;align-items:center;background:#f7f5f0;padding:14px 18px;margin:8px 0;border-radius:8px">
        <div style="text-align:left">
          <div style="font-size:10px;letter-spacing:1.5px;color:#666;text-transform:uppercase;font-weight:700;margin-bottom:4px">${esc(metricLabel)}</div>
          <div style="font-size:22px;font-weight:900;color:${mColor};font-family:'League Spartan',Arial,sans-serif;line-height:1">${sign}${metricVal}%</div>
        </div>
        <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">vs</div>
        <div style="text-align:right">
          <div style="font-size:10px;letter-spacing:1.5px;color:#666;text-transform:uppercase;font-weight:700;margin-bottom:4px">${esc(pillarObj.label || '')}</div>
          <div style="font-size:22px;font-weight:900;color:${pColor};font-family:'League Spartan',Arial,sans-serif;line-height:1">${pillarObj.score}<span style="font-size:13px;color:#999;font-weight:500">/100</span></div>
        </div>
        ${gapNarrative ? '<div style="grid-column:1/-1;font-size:13px;color:#333;line-height:1.6;padding-top:8px;border-top:1px solid #e8e3d8">' + esc(gapNarrative) + '</div>' : ''}
      </div>`;
  };

  // AI provides pillarGapNarratives — one short sentence per pairing explaining the gap
  const pgn = report?.pillarGapNarratives || {};
  const pillarPairings = hasAnyBM ? [
    pillarPairRow(guestChg,  'Guest Count',   -10, 0, pp.cs, pgn.guest),
    pillarPairRow(checkChg,  'Average Check', -3,  0, pp.pa, pgn.check),
    pillarPairRow(profitChg, 'Profitability', -5,  0, pp.bg, pgn.profit)
  ].filter(Boolean).join('') : '';

  const businessRealityBlock = hasAnyBM ? `
    <h2 class="rpt-h">Financial Reality vs Operational Reality</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">
      ${metricChip(guestChg,  'Guest Count',     -10, 0)}
      ${metricChip(checkChg,  'Average Check',   -3,  0)}
      ${metricChip(profitChg, 'Profitability',   -5,  0)}
    </div>
    ${businessAnalysis ? '<p class="body-p" style="margin:8px 0 16px">' + esc(businessAnalysis) + '</p>' : ''}
    ${pillarPairings ? '<div style="margin:14px 0 10px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#666;font-weight:700">Where your numbers and your self-assessment meet</div>' + pillarPairings : ''}
    ${perceptionGap ? '<div class="gap-block" style="background:#fff8ec;border-left:4px solid var(--amber);margin-top:14px"><div class="gap-label" style="color:#a85d00">Perception vs reality</div><div class="gap-text">' + esc(perceptionGap) + '</div></div>' : ''}
  ` : '';

  // Commercial recommendations block — distinct from operational actions.
  // Renders only when AI produced commercialActions AND at least one financial metric was provided.
  const commercialActions = Array.isArray(report?.commercialActions) ? report.commercialActions : [];
  const commercialActionsBlock = (hasAnyBM && commercialActions.length) ? `
    <h2 class="rpt-h">Commercial Recommendations</h2>
    <p class="body-p" style="margin:0 0 14px;color:#666;font-size:13px">Actions tied directly to your financial reality. These complement, and do not replace, the operational actions below.</p>
    ${commercialActions.slice(0, 3).map((a, idx) => {
      const evidence = a.evidence || '';
      return `
        <div style="background:#f7f5f0;border-left:3px solid var(--magenta);padding:18px 22px;margin:10px 0;border-radius:0 8px 8px 0">
          <div style="display:flex;align-items:flex-start;gap:14px">
            <div style="font-family:'League Spartan',Arial,sans-serif;font-weight:900;font-size:24px;color:var(--magenta);line-height:1;min-width:32px">C${idx + 1}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:900;font-size:14px;color:var(--navy);letter-spacing:.3px;margin-bottom:6px">${esc(a.title || '')}</div>
              <div style="font-size:13.5px;line-height:1.65;color:#444;margin-bottom:8px">${esc(a.desc || '')}</div>
              ${evidence ? '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--magenta);font-weight:700;background:#fbf2fa;padding:6px 10px;border-radius:4px;display:inline-block">Tied to: ' + esc(evidence) + '</div>' : ''}
            </div>
          </div>
        </div>`;
    }).join('')}
  ` : '';

  const metaParts = [cuisine, price, location, reportLabel].filter(Boolean);
  const metaRow = metaParts.map(esc).join(' &nbsp;·&nbsp; ');

  // 2026-09-29 (recommendation 1): the viewport tag. Without it a phone laid
  // the report out at 980 px and shrank it, and the @media (max-width:680px)
  // rules below never fired (B3, Orchid 94a649d8).
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(restaurant)}, DiagnostiX Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=League+Spartan:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
:root{
  --navy:#1B1464;
  --navy2:#2E3192;
  --magenta:#92278F;
  --blue:#0072BC;
  --grad:linear-gradient(135deg,#92278F,#2E3192,#1B1464);
  --grad-h:linear-gradient(90deg,#92278F,#0072BC);
  --gold:#0072BC;
  --green:#00A651;
  --amber:#F7941D;
  --red:#ED1C24;
  --sur-bg:#F5F4FC;
  --card-bg:#ffffff;
  --soft-bg:#f7f5f0;
  --warn-bg:#fff8ec;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:'League Spartan',-apple-system,Segoe UI,Arial,sans-serif;
  background:var(--sur-bg);
  color:var(--navy);
  font-weight:400;
  -webkit-font-smoothing:antialiased;
  line-height:1.6;
}

/* Print bar (sticky purple gradient header, hides on print) */
.print-bar{
  position:sticky;top:0;z-index:50;
  background:var(--grad);
  padding:14px 24px;
  display:flex;align-items:center;justify-content:space-between;gap:16px;
  box-shadow:0 2px 12px rgba(27,20,100,.18);
}
.print-bar-brand{
  font-family:'League Spartan',Arial,sans-serif;
  color:#fff;font-weight:900;font-size:18px;letter-spacing:1px;line-height:1;
}
.print-bar-brand .x{color:var(--blue)}
.print-bar-sub{
  font-size:9.5px;letter-spacing:2.5px;color:rgba(255,255,255,.75);
  text-transform:uppercase;font-weight:500;margin-top:3px;
}
.print-btn{
  background:#fff;color:var(--navy);
  font-family:'League Spartan',Arial,sans-serif;
  font-weight:900;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;
  border:none;border-radius:8px;padding:11px 20px;cursor:pointer;
  transition:transform .15s ease, box-shadow .15s ease;
}
.print-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.15)}

.wrap{max-width:880px;margin:0 auto;padding:0}

/* Cover (purple gradient header card) */
.rpt-cover{
  background:var(--grad);
  color:#fff;
  padding:36px 40px 32px;
  margin:24px 24px 0;
  border-radius:14px 14px 0 0;
  position:relative;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.cover-grid{
  display:grid;grid-template-columns:1fr auto;gap:32px;align-items:center;
}
.cover-left{min-width:0}
.cover-logo{
  font-family:'League Spartan',Arial,sans-serif;
  font-weight:900;font-size:22px;letter-spacing:1px;color:#fff;line-height:1;
}
.cover-logo .x{color:var(--blue)}
.cover-tag{
  font-size:10px;letter-spacing:2.5px;color:rgba(255,255,255,.75);
  text-transform:uppercase;font-weight:500;margin-top:5px;
}
.cover-sub{
  font-size:10px;letter-spacing:3px;color:rgba(255,255,255,.7);
  text-transform:uppercase;font-weight:700;margin-top:26px;
}
.cover-title{
  font-size:30px;font-weight:900;line-height:1.18;margin-top:6px;color:#fff;
  letter-spacing:-0.3px;
}
.cover-meta{
  font-size:12px;color:rgba(255,255,255,.85);margin-top:12px;letter-spacing:.5px;
}
.cover-meta strong{color:var(--blue);font-weight:700}

/* Gradient divider line */
.grad-line{
  height:4px;
  background:var(--grad-h);
  margin:0 24px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}

/* Body card */
.body-card{
  background:var(--card-bg);
  margin:0 24px 24px;
  padding:32px 40px 40px;
  border-radius:0 0 14px 14px;
  box-shadow:0 4px 24px rgba(27,20,100,.06);
}

/* Section headers (match survey .rpt-h) */
.rpt-h{
  font-family:'League Spartan',Arial,sans-serif;
  font-size:14px;font-weight:900;
  text-transform:uppercase;letter-spacing:2px;
  color:var(--navy);
  margin:36px 0 16px;
  padding-bottom:10px;
  border-bottom:2px solid var(--navy2);
}
.rpt-h:first-child{margin-top:0}

/* Executive summary */
.exec-box{
  background:var(--soft-bg);
  border-left:3px solid ${scoreColor};
  padding:18px 22px;
  font-size:14px;line-height:1.75;color:#333;
  border-radius:0 6px 6px 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}

/* ALL-1: evidence base panel. auto-fit rather than a fixed column count so a
   report with three counts does not leave a hole where the fourth would be,
   and break-inside:avoid so the panel is never split across a printed page. */
.ev-panel{
  border:1px solid #e3e1ea;border-radius:8px;padding:18px 20px;
  background:#fbfbfd;break-inside:avoid;page-break-inside:avoid;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.ev-grid{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
  gap:14px 10px;
}
.ev-cell{text-align:center}
.ev-n{font-size:22px;font-weight:800;color:#1B1464;line-height:1.2;font-variant-numeric:tabular-nums}
.ev-l{font-size:10px;letter-spacing:0.07em;text-transform:uppercase;color:#6b6880;margin-top:4px}
.ev-s{margin:14px 0 0;font-size:12.5px;line-height:1.65;color:#555;border-top:1px solid #ecebf1;padding-top:12px}
@media print{ .ev-panel{border-color:#ccc;background:#fafafa} }
.cov-note{
  border-left:3px solid #C17D11;background:#fdf8ee;padding:12px 16px;margin:0 0 18px;
  font-size:12.5px;line-height:1.6;color:#4a4a4a;break-inside:avoid;page-break-inside:avoid;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.cov-k{font-weight:700;color:#8a5a00}

.body-p{font-size:14px;line-height:1.7;color:#333;margin:10px 0}

/* Pillar score rows */
.sc-row{
  display:flex;align-items:center;gap:14px;margin:10px 0;
}.cover-verdict{text-align:center;font-size:10px;letter-spacing:2.5px;
  color:rgba(255,255,255,.85);text-transform:uppercase;font-weight:700;margin-top:8px}
.cover-noscore{max-width:260px;font-size:12px;line-height:1.55;
  color:rgba(255,255,255,.88)}
/* The arithmetic, printed where the numbers it uses are printed. Small, but
   never grey on white: a reader who wants to check the total has to be able
   to read it. */
.score-formula{margin:10px 0 4px;font-size:12px;line-height:1.6;color:#44506a;
  background:#f4f7fa;border-left:3px solid #6b7280;padding:9px 12px;border-radius:4px}

.sc-label{
  width:200px;flex-shrink:0;
  font-size:13px;font-weight:700;color:var(--navy);
  letter-spacing:.3px;
}
.sc-bar{
  flex:1;height:10px;background:#ede9e2;border-radius:5px;overflow:hidden;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.sc-fill{
  height:100%;border-radius:5px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.sc-num{
  width:42px;text-align:right;font-weight:900;font-size:18px;
  font-family:'League Spartan',Arial,sans-serif;
}

/* Two-column strengths/risks */
.col-2{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:8px}
@media (max-width:680px){.col-2{grid-template-columns:1fr;gap:8px}}
.col-h{
  font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:2px;
  margin:0 0 10px;
}
.col-h.pos{color:var(--green)}
.col-h.neg{color:var(--red)}
ul.bullet-list{padding-left:18px;margin:0;font-size:13.5px;line-height:1.7;color:#333}
ul.bullet-list li{margin:4px 0}

/* Theme rows */
.theme-row{margin:12px 0;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.theme-label{
  font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:2px;
  color:var(--navy);min-width:70px;padding-top:5px;
}
.theme-chips{flex:1}

/* Tag pills */
.tag{
  display:inline-block;font-size:11px;font-weight:700;
  padding:5px 11px;border-radius:12px;margin:3px 5px 3px 0;
  letter-spacing:.3px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.tag-pos{background:#E6F8EE;color:#005C2E}
.tag-neg{background:#FDECEA;color:#8B0000}
.tag-neu{background:#FEF3E2;color:#7A4500}

/* Verbatim quotes */
.qblock{
  background:#fafaf8;
  padding:14px 18px;
  margin:12px 0;
  border-radius:0 6px 6px 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.qblock-pos{border-left:3px solid var(--green)}
.qblock-neg{border-left:3px solid var(--red)}
.qblock-neu{border-left:3px solid var(--amber)}
.qtext{font-style:italic;font-size:14px;line-height:1.65;color:#222}
.qmeta{
  font-size:11px;color:#888;margin-top:8px;
  text-transform:uppercase;letter-spacing:1px;font-weight:600;
}
.qstars{color:#F7941D;margin-left:6px;letter-spacing:1px;font-size:12px}

/* Competitor grid */
.comp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:8px}
/* Peer comparison fragment, produced by Analytics. It carries that service's
   class names and no CSS, so the scoping lives here. Analytics owns the
   escaping and the dash rule; this page owns how it looks. */
.peer-cmp h2{font-size:1.15rem;margin:26px 0 4px;letter-spacing:.5px}
.peer-cmp .section-divider{width:40px;height:3px;background:#C97E36;margin-bottom:12px}
.peer-cmp .sub{color:#3A4255;font-size:.9rem;margin:0 0 14px}
.peer-cmp table.report{width:100%;border-collapse:collapse;font-size:.9rem;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 1px 3px rgba(15,21,53,.06)}
.peer-cmp table.report th{background:#0E3D2E;color:#fff;padding:9px 11px;text-align:left;font-size:.72rem;letter-spacing:1px;text-transform:uppercase}
.peer-cmp table.report th.num,.peer-cmp table.report td.num{text-align:right}
.peer-cmp table.report td{padding:9px 11px;border-bottom:1px solid #EDEFF4;vertical-align:top}
.peer-cmp table.report tr:last-child td{border-bottom:0}
.peer-cmp td.subject{font-weight:600}
.peer-cmp .muted{color:#8A93A6;font-size:.86rem;font-style:italic}
.peer-cmp .absent{color:#8A93A6;font-style:italic}
.peer-cmp .callout{background:#F7F8FA;border-left:4px solid #C97E36;padding:14px 18px;border-radius:5px}
.peer-cmp .callout h3{font-size:.9rem;color:#C97E36;text-transform:uppercase;letter-spacing:1.2px;margin:0 0 8px}
.peer-cmp .callout p{color:#3A4255;font-size:.88rem;line-height:1.55;margin:0}
/* 2026-09-29: on a phone the fragment's fixed inline column widths (80, 190
   and three of 90 px, lib/render.js in Analytics) made the table 422 px and
   the page scroll sideways. They are released here, where the look lives; the
   fragment is stored frozen HTML, so the fix cannot be in Analytics. SCREEN
   only: A4 print content is 679 px wide, so a bare max-width:680px rule would
   also fire on paper. */
@media screen and (max-width:680px){
  .peer-cmp table.report th,.peer-cmp table.report td{width:auto !important;padding:7px 5px}
  .peer-cmp table.report th{letter-spacing:0;font-size:.62rem}
  .peer-cmp table.report{font-size:.82rem}
  .peer-cmp .muted{display:block}
}
@media (max-width:680px){.comp-grid{grid-template-columns:1fr}}
.comp-card{
  background:var(--soft-bg);
  border-top:3px solid var(--amber);
  padding:16px 18px;
  border-radius:0 0 6px 6px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.comp-name{font-weight:900;font-size:14px;color:var(--navy);letter-spacing:.3px}
.comp-note{font-size:12px;color:#555;line-height:1.55}
.comp-no-rating{display:inline-block;font-size:10px;color:#999;background:#ede9e2;padding:5px 9px;border-radius:3px;margin-bottom:6px;letter-spacing:0.04em;font-weight:600;text-transform:uppercase}
.comp-grid-note{font-size:11.5px;color:#777;line-height:1.6;margin:10px 0 0;font-style:italic}
/* The one number on a competitor card. There is no subject card beside it, so
   this is a description of that business and not one half of a comparison. */
.comp-big{
  font-family:'League Spartan',Arial,sans-serif;
  font-size:30px;font-weight:900;color:var(--navy);
  line-height:1;margin:8px 0 6px;
  letter-spacing:-0.5px;
}
.comp-big-scale{
  font-size:13px;color:#999;font-weight:500;margin-left:3px;letter-spacing:0;
}
.comp-metric-label{
  font-size:10px;letter-spacing:1.5px;color:#666;
  text-transform:uppercase;font-weight:700;margin-bottom:8px;
}

/* Online presence */
.pres-row{display:flex;align-items:center;gap:14px;margin:8px 0}
.pres-name{
  width:160px;flex-shrink:0;
  font-size:13px;font-weight:700;color:var(--navy);
}
.pres-bar{
  flex:1;height:8px;background:#ede9e2;border-radius:4px;overflow:hidden;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.pres-fill{
  height:100%;border-radius:4px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.pres-num{
  width:36px;text-align:right;font-weight:900;font-size:15px;
  font-family:'League Spartan',Arial,sans-serif;
}
.pres-overall{
  font-size:12px;color:#666;font-weight:600;margin-left:10px;
  letter-spacing:1px;text-transform:uppercase;
}

/* Owner gap callout */
.gap-block{
  background:var(--warn-bg);
  border:1px solid #f5d78a;
  padding:14px 18px;
  margin-top:14px;
  border-radius:6px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.gap-label{
  font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:2px;
  color:var(--amber);margin-bottom:6px;
}
.gap-text{font-size:13.5px;line-height:1.65;color:#333}

/* Actions */
.act{
  display:flex;gap:16px;align-items:flex-start;
  background:var(--soft-bg);
  border-left:3px solid var(--gold);
  padding:16px 20px;
  margin:10px 0;
  border-radius:0 6px 6px 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.act-num{
  font-family:'League Spartan',Arial,sans-serif;
  font-weight:900;font-size:28px;color:var(--gold);
  line-height:1;min-width:38px;
}
.act-body{flex:1;min-width:0}
.act-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.act-title{font-weight:900;font-size:14px;color:var(--navy);letter-spacing:.3px}
.act-pri{
  font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:1.5px;
  padding:3px 9px;border-radius:10px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.pri-hi{background:#FDECEA;color:#8B0000}
.pri-med{background:#FEF3E2;color:#7A4500}
.pri-lo{background:#E6F8EE;color:#005C2E}
.act-desc{font-size:13.5px;line-height:1.65;color:#444}

/* Footer */
.rpt-footer{
  text-align:center;font-size:11px;color:#888;padding:24px;
  letter-spacing:1px;
}
.rpt-footer-brand{
  font-weight:900;color:var(--navy);letter-spacing:1.5px;text-transform:uppercase;font-size:10px;
}
.rpt-footer-sub{margin-top:4px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#999}
.rpt-footer-priv{margin-top:10px;color:#aaa;letter-spacing:.5px;text-transform:none}

/* Responsive cover */
@media (max-width:680px){
  .cover-grid{grid-template-columns:1fr;gap:20px}
  .rpt-cover{padding:28px 24px 24px}
  .body-card{padding:24px 22px 32px}
  .cover-title{font-size:24px}
  .sc-label{width:140px;font-size:12px}
  .pres-name{width:110px;font-size:12px}
}

/* PRINT, clean PDF output */
@media print{
  body{background:#fff !important}
  .print-bar{display:none !important}
  .wrap{max-width:none}
  .rpt-cover,.body-card{margin:0;border-radius:0;box-shadow:none}
  .rpt-cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .grad-line{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .exec-box,.gap-block,.qblock,.comp-card,.act,.tag,.act-pri,
  .sc-bar,.sc-fill,.pres-bar,.pres-fill{
    -webkit-print-color-adjust:exact;print-color-adjust:exact;
  }
  @page{margin:0.6in}
  .rpt-h{page-break-after:avoid}
  /* v8.11.52: .exec-box JOINS THE LIST.
     The executive summary was the only display block on the page that could
     split across a page break. The coloured left stripe restarted on the next
     page and the background band was cut in half. Measured in real Chrome at
     both Letter and A4 on 2026-09-23; its computed page-break-inside was
     'auto' while every other block here was 'avoid'.
     THE RULE CANNOT SAVE A BOX TALLER THAN A PAGE. At 338 words on Letter the
     box exceeds the page itself and must split whatever this says. It fixes
     the case that actually occurs: a box too tall for the space remaining. */
  .exec-box,.act,.comp-card,.qblock{page-break-inside:avoid}
  .col-2{page-break-inside:avoid}
}
</style></head><body>

<!-- Sticky print bar (hidden on print) -->
<div class="print-bar">
  <div>
    <div class="print-bar-brand">diagnosti<span class="x">X</span></div>
    <div class="print-bar-sub">Restaurant HealthCheck · by 4xi</div>
  </div>
  <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
</div>

<div class="wrap">

  <!-- Purple gradient cover -->
  <div class="rpt-cover">
    <div class="cover-grid">
      <div class="cover-left">
        <div class="cover-logo">diagnosti<span class="x">X</span></div>
        <div class="cover-tag">Restaurant HealthCheck · by 4xi</div>
        <div class="cover-sub">${esc(reportLabel)}</div>
        <div class="cover-title">${esc(restaurant)}</div>
        ${metaRow ? '<div class="cover-meta">' + metaRow + '</div>' : ''}
      </div>
      <div>${hasScore
        ? gaugeSvg + '<div class="cover-verdict">' + esc(verdict) + '</div>'
        : '<div class="cover-noscore">' + esc(NO_SCORE_SENTENCE) + '</div>'}</div>
    </div>
  </div>

  <div class="grad-line"></div>

  <!-- White body card -->
  <div class="body-card">

    ${summary ? `
      <h2 class="rpt-h">Executive Summary</h2>
      <div class="exec-box">${esc(summary)}</div>
    ` : ''}

    ${coverageNoteHtml(report)}

    ${evidencePanelHtml(report, restaurant)}

    ${pillarRows ? `
      <h2 class="rpt-h">Pillar Scores</h2>
      ${pillarRows}
      ${hasScore ? `<div class="score-formula">Overall score: `
        + esc(overallFormula(overall)) + `. Verdict bands: 80 and above Excellent, `
        + `65 to 79 Good, 45 to 64 Fair, below 45 Needs Attention.`
        // v8.11.50: A CHANGED SCORE EXPLAINS ITSELF.
        //
        // This page is rendered at READ time from the stored pillars, so the
        // change is retroactive and nothing needs backfilling. Which means a
        // customer reopening a link from May sees a number about 7 points
        // below the one in the email they were sent. A number that changes
        // under a reader with no explanation is worse than either number.
        + ` Method ` + esc(OVERALL_METHOD_VERSION) + `: the overall score is `
        + `the mean of the six pillar scores above, rounded half up. Reports `
        + `issued before this method was introduced may show a different `
        + `overall score.</div>` : ''}
    ` : ''}

    ${summaryRevisedNote
      // OUTSIDE the score block on purpose. The block above renders only when
      // all six pillars are present, and the rewrite is not a fact about the
      // score: a report with five pillars had its summary rewritten too, and
      // its reader is owed the same sentence.
      ? `<div class="score-formula">${esc(summaryRevisedNote)}</div>` : ''}

    ${businessRealityBlock}

    ${(strengths || risks) ? `
      <h2 class="rpt-h">Strengths &amp; Risks</h2>
      <div class="col-2">
        <div>
          <div class="col-h pos">Strengths</div>
          <ul class="bullet-list">${strengths || '<li style="color:#999">None identified.</li>'}</ul>
        </div>
        <div>
          <div class="col-h neg">Risks</div>
          <ul class="bullet-list">${risks || '<li style="color:#999">None identified.</li>'}</ul>
        </div>
      </div>
    ` : ''}

    ${themesHtml ? `
      <h2 class="rpt-h">Themes</h2>
      ${themesHtml}
    ` : ''}

    ${verbatims ? `
      <h2 class="rpt-h">What Customers Are Saying</h2>
      ${verbatims}
    ` : ''}

    ${report?.employeeSentiment ? `
      <h2 class="rpt-h">Employee Sentiment</h2>
      <p class="body-p">${esc(report.employeeSentiment)}</p>
    ` : ''}

    ${competitors ? `
      <h2 class="rpt-h">Competitive Landscape</h2>
      ${report?.competitiveInsight ? '<p class="body-p" style="margin-bottom:14px">' + esc(report.competitiveInsight) + '</p>' : ''}
      <div class="comp-grid">${competitors}</div>
      <p class="comp-grid-note">These cards describe who your competitors are and how they
      appear publicly. They are not ranked against your HealthCheck score, which measures
      something different${report?.peerComparisonHtml ? ': your position against assessed peers is in "Where you sit" below' : ''}.</p>
    ` : ''}

    ${report?.peerComparisonHtml ? '<div class="peer-cmp">' + report.peerComparisonHtml + '</div>' : ''}
    ${report?.peerComparisonAbsent ? '<h2 class="rpt-h">Where you sit</h2><p class="body-p">' + esc(report.peerComparisonAbsent) + '</p>' : ''}

    ${onlineChannels ? `
      <h2 class="rpt-h">Online Presence ${onlineOverall != null ? '<span class="pres-overall">· Overall ' + onlineOverall + '/100</span>' : ''}</h2>
      ${onlineChannels}
    ` : ''}

    ${ownerBlock}

    ${commercialActionsBlock}

    ${actionsHtml ? `
      <h2 class="rpt-h">Recommended Actions</h2>
      ${actionsHtml}
    ` : ''}

  </div>

  <div class="rpt-footer">
    <div class="rpt-footer-brand">DiagnostiX by 4xi</div>
    <div class="rpt-footer-sub">24/7 · 365 Intelligence Platform</div>
    <div class="rpt-footer-priv">This link is private to ${esc(subscriber.email)}</div>
  </div>

</div></body></html>`;
}

// ── CREATE CUSTOMER (Annual or one-off) ──────────────────────
async function createCustomer({ email, firstName, restaurantName, location, website, report, survey, planType, amountPaid, orderKey }) {
  const reportToken = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const isAnnual = planType === 'annual';

  // Extract optional business performance metrics from survey.
  // Each is either a number in the expected range, or null when operator skipped/didn't track.
  // Logged distinctly so we can measure fill rate from Railway logs while we evaluate
  // whether to build the richer report analysis.
  const bm = (survey && survey.businessMetrics) || {};
  const guestCountChange    = (typeof bm.guestCountChange    === 'number') ? bm.guestCountChange    : null;
  const avgCheckChange      = (typeof bm.avgCheckChange      === 'number') ? bm.avgCheckChange      : null;
  const profitabilityChange = (typeof bm.profitabilityChange === 'number') ? bm.profitabilityChange : null;
  const hasGuest  = guestCountChange    !== null;
  const hasCheck  = avgCheckChange      !== null;
  const hasProfit = profitabilityChange !== null;
  if (hasGuest || hasCheck || hasProfit) {
    console.log('[business-metrics] provided | guest:',  hasGuest  ? guestCountChange    + '%' : 'skipped',
                '| check:',  hasCheck  ? avgCheckChange      + '%' : 'skipped',
                '| profit:', hasProfit ? profitabilityChange + '%' : 'skipped',
                '| email:', maskAddr(email));
  } else {
    console.log('[business-metrics] skipped (all) | email:', maskAddr(email));
  }

  const subscriber = {
    email,
    firstName: firstName || '',
    restaurantName: restaurantName || '',
    location: location || '',
    website: website || '',
    subscribedAt: now,
    planType,
    // NULL IS NOT ZERO. `|| 0` turned an unobserved amount into "paid nothing".
    amountPaid: amountPaid === undefined ? null : amountPaid,
    reportToken,
    reports: [{ generatedAt: now, report, survey, reportNumber: 1 }],
    nextReportAt: isAnnual ? now + (4 * 30 * 24 * 60 * 60 * 1000) : null,
    guestCountChange,
    avgCheckChange,
    profitabilityChange
  };

  // Always cache the subscriber in-memory so /report endpoint has a fallback
  // when Supabase lookup fails (race condition between save + email link click,
  // or when Supabase is unconfigured). The Map name is historical — it now
  // holds all plan types.
  annualSubscribers.set(reportToken, subscriber);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key) {
    try {
      await fetch(url + '/rest/v1/subscribers?on_conflict=report_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': key,
          'Authorization': 'Bearer ' + key,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          email,
          first_name:         firstName || null,
          restaurant_name:    restaurantName || null,
          location:           location || null,
          website:            website || null,
          subscribed_at:      new Date(now).toISOString(),
          next_report_at:     isAnnual ? new Date(subscriber.nextReportAt).toISOString() : null,
          reports_sent:       1,
          active:             isAnnual,
          plan_type:          planType,
          amount_paid:        amountPaid === undefined ? null : amountPaid,
          // v8.11.49: THE ORDER THIS ROW WAS MINTED FOR. Null when it could
          // not be derived, which is not a defect: a delivery that mints no
          // swap token has no order identity to bind, and null never matches.
          order_key:          orderKey || null,
          // v8.11.53: computed. 0 only when there is no score, the column's
          // existing meaning for an undelivered row.
          baseline_score:     recordedScore(report).score ?? 0,
          baseline_report:    report || null,
          report_token:         reportToken,
          guest_count_change:   guestCountChange,
          avg_check_change:     avgCheckChange,
          profitability_change: profitabilityChange
        })
      });
      // v8.11.10: the address and the REPORT TOKEN both used to be here. The
      // token is an unlock credential: anyone reading the log could open the
      // paid report. Neither is logged now.
      safeLog(() => '[customer] saved ' + planType + ' ' + maskAddr(email));
    } catch(e) {
      console.log('[customer] Supabase save failed:', e.message);
    }
  }

  return subscriber;
}


// ── writeOrderRow (v8.11.51) [B1.1] ─────────────────────────────────────────
//
// ONE SALE, ONE ROW, BY NEVER WRITING THE SECOND ONE.
//
// THE DEFECT THIS REPLACES, root caused from the live log on 2026-09-22:
//
//   SUBSCRIBERS_WRITE [sale] what=swap-note method=PATCH row=cddfe686-...
//     http=409 rows=0 code=23505 constraint=idx_subscribers_report_token
//     details="Key (report_token)=(value withheld) already exists."
//
// createCustomer INSERTED a row holding the new report token, and then
// recordSwapOnOrderRow or supersedePlaceholderRow tried to write THAT SAME
// TOKEN onto a second row. report_token is guarded twice, by
// subscribers_report_token_key and by idx_subscribers_report_token, and either
// can be the one named. The guard refused it, and because the duplicate delete
// was gated on that write succeeding, the refusal cancelled the cleanup too.
// Both rows survived. Four sales on 2026-09-22 hold two rows each.
//
// IT WAS DETERMINISTIC, NOT A RACE. Every swap and every recovery inserted and
// then patched to the same token, so every one of them had always failed here.
// The delivery was correct, which is why no customer ever saw it.
//
// THE FIX IS TO REMOVE THE COLLISION AT SOURCE RATHER THAN HANDLE IT. When a
// target row is known, PATCH it and never insert, so no second row ever holds
// the token.
//
//   targetRowId present   the swap path      the order row
//                         the recovery path  the placeholder row
//   targetRowId absent    a matched webhook, a genuine first sale
//
// AND THE CALLER MUST NOT EMAIL UNLESS THIS RETURNS ok. The patch is required
// to change EXACTLY ONE ROW and the row is then READ BACK and its token
// compared. return=representation already makes rows a real count; the read
// back catches the case the count cannot, a patch that matched one row and
// wrote a token the caller did not expect.
//
// WHAT A PATCH DELIBERATELY DOES NOT TOUCH: order_key, amount_paid,
// subscribed_at and plan_type. The order recorded those once. Restating them
// would be inventing a second sale, which is the same reasoning
// recordSwapOnOrderRow carried and the only part of it worth keeping.
async function writeOrderRow(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;

  const reportToken = a.forceToken || crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const isAnnual = a.planType === 'annual';
  const bm = (a.survey && a.survey.businessMetrics) || {};
  const num = (v) => (typeof v === 'number' ? v : null);

  const subscriber = {
    email: a.email,
    firstName: a.firstName || '',
    restaurantName: a.restaurantName || '',
    location: a.location || '',
    website: a.website || '',
    subscribedAt: now,
    planType: a.planType,
    amountPaid: a.amountPaid === undefined ? null : a.amountPaid,
    reportToken,
    reports: [{ generatedAt: now, report: a.report, survey: a.survey, reportNumber: 1 }],
    nextReportAt: isAnnual ? now + (4 * 30 * 24 * 60 * 60 * 1000) : null,
    guestCountChange: num(bm.guestCountChange),
    avgCheckChange: num(bm.avgCheckChange),
    profitabilityChange: num(bm.profitabilityChange),
  };
  annualSubscribers.set(reportToken, subscriber);

  if (!url || !dbKey) return { ok: false, subscriber, reason: 'not-configured' };

  // The report and the identity. Shared by both branches so a swapped row and
  // a freshly sold one cannot disagree about what a delivered row looks like.
  const reportFields = {
    first_name:      a.firstName || null,
    restaurant_name: a.restaurantName || null,
    location:        a.location || null,
    website:         a.website || null,
    report_token:    reportToken,
    baseline_report: a.report || null,
    baseline_score:  recordedScore(a.report).score ?? 0,   // v8.11.53: computed
    reports_sent:    1,
  };

  const targetRowId = typeof a.targetRowId === 'string' ? a.targetRowId.trim() : '';

  if (targetRowId) {
    const w = await writeSubscribers({
      what: 'order-row-patch', method: 'PATCH', rowId: targetRowId,
      filter: 'id=eq.' + encodeURIComponent(targetRowId),
      body: Object.assign({}, reportFields, {
        notes: (a.noteText || 'DELIVERED: report written to the order row.'),
      }),
    });
    if (!w.ok || w.rows !== 1) {
      console.log('ORDER_ROW [sale] patch did not land, NO EMAIL WILL BE SENT'
        + ' row=' + targetRowId + ' http=' + w.status + ' rows=' + w.rows);
      return { ok: false, subscriber, reason: 'patch-rows=' + w.rows + '-http=' + w.status };
    }
    // READ BACK. The count says one row changed; this says it is the right one.
    try {
      const r = await fetch(url + '/rest/v1/subscribers?select=id,report_token'
        + '&id=eq.' + encodeURIComponent(targetRowId),
        { headers: { apikey: dbKey, Authorization: 'Bearer ' + dbKey } });
      const back = r.ok ? await r.json() : null;
      if (!Array.isArray(back) || back.length !== 1 || back[0].report_token !== reportToken) {
        console.log('ORDER_ROW [sale] read back disagreed, NO EMAIL WILL BE SENT row=' + targetRowId);
        return { ok: false, subscriber, reason: 'read-back-mismatch' };
      }
    } catch (e) {
      console.log('ORDER_ROW [sale] read back failed, NO EMAIL WILL BE SENT: ' + (e && e.message));
      return { ok: false, subscriber, reason: 'read-back-failed' };
    }
    console.log('ORDER_ROW [sale] patched row=' + targetRowId + ', no duplicate inserted');
    return { ok: true, subscriber, reason: 'patched', rowId: targetRowId };
  }

  // No target: a genuine first sale. INSERT, and the insert is now CHECKED.
  try {
    const r = await fetch(url + '/rest/v1/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', apikey: dbKey,
        Authorization: 'Bearer ' + dbKey, Prefer: 'return=representation',
      },
      body: JSON.stringify(Object.assign({}, reportFields, {
        email:           a.email,
        subscribed_at:   new Date(now).toISOString(),
        next_report_at:  isAnnual ? new Date(subscriber.nextReportAt).toISOString() : null,
        active:          isAnnual,
        plan_type:       a.planType,
        amount_paid:     a.amountPaid === undefined ? null : a.amountPaid,
        guest_count_change:   subscriber.guestCountChange,
        avg_check_change:     subscriber.avgCheckChange,
        profitability_change: subscriber.profitabilityChange,
        order_key:       a.orderKey || null,
      })),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      const f = pgErrorFields(body);
      console.log('ORDER_ROW [sale] insert failed, NO EMAIL WILL BE SENT http=' + r.status
        + (f.code ? ' code=' + f.code : '') + (f.constraint ? ' constraint=' + f.constraint : ''));
      return { ok: false, subscriber, reason: 'insert-http=' + r.status };
    }
    safeLog(() => '[customer] saved ' + a.planType + ' ' + maskAddr(a.email));
    return { ok: true, subscriber, reason: 'inserted' };
  } catch (e) {
    console.log('ORDER_ROW [sale] insert threw, NO EMAIL WILL BE SENT: ' + (e && e.message));
    return { ok: false, subscriber, reason: 'insert-threw' };
  }
}

// ── A4: one sale, one subscriber row ────────────────────────────────────────
//
// THE PROBLEM. An unmatched order writes a placeholder row carrying the
// amount. If recovery then inserted a second row, the same order would appear
// twice and `select sum(amount_paid) from subscribers` would double count it.
//
// THE MECHANISM: SUPERSEDE IN PLACE. Recovery does not insert. It PATCHes the
// placeholder row that the same order already created, filling in the fields
// that were empty because there was no report: report_token, baseline_report,
// baseline_score, reports_sent. amount_paid, plan_type and subscribed_at are
// left exactly as the order wrote them, so the money is recorded once, at the
// moment it was taken, and never restated.
//
// HOW REVENUE READS AFTERWARD. Unchanged and with no filter:
//
//   select sum(amount_paid) from public.subscribers;
//
// Every paid order is exactly one row, whether it was delivered at purchase,
// delivered by inference, recovered later, or never recovered at all. A row
// with report_token null is a sale that has not been delivered yet, which is
// a real and countable state:
//
//   select count(*) from public.subscribers where report_token is null;
//
// WHY NOT DELETE THE PLACEHOLDER AND INSERT A FRESH ROW. Because a failed
// delete leaves two rows and a double count, and the failure is silent in the
// number that matters. Patching cannot produce two rows at all: if the PATCH
// fails, the placeholder simply stays a placeholder, the buyer still has their
// report by email, and the log says so.
async function findPlaceholderRow({ payingEmail }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) return null;
  try {
    const r = await fetch(url + '/rest/v1/subscribers?select=*'
      + '&email=eq.' + encodeURIComponent(normalizeEmail(payingEmail))
      + '&report_token=is.null&order=subscribed_at.desc&limit=1',
      { headers: { apikey: dbKey, Authorization: 'Bearer ' + dbKey } });
    if (!r.ok) { console.log('PLACEHOLDER [sale] lookup failed ' + r.status); return null; }
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    console.log('PLACEHOLDER [sale] lookup error ' + (e && e.message));
    return null;
  }
}

// ── The swap (v8.11.31) ─────────────────────────────────────────────────────
//
// findOrderRow returns the NEWEST subscriber row for the paying address,
// delivered or placeholder. findPlaceholderRow cannot answer this: it filters
// on report_token IS NULL, so a delivered order comes back as "absent", which
// is the same answer as "no such order" and means the opposite thing.
// v8.11.41: AN UPDATE TO subscribers THAT CHANGES NOTHING IS AN INCIDENT.
//
// THE EARLIER CLAIM HERE WAS WRONG AND IS CORRECTED. It read "across 98 rows,
// no UPDATE to this table from this service has ever landed". 98 is the wrong
// denominator. recordSwapOnOrderRow shipped on 2026-09-20 and has had one
// opportunity. supersedePlaceholderRow needs a placeholder row, and exactly
// one has ever existed, written at 15:29:04 that same day and still not
// superseded because no recovery has run since: 0 of 10 pending rows are
// claimed_by='recovery'. The true count of attempts is at most two, not 98.
//
// The database has since been cleared by hand: service_role holds UPDATE on
// every column, RLS is enabled but service_role carries BYPASSRLS, and there
// is no trigger and no rule on the table. Updates from the SQL editor land.
//
// So this is no longer a known defect. It is an unexplained single occurrence,
// and the response is to make the next one name itself rather than to assert a
// cause. Every write to this table now reports its own status and row count.
async function alertSubscribersUpdateFailed({ what, orderId, status, rows }) {
  try {
    console.log('SUBSCRIBERS_UPDATE_NOOP [sale] ' + what + ' changed ' + rows + ' row(s), status ' + status);
    await alertWebhookProblem({
      kind: 'subscribers-update-noop',
      detail: 'An UPDATE to public.subscribers changed nothing. what=' + what
        + ' row=' + orderId + ' status=' + status + ' rowsAffected=' + rows + '.\n'
        + 'The table itself accepts updates: service_role holds UPDATE on every column, '
        + 'it carries BYPASSRLS, and there is no trigger and no rule on the table. '
        + 'So look at this request, not at the schema: which row id was in the filter, '
        + 'and did that row still match it at the moment of the write.\n'
        + 'Nothing depends on this write: single use is enforced by the unique index '
        + 'on rvp_swap_uses, and the decision is recorded in rvp_outcomes.',
    });
  } catch (e) { console.log('[alert] subscribers-update-noop failed: ' + (e && e.message)); }
}

// v8.11.41: ONE DOOR FOR EVERY WRITE TO public.subscribers.
//
// On 2026-09-20 there was no way to tell a PATCH that changed nothing from a
// PATCH that never ran: both leave a row without the note. The three writers
// to this table were three separate inline fetches, each logging something
// different, and none logging the status and the row count together.
//
// They now share this one function, which logs both every time, on success and
// on failure alike. That is the difference between the next incident naming
// itself and having to be reconstructed a day later.
//
// NEVER A TOKEN AND NEVER AN ADDRESS. The filter is NOT logged, because the
// duplicate delete filters on a report token. Only the row id is, and that is
// a uuid.
async function writeSubscribers({ what, filter, method, body, rowId }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) return { ok: false, status: 0, rows: 0 };
  const label = 'SUBSCRIBERS_WRITE [sale] what=' + what + ' method=' + method
    + ' row=' + (rowId || 'n/a');
  try {
    const r = await fetch(url + '/rest/v1/subscribers?' + filter, {
      method,
      headers: { 'Content-Type': 'application/json', apikey: dbKey,
                 Authorization: 'Bearer ' + dbKey, Prefer: 'return=representation' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // return=representation means a 2xx always carries the changed rows, so a
    // zero here is a real zero and not a missing Prefer header.
    const payload = await r.json().catch(() => null);
    const rows = r.ok ? patchRowsAffected(payload) : 0;
    // v8.11.42: A NON-2xx NAMES ITS CONSTRAINT.
    //
    // On 2026-09-21 this logged `http=409` and nothing else, and it took a
    // trip to the SQL editor to learn which constraint had fired. code and the
    // name were in the body all along. The VALUE that collided is never
    // logged: on this table it is a report token, which opens the paid report.
    //
    // v8.11.50: THERE ARE TWO, AND EITHER CAN BE THE ONE NAMED.
    //
    // This comment used to say the constraint "was
    // subscribers_report_token_key", singular. report_token is guarded TWICE,
    // confirmed from the SQL editor on 2026-09-22:
    //
    //   subscribers_report_token_key   UNIQUE CONSTRAINT on report_token,
    //                                  with its own unique index
    //   idx_subscribers_report_token   UNIQUE PARTIAL INDEX,
    //                                  WHERE report_token IS NOT NULL
    //
    // The 2026-09-21 insert 409 named the constraint. The 2026-09-22 swap-note
    // PATCH 409 named the partial index. Same column, same collision, two
    // different names in the log, and which one Postgres reports is not
    // something this service controls.
    //
    // SO NEVER MATCH ON A CONSTRAINT NAME. Match on `code`, which was 23505
    // both times and means unique_violation. A branch keyed on one of these
    // two names would work until the day the other fired.
    //
    // The partial index is REDUNDANT: a full unique constraint already permits
    // any number of NULLs, so excluding them buys nothing. Dropping it is a
    // low-priority cleanup migration and is recorded in PROGRAM_PROGRESS.md,
    // not done here, because dropping an index is not a comment change.
    let extra = '';
    if (!r.ok) {
      const f = pgErrorFields(payload);
      extra = (f.code ? ' code=' + f.code : '')
        + (f.constraint ? ' constraint=' + f.constraint : '')
        + (f.details ? ' details=' + JSON.stringify(f.details) : '');
    }
    console.log(label + ' http=' + r.status + ' rows=' + rows + extra);
    return { ok: r.ok, status: r.status, rows };
  } catch (e) {
    console.log(label + ' http=ERROR rows=0 ' + (e && e.message));
    return { ok: false, status: 0, rows: 0 };
  }
}

// v8.11.41: THIS LOOKUP IS WRONG ON THE SECOND CLICK, AND NOTHING LOAD-BEARING
// DEPENDS ON IT ANY MORE.
//
// "The newest subscriber row for this address" is not the order. A delivery
// INSERTS a subscriber row, so once click 1 has delivered, the newest row for
// the address is the one click 1 just created. Click 2 reads that row, finds
// null notes and a report token, and concludes the link is unused. That is the
// 2026-09-20 double delivery, and it happens whether or not the SWAPPED note
// was ever written.
//
// NO TIMESTAMP CUTOFF CAN FIX IT, and both obvious ones were tried and
// rejected with a test:
//   the REQUEST START time excludes nothing, because click 2 starts after the
//     row click 1 inserted;
//   the LINK'S ISSUED-AT time excludes the order row ITSELF, because the swap
//     link is minted before deliverPaidReport runs and createCustomer inserts
//     that row a moment later. issuedAt is EARLIER than the row it must keep.
//
// The real fix is to stop looking rows up by address at click time and carry
// the order's identity inside the signed link, bound when the link is minted.
// That is written up in PROGRAM_PROGRESS.md and is not in this release.
//
// WHY THIS IS SAFE MEANWHILE. Single use no longer rests on this row. It is
// the unique index on rvp_swap_uses(order_key), and order_key is derived from
// the signed link, which every click of one link shares. Click 2 still picks
// the wrong row here, still reaches recordSwapUse, and is refused there by the
// database. What is left on this row is the bookkeeping note, which is best
// effort and now says so when it changes nothing.
async function findOrderRow({ payingEmail, orderKey }) {
  // v8.11.49: WHEN THE ORDER IDENTITY IS AVAILABLE, USE IT.
  //
  // The address lookup below is kept as the fallback and is still correct for
  // every order minted before this release, because those 100 rows carry no
  // key and there is nothing else to find them by. What changes is that an
  // order minted from here onward is found by the order it is, not by being
  // the newest thing under an address.
  //
  // A NULL OR EMPTY KEY IS NOT A LOOKUP. order_key=is.null would match every
  // old row, which is worse than the defect, so an underivable key falls
  // straight through to the address path and today's behaviour.
  if (typeof orderKey === 'string' && orderKey.trim()) {
    const url0 = process.env.SUPABASE_URL;
    const key0 = process.env.SUPABASE_KEY;
    if (url0 && key0) {
      try {
        const r0 = await fetch(url0 + '/rest/v1/subscribers?select=*'
          + '&order_key=eq.' + encodeURIComponent(orderKey.trim())
          + '&order=subscribed_at.desc&limit=1',
          { headers: { apikey: key0, Authorization: 'Bearer ' + key0 } });
        if (r0.ok) {
          const rows0 = await r0.json();
          if (Array.isArray(rows0) && rows0.length) {
            // The prefix is a hash and carries no address.
            console.log('SWAP [swap] order found BY KEY key=' + orderKey.slice(0, 12));
            return rows0[0];
          }
          console.log('SWAP [swap] no row for key=' + orderKey.slice(0, 12) + ', trying the address');
        } else {
          console.log('SWAP [swap] key lookup failed ' + r0.status + ', trying the address');
        }
      } catch (e) {
        console.log('SWAP [swap] key lookup error ' + (e && e.message) + ', trying the address');
      }
    }
  }
  return findOrderRowByAddress({ payingEmail });
}

async function findOrderRowByAddress({ payingEmail }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) return null;
  try {
    const r = await fetch(url + '/rest/v1/subscribers?select=*'
      + '&email=eq.' + encodeURIComponent(normalizeEmail(payingEmail))
      + '&order=subscribed_at.desc&limit=1',
      { headers: { apikey: dbKey, Authorization: 'Bearer ' + dbKey } });
    if (!r.ok) { console.log('SWAP [swap] order lookup failed ' + r.status); return null; }
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    console.log('SWAP [swap] order lookup error ' + (e && e.message));
    return null;
  }
}

// v8.11.51 [B1.3]: recordSwapOnOrderRow, supersedePlaceholderRow and
// deleteDuplicateSubscriberRow WERE DELETED HERE, and the reason is worth
// keeping where they were.
//
// All three existed to repair a duplicate row that createCustomer had just
// inserted. Two of them wrote the new report token onto a second row and were
// refused by the unique guard on every swap and every recovery, which then
// cancelled the third. writeOrderRow removes the duplicate rather than
// repairing it, so none of the three has anything left to do.
//
// They are gone rather than left unused. A write that cannot run reads as
// coverage, which is the same argument that deleted SVP's dead
// refused-identity branch.

// ── recordUnmatchedSale (v8.11.14) [B4] ─────────────────────────────────────
//
// THE PRODUCT'S OWN TABLE DID NOT RECORD THE SALE. On 2026-09-19 a buyer paid,
// the matcher found nothing, and `subscribers` stayed at 88 rows. The only
// trace of the money was two emails and a HubSpot flag. Nothing queryable.
//
// A row is now written for every genuine paid order, matched or not. What it
// can honestly carry when no report is matched:
//
//   email            the PAYING address, because that is the customer
//   plan_type,
//   amount_paid      from the order, same as a matched sale
//   subscribed_at    now
//   active           annual only, same rule as a matched sale
//   report_token     NULL. There is no report, so there must be no link. A
//                    token here would render an empty page at /report.
//   baseline_report  NULL, and baseline_score 0, for the same reason.
//   reports_sent     0, because none was.
//   restaurant_name  whatever the order carried, usually nothing.
//   notes            a marker naming the state, so these rows are findable.
//
// NULL report_token is the load-bearing part. `GET /report` requires a token
// of at least 16 characters and looks it up, so an unmatched row is invisible
// to it, which is correct: there is nothing to show yet. When the buyer later
// recovers their report, deliverPaidReport writes a full row through
// createCustomer with a real token, and this placeholder is superseded.
//
// Best effort. A failure here must never turn a delivered report into an
// error, so it logs and returns.
async function recordUnmatchedSale({ payingEmail, firstName, restaurantName, product, wouldHaveInferredId }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) { console.log('UNMATCHED_SALE [sale] skipped: supabase not configured'); return false; }
  const planType = product === 'annual' ? 'annual' : 'one_off';
  // v8.11.45: NULL, not a literal. Wix charges 49.99 and this service never
  // saw what was actually charged, so it writes no amount rather than one it
  // invented. 99 stored rows carry a hard-coded amount and not one is true.
  const amountPaid = amountPaidToWrite();
  try {
    const r = await fetch(url + '/rest/v1/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', apikey: dbKey,
        Authorization: 'Bearer ' + dbKey, Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        email:           payingEmail,
        first_name:      firstName || null,
        restaurant_name: restaurantName || null,
        plan_type:       planType,
        amount_paid:     amountPaid,
        active:          planType === 'annual',
        subscribed_at:   new Date().toISOString(),
        reports_sent:    0,
        baseline_score:  0,
        baseline_report: null,
        report_token:    null,
        // The would-have-chosen row id rides here so that when the buyer
        // recovers, INFERENCE_CHECK can compare it with the row they named.
        // It is an id, not data, and the row it points at is theirs or
        // nobody's.
        notes:           'UNMATCHED_AT_PURCHASE: paid, no survey matched. Awaiting recovery link.'
                         + ' would_infer=' + (wouldHaveInferredId || 'none'),
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.log('UNMATCHED_SALE [sale] failed ' + r.status + ' ' + txt.slice(0, 160));
      return false;
    }
    console.log('UNMATCHED_SALE [sale] recorded domain=' + addrLabel(payingEmail)
      + ' plan=' + planType + ' amount=' + amountPaid);
    return true;
  } catch (e) {
    console.log('UNMATCHED_SALE [sale] error ' + (e && e.message));
    return false;
  }
}

// ── Recovery links (v8.11.13) ───────────────────────────────────────────────
//
// When the matcher answers "none" the buyer has paid and has nothing. The
// cache-miss email now carries a signed link to a page where they name the
// address they used in the survey.
//
// ATTEMPT COUNTING IS IN MEMORY, AND THAT IS A STATED WEAKNESS. Five guesses
// per link, keyed by the paying address the token carries. A restart resets
// the counter. It is not a table because a failed guess identifies no row, so
// there is nothing to count against; the recovery_attempts and
// recovery_locked columns in migration 001 are reserved for a later per-row
// counter and are NOT written by this build. The exposure is small because a
// valid token is required and only the payer is sent one, but it is real and
// it is not hidden here.
const RECOVERY_ATTEMPTS = new Map();

function recoverySecret() {
  return process.env.RVP_RECOVERY_SECRET || '';
}

function buildRecoveryUrl(payingEmail) {
  const secret = recoverySecret();
  if (!secret) return null;
  const base = process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app';
  const t = signRecoveryToken({ payingEmail, issuedAt: Date.now(), secret });
  return base.replace(/\/$/, '') + '/recover?t=' + encodeURIComponent(t);
}

const recoveryEsc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// v8.11.42: THE PAGE KNOWS WHICH MODE IT IS IN.
//
// The same page served a buyer whose order delivered nothing and a buyer whose
// order delivered the WRONG survey, using the first one's words. On 2026-09-21
// a buyer whose report had arrived was told "we could not match it to a
// finished HealthCheck". recoveryCopy picks the wording; this only renders it.
function renderRecoveryPage({ token, message, done, mode, restaurant }) {
  const copy = recoveryCopy({ mode, restaurant });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Find your DiagnostiX report</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f8;
       margin:0;padding:40px 16px;color:#1d2125;line-height:1.55}
  .card{max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:32px 28px;
        box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h1{font-size:1.35rem;margin:0 0 12px}
  label{display:block;font-weight:600;margin:20px 0 6px;font-size:.92rem}
  input[type=email]{width:100%;padding:11px 12px;font-size:1rem;border:1px solid #c6ccd2;
        border-radius:6px;box-sizing:border-box}
  button{margin-top:18px;background:#0b6b57;color:#fff;border:0;border-radius:6px;
         padding:12px 22px;font-size:1rem;font-weight:600;cursor:pointer}
  .msg{margin-top:18px;padding:12px 14px;border-radius:6px;background:#fdf3e3;
       border-left:4px solid #d08a1f;font-size:.93rem}
  .ok{background:#eaf6f1;border-left-color:#0b6b57}
  p.sub{color:#5b656e;font-size:.93rem}
</style></head><body><div class="card">
<h1>${recoveryEsc(copy.heading)}</h1>
${done ? '' : `<p class="sub">${recoveryEsc(copy.intro)}</p>`}
${message ? `<div class="msg${done ? ' ok' : ''}">${recoveryEsc(message)}</div>` : ''}
${done ? '' : `<form method="POST" action="/recover">
<input type="hidden" name="t" value="${recoveryEsc(token)}">
<label for="email">${recoveryEsc(copy.label)}</label>
<input id="email" name="email" type="email" required autocomplete="email" placeholder="you@yourrestaurant.com">
<button type="submit">Send my report</button>
</form>`}
</div></body></html>`;
}

// ── deliverPaidReport (v8.11.13) ────────────────────────────────────────────
//
// EXTRACTED VERBATIM from the webhook so the recovery route runs the SAME
// paid flow rather than a second implementation of it that can drift. The
// only additions are the `source` label on the completion line and `alsoTo`,
// which recovery uses to send a second copy to the survey address.
//
// Callers: the payment webhook, and POST /recover.
async function deliverPaidReport({ destEmail, firstName, restaurant, location,
                                   report, survey, product, planType, amountPaid,
                                   source, alsoTo, surveySavedAt, otherWaitingCount, swapUrl,
                                   targetRowId, noteText }) {

  // v8.11.49: THE ORDER IDENTITY IS BOUND HERE, AT MINT TIME.
  //
  // swapUrl is the recovery link this delivery is about to email, and the key
  // is the same value rvp_swap_uses will store when that link is clicked, so
  // the row and the use agree without translation. Null when there is no link.
  const orderKey = orderKeyForDelivery({ swapUrl, payingEmail: destEmail });

  // v8.11.51 [B1.2]: THE ROW IS WRITTEN ONCE, AND THE EMAIL WAITS FOR IT.
  //
  // This was createCustomer, which INSERTED on every path. On a swap or a
  // recovery that second row held the new report token, and the bookkeeping
  // that followed tried to write the same token onto the order row and was
  // refused by the unique guard. Both rows survived, every time.
  //
  // writeOrderRow PATCHES when a target row is known and inserts only for a
  // genuine first sale, so no second row ever holds the token.
  //
  // AND NOTHING BELOW RUNS UNLESS IT LANDED. The email is the irreversible
  // step: once it is sent the customer has a link, and a link to a report
  // whose row did not save is worse than a failure they can retry.
  const written = await writeOrderRow({
    email: destEmail,
    firstName: firstName,
    restaurantName: restaurant,
    location: survey.location || '',
    website:  survey.website  || '',
    report,
    survey,
    planType,
    amountPaid,
    orderKey,
    targetRowId,
    noteText,
  });
  if (!written.ok) {
    console.log('[deliver] REFUSED: the order row did not save, reason=' + written.reason
      + ' source=' + source + ' addr=' + addrLabel(destEmail));
    return { delivered: false, rowFailed: true, reason: written.reason };
  }
  const subscriber = written.subscriber;

  const supaShaped = {
    email:           subscriber.email,
    first_name:      subscriber.firstName,
    restaurant_name: subscriber.restaurantName,
    plan_type:       subscriber.planType,
    amount_paid:     subscriber.amountPaid,
    active:          planType === 'annual',
    subscribed_at:   new Date(subscriber.subscribedAt).toISOString(),
    next_report_at:  subscriber.nextReportAt ? new Date(subscriber.nextReportAt).toISOString() : null,
    report_token:    subscriber.reportToken
  };

  // ── Peer comparison ──
  // After createCustomer, before the email. The stored payload is updated
  // in place so GET /report?token= renders the same thing the email announces.
  // Either branch writes SOMETHING: a fragment or a sentence saying why there
  // is none. A missing key would render as a section quietly left out.
  const peerNames = (report.competitors || [])
    .map((c) => (c && c.name ? String(c.name).trim() : ''))
    .filter(Boolean);
  // 2026-09-24 (Q5): Analytics resolves subjectName as a Places QUERY
  // (lib/peerGate.js), so a confirmed survey sends the owner's typed name, the
  // query alias; `restaurant` is the Places name the customer sees. Older
  // surveys carry no typedName and send their one name, as before.
  const cmp = await fetchPeerComparison({
    subjectName: (survey && survey.typedName) || restaurant,
    displayName: restaurant,
    subjectLocation: location,
    subjectPillars: Object.fromEntries(
      Object.entries(report.pillars || {}).map(([k, v]) => [k, v && typeof v.score === 'number' ? v.score : null])
    ),
    peerNames,
  });
  if (cmp.ok) {
    report.peerComparisonHtml = cmp.html;
    report.peerComparisonAbsent = null;
    console.log('[webhook] peer comparison ok in ' + cmp.ms + 'ms'
      + (cmp.stats ? ' named=' + cmp.stats.named + ' assessed=' + cmp.stats.assessed + ' excluded=' + cmp.stats.excluded : '')
      + ' runId=' + cmp.runId);
  } else {
    report.peerComparisonHtml = null;
    report.peerComparisonAbsent = PEER_COMPARISON_ABSENT;
    await notifyPeerComparisonUnavailable({
      email: destEmail, restaurantName: restaurant,
      reason: cmp.reason, detail: cmp.detail, ms: cmp.ms,
    });
  }

  // Persist the updated payload. createCustomer already wrote baseline_report
  // without the comparison, so without this patch the page and the email would
  // disagree. Failure here is logged and does not stop the email: the customer
  // getting their report matters more than the comparison reaching the page.
  await patchBaselineReport(subscriber.reportToken, report);

  const reportUrl = (process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app')
                   + '/report?token=' + subscriber.reportToken;

  await Promise.all([
    sendCustomerReportEmail({ subscriber: supaShaped, report, reportNumber: 1, survey,
      // v8.11.30: the buyer is told which survey this answers, and whether any
      // of their own are still waiting.
      provenance: { restaurantName: restaurant, surveySavedAt, otherWaitingCount }, swapUrl }),
    pushReportContextToHubSpot({ subscriber: supaShaped, report, reportNumber: 1, reportUrl, baseline: report })
  ]);

  // v8.11.34: WHAT THE BUYER WAS ACTUALLY TOLD, in the log.
  //
  // The sentences that name the delivered survey are the whole of this
  // release's customer-facing change, and until now the only way to know what
  // they said on a given order was to ask the buyer to forward the email. The
  // restaurant name and the survey date are already in the log elsewhere; this
  // puts them in the form the customer read.
  //
  // The swap URL carries a signed token and is NEVER logged. Whether one was
  // included is what matters and is all that is recorded.
  safeLog(() => '[deliver] lines | ' + deliveryProvenanceLines({
    restaurantName: restaurant, surveySavedAt, otherWaitingCount,
  }).join(' | ') + ' | swapLink=' + (swapUrl ? 'yes' : 'no'));

  safeLog(() => '[deliver] complete for ' + maskAddr(destEmail) + ' | plan: ' + planType + ' | source: ' + source);

  // Recovery delivers to BOTH addresses: the payer, who is the customer of
  // record, and the survey address they named, which is where they expected it.
  if (alsoTo && normalizeEmail(alsoTo) !== normalizeEmail(destEmail)) {
    try {
      await sendCustomerReportEmail({
        subscriber: Object.assign({}, supaShaped, { email: alsoTo }),
        report, reportNumber: 1, survey,
      });
      safeLog(() => '[deliver] second copy sent to ' + maskAddr(alsoTo));
    } catch (e) {
      console.log('[deliver] second copy failed: ' + (e && e.message));
    }
  }

  return { subscriber, supaShaped, reportUrl };
}

// ── Pending report lookup and claiming (v8.11.12) ───────────────────────────
//
// G4: both of these return a safe default on ANY failure. A missing table,
// missing credentials or a slow Supabase produces an empty candidate list,
// which makes the matcher answer "none", which is exactly today's behaviour.
// Nothing here can turn a working purchase into a failure.
async function fetchPendingCandidates({ payingEmail, now }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) return [];
  const H = { apikey: dbKey, Authorization: 'Bearer ' + dbKey };
  const since = new Date(now - INFER_WINDOW_MS).toISOString();
  const out = [];
  const seen = new Set();
  const pull = async (qs, label) => {
    try {
      const r = await fetch(url + '/rest/v1/pending_reports?' + qs, { headers: H });
      if (!r.ok) {
        console.log('PENDING_READ [pending] ' + label + ' failed ' + r.status);
        return;
      }
      for (const row of await r.json()) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push({
          id: row.id,
          email_normalized: row.email_normalized,
          saved_at: Date.parse(row.saved_at),
          claimed_at: row.claimed_at,
          product: row.product,
          report: row.report,
          survey: row.survey,
        });
      }
    } catch (e) {
      console.log('PENDING_READ [pending] ' + label + ' error ' + (e && e.message));
    }
  };
  // Two narrow reads rather than one broad one: the exact address at any age,
  // and everything unclaimed inside the window. The matcher decides between
  // them; this only supplies what it is allowed to consider.
  await pull('select=*&claimed_at=is.null&email_normalized=eq.'
    + encodeURIComponent(normalizeEmail(payingEmail)) + '&order=saved_at.desc&limit=5', 'exact');
  await pull('select=*&claimed_at=is.null&saved_at=gte.' + encodeURIComponent(since)
    + '&order=saved_at.desc&limit=25', 'window');
  return out;
}

// Claims a row. The WHERE clause requires claimed_at to still be null, so two
// concurrent webhooks cannot both claim the same report: the second patches
// zero rows and says so.
// v8.11.37: RETURNS A VERDICT, NOT A BOOLEAN, AND IS CALLED BEFORE DELIVERY.
//
// The filter has always been right: claimed_at=is.null means two concurrent
// callers cannot both patch the row, and the second gets an empty array back.
// What was wrong was WHEN it ran. On 2026-09-20 the claim happened AFTER
// delivery, so two requests both passed their checks, both delivered, and only
// the second claimed. The race was never inside this function.
//
// Only the caller that gets exactly one row back may deliver. Zero rows means
// somebody else holds it. A transport failure means we do not know, and not
// knowing is not permission: a second delivery cannot be taken back.
async function claimPendingReport({ id, claimedBy }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey || !id) return claimVerdict({ ok: false });
  try {
    const r = await fetch(url + '/rest/v1/pending_reports?id=eq.' + encodeURIComponent(id)
      + '&claimed_at=is.null', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: dbKey,
                 Authorization: 'Bearer ' + dbKey, Prefer: 'return=representation' },
      body: JSON.stringify({ claimed_at: new Date().toISOString(), claimed_by: String(claimedBy || 'unknown') }),
    });
    if (!r.ok) {
      console.log('PENDING_CLAIM [pending] failed ' + r.status);
      return claimVerdict({ ok: false, status: r.status });
    }
    const rows = await r.json();
    const v = claimVerdict({ ok: true, rows });
    console.log('PENDING_CLAIM [pending] ' + v.reason + ' rows=' + v.rows + ' by=' + claimedBy);
    return v;
  } catch (e) {
    console.log('PENDING_CLAIM [pending] error ' + (e && e.message));
    return claimVerdict({ ok: false });
  }
}

// RELEASING A CLAIM WE TOOK AND COULD NOT HONOR.
//
// Claiming before delivering means a failed send would otherwise burn the
// survey: the row would read as sold and nothing would ever deliver it. The
// release is filtered on claimed_by so it can only undo OUR claim, never one
// taken by another request in between.
async function releasePendingClaim({ id, claimedBy, reason }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey || !id) return false;
  try {
    const r = await fetch(url + '/rest/v1/pending_reports?id=eq.' + encodeURIComponent(id)
      + '&claimed_by=eq.' + encodeURIComponent(String(claimedBy || '')), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: dbKey,
                 Authorization: 'Bearer ' + dbKey, Prefer: 'return=representation' },
      body: JSON.stringify({ claimed_at: null, claimed_by: null }),
    });
    const n = r.ok ? patchRowsAffected(await r.json()) : 0;
    console.log('PENDING_RELEASE [pending] rows=' + n + ' reason=' + reason);
    if (n !== 1) {
      await alertWebhookProblem({ kind: 'claim-release-failed',
        detail: 'A claim was taken, delivery failed, and releasing it changed ' + n
          + ' row(s). The survey may now read as sold without having been delivered. '
          + 'row=' + id + ' reason=' + reason });
    }
    return n === 1;
  } catch (e) {
    console.log('PENDING_RELEASE [pending] error ' + (e && e.message));
    return false;
  }
}

// ────────── Single use by INSERT (v8.11.37) ──────────
//
// The database refuses the second use. Nothing in this process has to
// remember, check or update anything, which matters because the UPDATE the old
// guarantee depended on has never once landed on this database.
//
// FAILS CLOSED. A missing table, an unreachable database, or any unexpected
// status all answer "not allowed". The swap is refused and the buyer is told
// to reply to their receipt. Allowing a swap whose single use cannot be
// recorded is exactly how the 2026-09-20 double delivery happened.
async function recordSwapUse(fields) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) return { allowed: false, reason: 'no-database' };
  try {
    const r = await fetch(url + '/rest/v1/rvp_swap_uses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: dbKey,
                 Authorization: 'Bearer ' + dbKey, Prefer: 'return=representation' },
      body: JSON.stringify(fields),
    });
    if (r.status === 409) {
      console.log('SWAP_USE [swap] refused: this order has already swapped (unique key)');
      return { allowed: false, reason: 'already-swapped' };
    }
    if (r.status === 404) {
      console.log('SWAP_USE [swap] refused: rvp_swap_uses is missing, migration 002 not applied');
      await alertWebhookProblem({ kind: 'swap-table-missing',
        detail: 'rvp_swap_uses does not exist, so single use cannot be guaranteed and the '
          + 'swap was REFUSED. Apply migrations/002_rvp_swap_uses.sql.' });
      return { allowed: false, reason: 'table-missing' };
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.log('SWAP_USE [swap] refused: insert failed ' + r.status + ' ' + t.slice(0, 120));
      return { allowed: false, reason: 'insert-failed-' + r.status };
    }
    const rows = await r.json();
    const n = patchRowsAffected(rows);
    if (n !== 1) {
      console.log('SWAP_USE [swap] refused: insert returned ' + n + ' row(s)');
      return { allowed: false, reason: 'insert-returned-' + n };
    }
    console.log('SWAP_USE [swap] recorded, this order has now used its one swap');
    return { allowed: true, reason: 'recorded', id: rows[0] && rows[0].id };
  } catch (e) {
    console.log('SWAP_USE [swap] refused: ' + (e && e.message));
    return { allowed: false, reason: 'error' };
  }
}

// ────────── The durable decision record (v8.11.37) ──────────
//
// INSERT only, which is the one operation this service is demonstrably able to
// perform on this database. Best effort: a failure here must never fail a
// delivery, but it is logged, because the point of the table is that
// verification stops depending on a log buffer that resets on every deploy.
// ────────── Inserts that survive an unapplied add-only migration ──────────
//
// PostgREST rejects an insert that names a column the table does not have
// (400, code PGRST204, "Could not find the 'x' column"). A writer that starts
// sending a new column before its migration is applied would therefore lose
// EVERY row, and a lost benchmark row breaks Analytics, which verifies the id.
// So a rejection that names one of the listed new keys is retried ONCE with
// those keys removed. Any other rejection is returned as it was: this is not a
// retry loop, and it never drops a column the migration did not add.
const BENCHMARK_UNMIGRATED_KEYS = ['subject_review_count', 'subject_newest_review_at'];
const OUTCOME_UNMIGRATED_KEYS = ['coverage_verdict', 'place_id', 'place_confirmed',
  'subject_review_count', 'subject_newest_review_at'];

function namesMissingColumn(status, text, keys) {
  if (status !== 400) return false;
  const s = String(text || '');
  if (!/PGRST204|Could not find the/.test(s)) return false;
  return keys.some((k) => s.includes("'" + k + "'"));
}

async function insertTolerant(table, row, optionalKeys) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  const post = (body) => fetch(url + '/rest/v1/' + table, {
    method: 'POST',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key,
               'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(body),
  });
  const first = await post(row);
  if (first.ok) return first;
  const text = await first.text().catch(() => '');
  if (!namesMissingColumn(first.status, text, optionalKeys)) {
    return { ok: false, status: first.status, text: async () => text };
  }
  const stripped = Object.assign({}, row);
  for (const k of optionalKeys) delete stripped[k];
  console.log('[insert] ' + table + ': migration not applied, retried without '
    + optionalKeys.filter((k) => k in row).join(', '));
  return post(stripped);
}

async function writeOutcome(fields) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey) return false;
  try {
    const r = await insertTolerant('rvp_outcomes', fields, OUTCOME_UNMIGRATED_KEYS);
    if (r.status === 404) { console.log('OUTCOME [outcome] table missing, migration 003 not applied'); return false; }
    if (!r.ok) { console.log('OUTCOME [outcome] write failed ' + r.status); return false; }
    console.log('OUTCOME [outcome] ok kind=' + fields.kind + ' decision=' + fields.decision
      + ' delivered=' + fields.delivered + ' claimRows=' + fields.claim_rows);
    return true;
  } catch (e) {
    console.log('OUTCOME [outcome] error ' + (e && e.message));
    return false;
  }
}

// v8.11.21 [C1]: is the row behind a memory entry still unclaimed?
//
// A primary key lookup, deliberately separate from fetchPendingCandidates.
// The candidate pool could not answer this question: it asks only for
// UNCLAIMED rows, so a claimed row and a row outside the window both come back
// as "absent" and the two mean opposite things. This query distinguishes
// unreachable, missing, and claimed, because the fallback differs for each.
//
// Never throws. On any failure it reports the table as unreachable, which
// makes memoryHitVerdict trust memory, which is pre-C1 behaviour.
async function fetchPendingRowState({ id }) {
  const url = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_KEY;
  if (!url || !dbKey || !id) return { reachable: false };
  try {
    const r = await fetch(url + '/rest/v1/pending_reports?select=id,claimed_at&id=eq.'
      + encodeURIComponent(id) + '&limit=1',
      { headers: { apikey: dbKey, Authorization: 'Bearer ' + dbKey } });
    if (!r.ok) {
      console.log('PENDING_STATE [pending] failed ' + r.status);
      return { reachable: false };
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return { reachable: true, found: false };
    return { reachable: true, found: true, claimed: rows[0].claimed_at != null };
  } catch (e) {
    console.log('PENDING_STATE [pending] error ' + (e && e.message));
    return { reachable: false };
  }
}

// v8.11.21 [C1]: after a successful delivery, the entry is spent.
//
// Marked, not deleted. A delete would fix the resale and break Wix retries: a
// second webhook for the same order would find nothing in memory and nothing
// unclaimed in the table, and would turn a delivered sale into a cache miss
// with a spurious recovery email. A spent entry still holds the report, so a
// retry can be answered from it if that is ever wired up.
//
// Called for the PAYING address and, when they differ, the SURVEY address:
// both now name a report that has been sold.
function markMemorySpent({ email, token, reason }) {
  try {
    const key = normalizeEmail(email);
    if (!key) return false;
    const cur = reportStore.get(key);
    if (!cur) return false;
    if (cur.spentAt) return false;
    reportStore.set(key, markSpent(cur, { at: Date.now(), token }));
    console.log('MEMORY_SPENT [webhook] entry marked spent domain=' + addrLabel(key)
      + ' reason=' + reason);
    return true;
  } catch (e) {
    // Best effort by design: a failure here must never fail a delivery that
    // has already happened.
    console.log('MEMORY_SPENT [webhook] error ' + (e && e.message));
    return false;
  }
}

// ── C2 and C3: the Wix URL is wrong, and somebody has to find out ───────────
//
// A rejected call and a misrouted path are the same condition wearing two
// coats: the automation is pointed somewhere that does not work, and it will
// stay that way on every order until a human changes it. On 2026-09-19 exactly
// that cost part of an afternoon of sales, and the only trace was a 404 in
// Railway's edge log.
//
// ONE THROTTLE SHARED BY BOTH, because a broken URL usually produces both.
// Ten minutes: loud enough to notice within one order cycle, quiet enough that
// an unauthenticated endpoint cannot be looped to flood the alert mailbox.
// Suppressed calls are counted and reported in the next alert that does send,
// so the throttle hides the volume for ten minutes and never hides it for good.
//
// NOTHING FROM THE BODY EVER APPEARS HERE. A rejected call's body is attacker
// controlled, and the whole point of rejecting it is to stop acting on it.
const WEBHOOK_ALERT = { lastAt: 0, suppressed: 0 };

// A consultant-led lead: a requester reached a step that refused them. Same
// shape as EVP's "LEAD, identity unresolved" mail: what they typed and why, and
// NEVER the requester's address. Best effort; it never fails a request.
async function sendLeadAlert({ kind, subject, location, lines }) {
  try {
    const esc = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    await sendEmailViaResend({
      to: 'hello@4xiconsulting.com',
      subject: 'LEAD, ' + kind + ': ' + subject,
      fromName: 'DiagnostiX Alerts',
      html: '<p>A requester reached the survey and was refused before any assessment ran.</p><ul>'
        + '<li>Restaurant as typed: ' + esc(subject) + '</li>'
        + '<li>Location as typed: ' + esc(location || 'not given') + '</li>'
        + (lines || []).map((l) => '<li>' + esc(l) + '</li>').join('')
        + '</ul><p>This is a consultant-led lead.</p>',
    });
    console.log('LEAD [lead] sent kind=' + kind);
    return true;
  } catch (e) {
    console.log('LEAD [lead] error ' + (e && e.message));
    return false;
  }
}

async function alertWebhookProblem({ kind, detail }) {
  try {
    WEBHOOK_ALERT.suppressed += 1;
    const t = alertThrottle({ lastSentAt: WEBHOOK_ALERT.lastAt, now: Date.now() });
    if (!t.send) {
      console.log('WEBHOOK_ALERT [webhook] suppressed, ' + WEBHOOK_ALERT.suppressed
        + ' since the last one, next in '
        + Math.max(0, Math.ceil((ALERT_THROTTLE_MS - t.elapsed) / 1000)) + 's');
      return false;
    }
    const n = WEBHOOK_ALERT.suppressed;
    WEBHOOK_ALERT.lastAt = Date.now();
    WEBHOOK_ALERT.suppressed = 0;
    const esc = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    console.log('WEBHOOK_ALERT [webhook] sent kind=' + kind + ' covering=' + n + ' call(s)');
    // v8.11.42: THE OPENING AND CLOSING BELONG TO THE KIND, NOT TO THE MAILER.
    // Every kind used to get the /payment-webhook paragraph and the 2026-09-19
    // missing-slash paragraph. For subscribers-update-noop both are false: the
    // sale was delivered and emailed, and no URL is broken. alertCopyFor
    // defaults to exactly today's text, so every webhook alert is unchanged.
    const copy = alertCopyFor(kind);
    await sendEmailViaResend({
      to: 'hello@4xiconsulting.com',
      subject: kind,
      fromName: 'DiagnostiX Alerts',
      html: '<p><strong>' + esc(kind) + '</strong></p>'
        + '<p>' + esc(copy.opening) + '</p>'
        + '<ul>'
        + '<li>' + esc(detail) + '</li>'
        + '<li>calls covered by this alert: ' + n + '</li>'
        + '<li>next alert possible in: ' + Math.round(ALERT_THROTTLE_MS / 60000) + ' minutes</li>'
        + '</ul>'
        + (copy.closing ? '<p>' + esc(copy.closing) + '</p>' : '')
        + (copy.requestNote === false ? ''
          : '<p>Nothing from the request body appears in this alert, deliberately: a '
            + 'rejected call is not trusted enough to quote.</p>'),
    });
    return true;
  } catch (e) {
    // An alert must never be able to fail a request.
    console.log('WEBHOOK_ALERT [webhook] error ' + (e && e.message));
    return false;
  }
}

// G3: an inferred delivery is never silent.
async function alertInferredMatch({ payingEmail, surveyEmail, restaurantName, product, reason, shadow }) {
  const INTERNAL_TO = 'hello@4xiconsulting.com';
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  try {
    await sendEmailViaResend({
      to: INTERNAL_TO,
      subject: shadow
        ? 'SHADOW: inference would have matched a paid report (nothing delivered)'
        : 'INFERRED match delivered a paid report',
      fromName: 'DiagnostiX Alerts',
      html: (shadow
        ? '<p><strong>Inference WOULD have matched this order to a survey. Nothing was'
          + ' delivered on it.</strong> The buyer was sent the recovery link instead.'
          + ' This alert exists so the rule can be watched before it is trusted.</p>'
        : '<p><strong>A paid report was delivered on an INFERRED match, not an exact one.</strong></p>')
        + '<ul>'
        + '<li>paying address domain: ' + esc(emailDomain(payingEmail)) + '</li>'
        + '<li>survey address domain: ' + esc(emailDomain(surveyEmail)) + '</li>'
        + '<li>addresses equal: no (an exact match would not be inferred)</li>'
        + '<li>restaurant: ' + esc(restaurantName || '(not supplied)') + '</li>'
        + '<li>product: ' + esc(product) + '</li>'
        + '<li>rule: ' + esc(reason) + '</li>'
        + '</ul>'
        + '<p>The rule fired because exactly ONE unclaimed survey existed in the '
        + Math.round(INFER_WINDOW_MS / 60000) + ' minute window. Two would have refused. '
        + 'The report was delivered to the PAYING address, never redirected to the survey one.</p>'
        + '<p>If this is the wrong report, the survey row is claimed and named above by domain; '
        + 'reply here and it can be unclaimed by hand.</p>',
    });
  } catch (e) {
    console.log('[webhook] INFERRED alert failed: ' + (e && e.message));
  }
}


// ── GET /recover and POST /recover (v8.11.13) ───────────────────────────────
//
// The buyer email is no longer a dead end. Both routes fail closed: a bad,
// expired or absent token renders the same refusal, and neither reveals
// whether any particular address exists.
app.get('/recover', async (req, res) => {
  const token = String(req.query.t || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!recoverySecret()) {
    console.log('RECOVERY [recover] GET refused: RVP_RECOVERY_SECRET not set');
    return res.status(503).send(renderRecoveryPage({ token, done: true,
      message: 'Report recovery is not available right now. Please reply to your receipt and we will sort it out.' }));
  }
  const v = verifyRecoveryToken({ token, secret: recoverySecret(), now: Date.now() });
  if (!v.ok) {
    console.log('RECOVERY [recover] GET rejected reason=' + v.reason);
    return res.status(400).send(renderRecoveryPage({ token, done: true,
      message: v.reason === 'expired'
        ? 'This link has expired. Reply to your receipt and we will send your report.'
        : 'This link is not valid. Reply to your receipt and we will send your report.' }));
  }
  // v8.11.42: THE MODE IS RESOLVED HERE, at the cost of one query per view.
  //
  // Before this the GET verified the token and rendered immediately, so the
  // page could not know whether the order had delivered. An unreadable order
  // row simply falls back to recovery copy, which is what the page said
  // before, so a failed lookup costs wording and never the page.
  let mode = 'recovery', restaurant = '';
  try {
    const orderRow = await findOrderRow({ payingEmail: v.payingEmail,
      orderKey: swapOrderKey({ payingEmail: v.payingEmail, token }) });
    const elig = swapEligibility({ orderRow });
    mode = elig.mode;
    restaurant = (orderRow && orderRow.restaurant_name) || '';
  } catch (e) {
    console.log('RECOVERY [recover] GET mode lookup failed, showing recovery copy: ' + (e && e.message));
  }
  console.log('RECOVERY [recover] GET mode=' + mode + ' named=' + (restaurant ? 'yes' : 'no'));
  res.status(200).send(renderRecoveryPage({ token, mode, restaurant }));
});

app.post('/recover', express.urlencoded({ extended: false }), async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const token = String((req.body && req.body.t) || '');
  const typed = normalizeEmail((req.body && req.body.email) || '');
  const secret = recoverySecret();
  const now = Date.now();

  const v = verifyRecoveryToken({ token, secret, now });
  if (!secret || !v.ok) {
    console.log('RECOVERY [recover] POST rejected reason=' + (secret ? v.reason : 'no-secret'));
    // v8.11.42: EVERY EXIT FROM THIS HANDLER WRITES AN OUTCOME ROW.
    //
    // Until now only the four exits that got as far as a claim did. The three
    // failed attempts on 2026-09-21 left NOTHING in rvp_outcomes, and their
    // typed addresses had to be read out of a log buffer, which is the exact
    // dependency this table exists to remove. There is no paying address to
    // record here: the token did not verify, so nothing in it is trusted.
    await writeOutcome(outcomeRecord({
      kind: 'recover', decision: 'refused',
      reason: secret ? 'invalid-token-' + v.reason : 'no-secret',
      surveyEmail: typed, delivered: false,
    }));
    return res.status(400).send(renderRecoveryPage({ token, done: true,
      message: 'This link is not valid or has expired. Reply to your receipt and we will send your report.' }));
  }

  const payingEmail = v.payingEmail;

  // The mode is resolved once and used for every exit below, so a buyer who
  // mistypes an address three times is not shown recovery wording on the
  // second try and swap wording on the third.
  const orderRowForMode = await findOrderRow({ payingEmail,
    orderKey: swapOrderKey({ payingEmail, token }) });
  const eligForMode = swapEligibility({ orderRow: orderRowForMode });
  const pageMode = eligForMode.mode;
  const pageRestaurant = (orderRowForMode && orderRowForMode.restaurant_name) || '';

  const used = RECOVERY_ATTEMPTS.get(payingEmail) || 0;
  if (used >= RECOVERY_MAX_ATTEMPTS) {
    console.log('RECOVERY [recover] locked attempts=' + used + ' domain=' + addrLabel(payingEmail));
    await writeOutcome(outcomeRecord({
      kind: 'recover', decision: 'refused', reason: 'locked-attempts=' + used,
      payingEmail, surveyEmail: typed, delivered: false,
    }));
    return res.status(429).send(renderRecoveryPage({ token, done: true,
      mode: pageMode, restaurant: pageRestaurant,
      message: 'Too many attempts on this link. We have been alerted and will email you directly.' }));
  }

  if (!typed || typed.indexOf('@') < 1) {
    RECOVERY_ATTEMPTS.set(payingEmail, used + 1);
    await writeOutcome(outcomeRecord({
      kind: 'recover', decision: 'refused', reason: 'not-an-email-address',
      payingEmail, surveyEmail: typed, delivered: false,
    }));
    return res.status(400).send(renderRecoveryPage({ token,
      mode: pageMode, restaurant: pageRestaurant,
      message: 'That does not look like an email address. '
        + Math.max(0, RECOVERY_MAX_ATTEMPTS - used - 1) + ' attempts left.' }));
  }

  // EXACT match on the typed address only. The window rule is switched off
  // here (windowMs: 0) because the buyer has told us the address: there is
  // nothing left to infer, and inferring anyway would be the v8.9.37 mistake
  // wearing a different hat.
  // v8.11.31: WHICH MODE, AND MAY THIS LINK BE USED AT ALL.
  //
  // The same signed link now arrives with every paid delivery, so it is used
  // in two situations: an order that delivered nothing (recovery, unchanged
  // behaviour) and an order that delivered the wrong survey (swap, new). The
  // difference is visible on the order's subscriber row, and so is whether the
  // one swap it is entitled to has already been taken.
  //
  // Checked BEFORE the candidate lookup so a spent link cannot even learn
  // whether a given address has an unclaimed survey.
  // v8.11.41: THIS ANSWER IS UNRELIABLE ON A SECOND CLICK, BY DESIGN OF THE
  // DATA AND NOT OF THIS LINE. See findOrderRow for why no timestamp cutoff
  // repairs it. It decides the MODE and writes a note; it is no longer what
  // makes a swap single use. That is recordSwapUse and the unique index.
  // v8.11.42: resolved ONCE, above, and reused. Two lookups of the same row in
  // one request could disagree if a delivery landed between them, and then the
  // page and the decision would be about different rows.
  const orderRow = orderRowForMode;
  const elig = eligForMode;
  console.log('SWAP [swap] mode=' + elig.mode + ' allowed=' + elig.allowed
    + ' reason=' + elig.reason + ' addr=' + addrLabel(payingEmail));
  if (!elig.allowed) {
    await writeOutcome(outcomeRecord({
      kind: 'recover', decision: elig.mode, reason: 'refused-' + elig.reason,
      payingEmail, surveyEmail: typed, delivered: false,
    }));
    return res.status(409).send(renderRecoveryPage({ token, done: true,
      mode: pageMode, restaurant: pageRestaurant,
      message: 'This link has already been used once. Each order includes one swap. '
        + 'Reply to your receipt and we will sort out anything else.' }));
  }

  const candidates = await fetchPendingCandidates({ payingEmail: typed, now });
  let m;
  try {
    m = matchPendingReport({ payingEmail: typed, candidates, now, windowMs: 0 });
  } catch (e) {
    console.log('RECOVERY [recover] candidates unorderable: ' + (e && e.message));
    await alertWebhookProblem({ kind: 'unorderable-candidates',
      detail: 'matchPendingReport refused the candidate rows on the recovery path. ' + (e && e.message) });
    m = { decision: 'none', match: null, reason: 'candidates-unorderable' };
  }
  // rule=exact-only is stated because the matcher's own reason string reads
  // "no-candidate-in-window" here, which would tell an operator the window
  // rule had been applied. It has not: windowMs is 0 on this path.
  console.log('RECOVERY [recover] attempt rule=exact-only decision=' + m.decision
    + ' matcherReason=' + m.reason + ' candidates=' + candidates.length
    + ' payingDomain=' + addrLabel(payingEmail) + ' typedDomain=' + addrLabel(typed));

  if (m.decision !== 'exact' || !m.match) {
    const next = used + 1;
    RECOVERY_ATTEMPTS.set(payingEmail, next);
    if (next >= RECOVERY_MAX_ATTEMPTS) {
      console.log('RECOVERY [recover] LOCKED domain=' + addrLabel(payingEmail));
      await alertRecoveryLocked({ payingEmail, attempts: next });
    }
    // THE FAILED ATTEMPT IS NOW READABLE FROM THE TABLE. The candidate count
    // and the matcher's own reason ride in `reason`, which needs no new column
    // and so no migration.
    await writeOutcome(outcomeRecord({
      kind: 'recover', decision: 'none',
      reason: m.reason + ' candidates=' + candidates.length,
      payingEmail, surveyEmail: typed, delivered: false,
    }));
    return res.status(404).send(renderRecoveryPage({ token,
      mode: pageMode, restaurant: pageRestaurant,
      // v8.11.42: two of the three failed attempts on 2026-09-21 typed the
      // PAYING address. "We have no unclaimed report for that address" is true
      // and tells them nothing. This names it.
      message: recoveryNotFound({ mode: elig.mode, typed, payingEmail }) + ' '
        + Math.max(0, RECOVERY_MAX_ATTEMPTS - next) + ' attempts left.' }));
  }

  const row = m.match;
  const report = row.report || {};
  const survey = row.survey || {};
  const restaurant = survey.name || '';
  const product = row.product || 'full';
  const planType = product === 'annual' ? 'annual' : 'one_off';
  // v8.11.45: NULL, not a literal. Wix charges 49.99 and this service never
  // saw what was actually charged, so it writes no amount rather than one it
  // invented. 99 stored rows carry a hard-coded amount and not one is true.
  const amountPaid = amountPaidToWrite();

  // v8.11.37: CLAIM, THEN ENTITLEMENT, THEN DELIVER. In that order.
  //
  // Claim first because a lost claim race is recoverable: the claim is
  // released and nothing was consumed. Recording the swap use first would
  // burn the order's one swap on a race it lost, and that is not recoverable.
  const claimedBy = elig.mode === 'swap' ? 'swap' : 'recovery';
  const claim = await claimPendingReport({ id: row.id, claimedBy });
  if (!claim.mayDeliver) {
    console.log('RECOVERY [recover] lost the claim race reason=' + claim.reason);
    await writeOutcome(outcomeRecord({
      kind: 'recover', decision: claimedBy, reason: 'lost-claim-race',
      payingEmail, surveyEmail: typed, pendingRowId: row.id,
      delivered: false, claimRows: claim.rows,
    }));
    return res.status(409).send(renderRecoveryPage({ token, done: true, mode: pageMode, restaurant: pageRestaurant,
      message: 'That report has just been sent. Check your inbox, and reply to your receipt '
        + 'if it has not arrived.' }));
  }

  // SINGLE USE, ENFORCED BY THE DATABASE. The insert carries a unique key on
  // the order, so a second attempt is refused by the index rather than by a
  // marker this service has to write and read back. It fails closed: if the
  // table is missing or unreachable the swap is refused, not allowed.
  if (elig.mode === 'swap') {
    const orderKey = swapOrderKey({ payingEmail, token });
    // The key prefix is logged so two attempts on one order can be seen to
    // agree. It is a hash and carries no address.
    console.log('SWAP_USE [swap] key=' + orderKey.slice(0, 12));
    const use = await recordSwapUse({
      order_key: orderKey,
      addr_domain: emailDomain(payingEmail),
      addr_local_len: normalizeEmail(payingEmail).lastIndexOf('@'),
      survey_addr_domain: emailDomain(typed),
      survey_addr_local_len: normalizeEmail(typed).lastIndexOf('@'),
      restaurant, pending_row_id: row.id,
    });
    if (!use.allowed) {
      await releasePendingClaim({ id: row.id, claimedBy, reason: 'swap-refused-' + use.reason });
      await writeOutcome(outcomeRecord({
        kind: 'recover', decision: 'swap', reason: 'refused-' + use.reason,
        payingEmail, surveyEmail: typed, pendingRowId: row.id,
        delivered: false, claimRows: claim.rows, swapUsed: false,
      }));
      const msg = use.reason === 'already-swapped'
        ? 'This link has already been used once. Each order includes one swap. '
          + 'Reply to your receipt and we will sort out anything else.'
        : 'We cannot complete a swap right now. Reply to your receipt and we will send '
          + 'the right report straight away.';
      return res.status(409).send(renderRecoveryPage({ token, done: true, mode: pageMode, restaurant: pageRestaurant, message: msg }));
    }
  }

  // v8.11.51 [B1.2]: THE ROW THIS DELIVERY WRITES INTO, chosen before the
  // delivery rather than patched up afterwards.
  //
  //   a swap      the ORDER row, which already carries a report token
  //   a recovery  the PLACEHOLDER row this order wrote at purchase
  //   neither     no target, and deliverPaidReport inserts
  //
  // findPlaceholderRow filters on report_token IS NULL, so it cannot return a
  // delivered order, which is why the swap branch is asked first.
  let targetRowId = null;
  let noteText = null;
  if (elig.mode === 'swap' && orderRow && orderRow.id) {
    targetRowId = orderRow.id;
    noteText = SWAP_NOTE_PREFIX + ' delivered ' + String(restaurant || 'a different survey')
      + ' in place of the original, by the swap link, on ' + new Date().toISOString() + '.';
  } else {
    const ph = await findPlaceholderRow({ payingEmail });
    if (ph && ph.id) {
      targetRowId = ph.id;
      noteText = 'RECOVERED: delivered by the recovery link after an unmatched purchase.';
    }
  }
  console.log('ORDER_ROW [sale] target=' + (targetRowId ? targetRowId : 'none, will insert')
    + ' mode=' + elig.mode);

  const delivered = await deliverPaidReport({
    destEmail: payingEmail,
    firstName: survey.contactName || survey.firstName || '',
    restaurant, location: survey.location || '',
    report, survey, product, planType, amountPaid,
    source: 'recovery', alsoTo: typed,
    targetRowId, noteText,
    // v8.11.30: recovery delivers a named survey too, and the buyer who has
    // just had to go and find it is the one who most needs to be told which
    // one arrived. otherWaitingCount is deliberately 0 here: the count is
    // about the PAYING address, and on this path the buyer has just told us
    // the survey lives somewhere else.
    surveySavedAt: row.saved_at || null,
    otherWaitingCount: 0,
  });

  if (!delivered) {
    console.log('RECOVERY [recover] delivery failed, releasing the claim');
    await releasePendingClaim({ id: row.id, claimedBy, reason: 'delivery-failed' });
    await writeOutcome(outcomeRecord({
      kind: 'recover', decision: claimedBy, reason: 'delivery-failed',
      payingEmail, surveyEmail: typed, pendingRowId: row.id,
      delivered: false, claimRows: claim.rows,
    }));
    return res.status(500).send(renderRecoveryPage({ token, done: true, mode: pageMode, restaurant: pageRestaurant,
      message: 'We found your report and could not send it. We have been alerted and will email you directly.' }));
  }

  await writeOutcome(outcomeRecord({
    // v8.11.48: when the buyer typed the address that PAID, say so. The
    // eligibility reason is kept and prefixed, never replaced, and the marker
    // carries no address.
    kind: 'recover', decision: claimedBy,
    reason: recoveryReason({ eligibilityReason: elig.reason, typedEmail: typed, payingEmail }),
    payingEmail, surveyEmail: typed, pendingRowId: row.id,
    deliveredRestaurant: restaurant, delivered: true, claimRows: claim.rows,
    swapUsed: elig.mode === 'swap',
  }));

  // v8.11.21 [C1]: both addresses are retired in memory too. The typed address
  // is the survey's, and the paying address may well hold a stale entry of its
  // own; neither is for sale after this.
  const recoveredToken = delivered.subscriber && delivered.subscriber.reportToken;
  markMemorySpent({ email: typed, token: recoveredToken, reason: 'delivered-recovery-survey-side' });
  if (normalizeEmail(payingEmail) !== normalizeEmail(typed)) {
    markMemorySpent({ email: payingEmail, token: recoveredToken, reason: 'delivered-recovery' });
  }

  // v8.11.31: A SWAP REPLACES WHAT THE ORDER DELIVERED, IN PLACE.
  //
  // One sale, one subscriber row, on both paths. The difference is which row
  // is the survivor: recovery fills in the placeholder this order wrote, and a
  // swap overwrites the row that already carries the wrong report. Either way
  // the row createCustomer just inserted is removed.
  // v8.11.51 [B1.3]: THE BOOKKEEPING IS GONE BECAUSE THERE IS NOTHING LEFT TO
  // TIDY. writeOrderRow patched the order row with the new report, the token
  // and the SWAPPED note BEFORE the email went out, and inserted nothing, so
  // there is no duplicate to remove and no note to write afterwards.
  if (elig.mode === 'swap' && orderRow && orderRow.id && delivered.subscriber) {
    await alertSwapUsed({ payingEmail, surveyEmail: typed, restaurantName: restaurant, product });
    RECOVERY_ATTEMPTS.delete(payingEmail);
    return res.status(200).send(renderRecoveryPage({ token, done: true, mode: pageMode, restaurant: pageRestaurant,
      message: 'Sent. Your report for ' + restaurant + ' is on its way to both addresses. '
        + 'You can close this page.' }));
  } else if (elig.mode === 'swap') {
    // v8.11.41: A SWAP THAT SKIPS THE WRITE SAYS WHICH GUARD STOPPED IT.
    //
    // When this guard is false the request falls through to the placeholder
    // branch and logs "none found for this order", which is a sentence about a
    // different code path. Afterwards the row looks exactly as it would if the
    // PATCH had run and changed nothing. These are the two cases the retest has
    // to tell apart, so the skip names itself.
    //
    // THIS IS THE OPEN QUESTION FROM 2026-09-20, NARROWED TO TWO ANSWERS. The
    // cleanup that day appended to notes rather than replacing them, and the
    // three swap-test rows read as the test label with nothing before it, so
    // their notes were NULL beforehand. No SWAPPED marker existed on any of
    // them after click 1. The write was therefore either SKIPPED or it CHANGED
    // NOTHING, and until 2026-09-20 nothing in the log could tell those apart.
    // SWAP_SKIPPED means skipped. SUBSCRIBERS_WRITE with rows=0 means it ran
    // and changed nothing. Exactly one of them should appear at the retest.
    console.log('SWAP_SKIPPED [swap] the swap note was NOT attempted'
      + ' orderRow=' + (orderRow ? 'yes' : 'no')
      + ' orderRowId=' + (orderRow && orderRow.id ? 'yes' : 'no')
      + ' deliveredSubscriber=' + (delivered && delivered.subscriber ? 'yes' : 'no'));
  }

  // v8.11.51 [B1.3]: A4 IS SATISFIED EARLIER NOW. The placeholder was chosen
  // as the target BEFORE the delivery and patched by writeOrderRow, so the
  // amount is still recorded once, at the moment it was taken, and nothing is
  // inserted that then has to be removed. The lookup that used to happen here
  // now happens above, where its answer can still change what is written.

  // A2: the measurement. The buyer has just told us which survey was theirs,
  // so this is the only moment at which inference can be marked right or
  // wrong without guessing. would_infer rides on the placeholder's notes.
  const wouldId = placeholder && typeof placeholder.notes === 'string'
    ? (placeholder.notes.match(/would_infer=([^\s]+)/) || [])[1]
    : null;
  const verdict = inferenceVerdict({
    wouldHaveInferredId: wouldId && wouldId !== 'none' ? wouldId : null,
    recoveredId: row.id,
  });
  console.log('INFERENCE_CHECK would-have-been=' + verdict
    + ' recoveredRow=' + row.id + ' wouldHaveChosen=' + (wouldId || 'unknown'));

  await alertRecoveryUsed({ payingEmail, surveyEmail: typed, restaurantName: restaurant, product });
  RECOVERY_ATTEMPTS.delete(payingEmail);

  return res.status(200).send(renderRecoveryPage({ token, done: true, mode: pageMode, restaurant: pageRestaurant,
    message: 'Sent. Your report is on its way to both addresses. You can close this page.' }));
});

async function alertRecoveryLocked({ payingEmail, attempts }) {
  try {
    await sendEmailViaResend({
      to: 'hello@4xiconsulting.com',
      subject: 'Recovery link LOCKED after ' + attempts + ' attempts',
      fromName: 'DiagnostiX Alerts',
      html: '<p><strong>A paid buyer has run out of recovery attempts.</strong></p>'
        + '<ul><li>paying address domain: ' + recoveryEsc(emailDomain(payingEmail)) + '</li>'
        + '<li>attempts: ' + recoveryEsc(attempts) + '</li></ul>'
        + '<p>They have paid and still have nothing. Find their survey by hand and send it.</p>',
    });
  } catch (e) { console.log('[recover] locked alert failed: ' + (e && e.message)); }
}

async function alertRecoveryUsed({ payingEmail, surveyEmail, restaurantName, product }) {
  try {
    await sendEmailViaResend({
      to: 'hello@4xiconsulting.com',
      subject: 'Recovery link used: a paid report was matched by hand',
      fromName: 'DiagnostiX Alerts',
      html: '<p><strong>A buyer recovered their own report through the link.</strong></p>'
        + '<ul><li>paying address domain: ' + recoveryEsc(emailDomain(payingEmail)) + '</li>'
        + '<li>survey address domain: ' + recoveryEsc(emailDomain(surveyEmail)) + '</li>'
        + '<li>restaurant: ' + recoveryEsc(restaurantName || '(not supplied)') + '</li>'
        + '<li>product: ' + recoveryEsc(product) + '</li></ul>'
        + '<p>Delivered to BOTH addresses. The survey row is now claimed.</p>',
    });
  } catch (e) { console.log('[recover] used alert failed: ' + (e && e.message)); }
}

// ── The three alerts that make a substitution visible (v8.11.31) ────────────
//
// Every one of these describes a condition that was already happening and that
// nobody could see. All go through alertWebhookProblem's existing throttle, so
// a misconfiguration cannot turn into a mailstorm, and all are addressed in
// domain plus local part length, never in full.

// 1. An OLD survey was delivered while NEWER ones sat waiting under other
//    addresses. This is exactly 2026-09-20: a 17 hour old FarmShop row was the
//    only exact match, and two Drum & Monkey rows from four and eight minutes
//    earlier were invisible to the rule that chose it.
async function alertStaleExact({ payingEmail, delivered, newerElsewhere }) {
  try {
    const ageH = (ms) => (ms / 3600000).toFixed(1) + 'h';
    await alertWebhookProblem({
      kind: 'stale-exact',
      detail: 'STALE EXACT: delivered an older survey while newer ones were waiting.\n'
        + 'delivered: ' + (delivered.restaurantName || '(unnamed)')
        + ', age ' + ageH(delivered.ageMs) + ', address ' + addrLabel(payingEmail) + '\n'
        + 'newer and still unclaimed, under other addresses:\n'
        + newerElsewhere.map(r => '  ' + (r.restaurantName || '(unnamed)')
            + ', age ' + ageH(r.ageMs) + ', address ' + addrLabel(r.email)).join('\n')
        + '\nThe rule was applied correctly. Whether it chose the survey the buyer '
        + 'wanted is a different question, and the swap link is how they answer it.',
    });
  } catch (e) { console.log('[alert] stale-exact failed: ' + (e && e.message)); }
}

// 2. A delivery left other unclaimed rows under the SAME address. Nothing
//    revisits those, so without this they are stranded in silence.
async function alertStrandedRows({ payingEmail, stranded }) {
  try {
    await alertWebhookProblem({
      kind: 'stranded-rows',
      detail: 'A delivery left ' + stranded.length + ' unclaimed survey(s) under the same '
        + 'address ' + addrLabel(payingEmail) + '. Nothing will revisit them.\n'
        + stranded.map(r => '  row ' + r.id + '  ' + (r.restaurantName || '(unnamed)')).join('\n'),
    });
  } catch (e) { console.log('[alert] stranded failed: ' + (e && e.message)); }
}

// 3. A swap was used. Distinct from alertRecoveryUsed: recovery means the
//    order delivered nothing, a swap means it delivered the wrong thing, and
//    the second is a signal about the matching rule rather than about a
//    mismatched address.
async function alertSwapUsed({ payingEmail, surveyEmail, restaurantName, product }) {
  try {
    await sendEmailViaResend({
      to: 'hello@4xiconsulting.com',
      subject: 'Swap link used: a buyer corrected which report they were sent',
      fromName: 'DiagnostiX Alerts',
      html: '<p><strong>A buyer used their one swap.</strong> The order had already been '
        + 'delivered, and they told us it was the wrong survey.</p>'
        + '<ul><li>paying address: ' + recoveryEsc(addrLabel(payingEmail)) + '</li>'
        + '<li>survey address: ' + recoveryEsc(addrLabel(surveyEmail)) + '</li>'
        + '<li>restaurant now delivered: ' + recoveryEsc(restaurantName || '(not supplied)') + '</li>'
        + '<li>product: ' + recoveryEsc(product) + '</li></ul>'
        + '<p>Delivered to BOTH addresses. The survey row is claimed by=swap and the '
        + 'link is spent. One sale, one subscriber row.</p>'
        + '<p>Worth reading alongside the STALE EXACT alert for the same order, if there '
        + 'is one: together they say the matching rule picked a survey the buyer did not '
        + 'want, and which one they wanted instead.</p>',
    });
  } catch (e) { console.log('[alert] swap-used failed: ' + (e && e.message)); }
}

// ── /payment-webhook ─────────────────────────────────────────
//
// v8.11.10, THREE CHANGES, NONE OF THEM ENFORCEMENT.
//
// 1. A SECRET IS ACCEPTED, NOT REQUIRED. This route has never authenticated
//    anything: no secret, no signature, no allow-list, no rate limit, and it
//    answers 200 before it reads the body. Every paying customer this product
//    has exists because an unauthenticated POST said so. Requiring a secret
//    today would break every genuine Wix call the moment it deployed, because
//    the automation posts to the bare URL. So the secret is READ and LOGGED
//    and nothing is rejected. When RVP_WEBHOOK_SECRET is unset, or when a call
//    carries no secret, the call is processed exactly as it was before this
//    change. Requiring it is a later step, taken only once the log shows every
//    genuine call carrying one.
//
// 2. THE BODY IS NO LONGER LOGGED. `JSON.stringify(req.body)` wrote the
//    buyer's address, name and restaurant into the platform log on every call.
//    The store key dump was worse: reportStore is keyed BY email address, so
//    that line printed the address of everyone with a pending report. Both are
//    replaced by the shape of the body, key names and value types only.
//
// 3. THE RESPONSE IS UNCHANGED. Still 200 { ok: true }, still sent first.
//
// ── v8.11.22 [C2]: POINT 1 AND POINT 3 ABOVE NO LONGER HOLD ─────────────────
//
// The secret IS enforced now. Two production orders carried status=valid, on
// 2026-09-19 at 18:09Z and 20:29Z, so the automation is known to send it and
// the condition that made enforcement unsafe is gone.
//
// THE RESPONSE ORDER, WHICH IS THE PART TO READ CAREFULLY.
//
//   before:  res.status(200)  ->  read secret  ->  slow work
//   after:   read secret  ->  res.status(200 or 401)  ->  slow work
//
// Exactly one thing now precedes the response: reading req.params.secret and
// comparing two buffers with timingSafeEqual. No I/O, no await, no body
// parsing beyond what Express already did. A VALID call still gets its 200
// before HubSpot, Supabase, the peer comparison and every email, which is the
// property that keeps Wix from timing out and retrying during the ninety
// seconds the peer comparison takes.
//
// A rejected call gets a 401 and nothing else happens: no HubSpot write, no
// subscriber row, no email to the address in the body, no recovery link. The
// 401 is the point. Wix records the response in its Run Log, so the automation
// shows as failing instead of logging a success for a sale that never arrived.
async function handlePaymentWebhook(req, res) {
  // Secret status. The value is never logged.
  //
  // 2026-09-24: the body field webhookSecret is read FIRST and removed from the
  // body before anything logs or stores it; the URL path is read SECOND.
  // RVP_WEBHOOK_SECRET_NEXT, when set, is accepted too, for a rotation with no
  // refusal window (lib-pending.js webhookSecretCheck).
  const bodySecret = takeBodySecret(req.body);
  const chk = webhookSecretCheck({
    bodySecret,
    pathSecret: String((req.params && req.params.secret) || ''),
    current: process.env.RVP_WEBHOOK_SECRET,
    next: process.env.RVP_WEBHOOK_SECRET_NEXT,
    equal: (x, y) => { const a = Buffer.from(x), b = Buffer.from(y); return a.length === b.length && crypto.timingSafeEqual(a, b); },
  });
  const secretStatus = chk.status;
  const presented = { length: chk.presentedLen };
  const secretVia = 'presentedBy=' + chk.presentedBy + (chk.matched ? ' secret=' + chk.matched : '');
  const gate = webhookEnforcement(secretStatus);
  safeLog(() => `WEBHOOK_SECRET [webhook] status=${secretStatus} presentedBy=${chk.presentedBy}`
    + ` matched=${chk.matched || 'none'} presentedLen=${presented.length}`
    + ` enforcing=${gate.enforcing ? 'yes' : 'no'}`);

  if (gate.reject) {
    // Nothing below this line runs. The body is never parsed for an address,
    // so a forged call cannot cause an email to anyone.
    res.status(gate.httpStatus).json({ ok: false, error: 'unauthorized' });
    console.log('WEBHOOK_REJECTED [webhook] ' + gate.httpStatus
      + ' reason=' + gate.reason + ' presentedLen=' + presented.length);
    await alertWebhookProblem({
      kind: 'REJECTED payment webhook',
      detail: 'secret status: ' + secretStatus + ', presented length: ' + presented.length,
    });
    // v8.11.51 [B2.3]: AN UNAUTHENTICATED POST TO THE PAYMENT WEBHOOK IS
    // THE ONLY SIGNAL THAT SOMEBODY IS PROBING IT, and it existed only as
    // an alert email. The row carries the secret status and the presented
    // LENGTH, never the presented value.
    await writeOutcome(outcomeRecord({
      kind: 'webhook', secretStatus, secretVia, decision: 'refused',
      reason: 'rejected-secret-' + secretStatus + '-len=' + presented.length,
      delivered: false,
    }));
    return;
  }

  if (!gate.enforcing) {
    console.log('WEBHOOK_ENFORCEMENT [webhook] off: RVP_WEBHOOK_SECRET is not set, '
      + 'this call is processed exactly as v8.11.10 did');
  }

  res.status(200).json({ ok: true });

  safeLog(() => `WEBHOOK_SHAPE [webhook] body=${safeShape(req.body)}`);

  const body = req.body;
  if (!body) {
    console.log('[webhook] Empty body received');
    // v8.11.51 [B2.4]: recorded, because a POST that reached this far
    // carried a valid secret and is a real caller misbehaving.
    await writeOutcome(outcomeRecord({
      kind: 'webhook', secretStatus, secretVia, decision: 'none',
      reason: 'empty-body', delivered: false,
    }));
    return;
  }

  const payload = body.data || body;
  const email = (payload.email || payload.Email || payload.contactEmail || body.email || '').toLowerCase().trim();
  const product = payload.product || payload.Product || body.product || 'full';
  const firstName = payload.firstName || payload.first_name || body.firstName || '';

  if (!email) {
    safeLog(() => '[webhook] No email found in body, shape=' + safeShape(body));
    // v8.11.51 [B2.4]: a payment arrived that cannot be attributed to
    // anybody. That is the most expensive kind of unreadable call and it
    // left no row at all.
    await writeOutcome(outcomeRecord({
      kind: 'webhook', secretStatus, secretVia, decision: 'none',
      reason: 'no-email-in-body', delivered: false,
    }));
    return;
  }

  safeLog(() => '[webhook] Looking up domain: ' + maskAddr(email));

  // EXACT EMAIL MATCH ONLY. Two looser rules were removed in v8.9.37 and the
  // reason is worth keeping, because both looked reasonable.
  //
  // The removed rule 2 matched any stored email sharing an @ local part, so
  // info@restaurant-a.com resolved to info@restaurant-b.com.
  //
  // The removed rule 3 took the most recent report saved by ANYONE within five
  // minutes, matched on nothing at all, and then REDIRECTED delivery to the
  // survey email on the report it had found. So when customer A paid and the
  // rule latched onto customer B's report, the subscriber row, the report token
  // and the unlock email all went to B. A paid and received nothing; B received
  // an unlock for a purchase they never made. That is a billing failure wearing
  // the clothes of a matching bug, not a display bug.
  //
  // Rule 3 had a real motivation, recorded here so it is not rediscovered as an
  // oversight: Wix checkout uses the logged-in member account while the survey
  // uses whatever email the operator typed, so the two genuinely differ for
  // some customers. Removing it converts an unknown number of currently working
  // purchases into visible failures. It goes anyway, because the rule could not
  // distinguish "same person, different email" from "different person, same
  // five minutes" and resolved both identically. A rule that is right sometimes
  // and catastrophically wrong otherwise, with no way to tell which, is not a
  // rule.
  // v8.11.12: memory first, then the table, then the matcher.
  //
  // The Map is still the fast path and still authoritative when it hits: an
  // entry there is an EXACT address match by construction, because
  // /save-report keys it by the normalized survey address.
  //
  // v8.11.21 [C1]: AND IT MUST STILL BE FOR SALE.
  //
  // An entry is an exact match on ADDRESS. That says nothing about whether the
  // report has already been sold, and on 2026-09-19 it had been: the same
  // buyer paid twice from one address, two hours apart, on one process, and
  // received the first report both times. The second survey was never read.
  let memoryEntry = reportStore.get(email);
  let memoryVerdict = { trust: false, reason: 'no-entry' };
  if (memoryEntry) {
    const rowState = memoryEntry.spentAt
      ? null                                      // already decided; skip the query
      : await fetchPendingRowState({ id: memoryEntry.pendingId });
    memoryVerdict = memoryHitVerdict({ entry: memoryEntry, rowState });
    if (memoryVerdict.trusted) {
      console.log('MEMORY_TRUSTED [webhook] believed without checking the table reason='
        + memoryVerdict.reason + ' addr=' + addrLabel(email));
    } else if (!memoryVerdict.trust) {
      console.log('MEMORY_STALE [webhook] entry not for sale reason=' + memoryVerdict.reason
        + ' addr=' + addrLabel(email)
        + ' falling through to the table');
    }
  }

  // v8.11.29: EVERY OUTCOME OF THE MEMORY LOOKUP NOW SAYS SO.
  //
  // Before this, the ordinary successful memory hit printed NOTHING.
  // memoryHitVerdict returns { trust: true, reason: 'row-unclaimed' } with no
  // `trusted` flag, so it fell between the two branches above, and a lookup
  // that found nothing at all printed nothing either, because the whole block
  // is inside `if (memoryEntry)`.
  //
  // On 2026-09-20 that produced two purchases eight minutes apart with not one
  // memory line between them: the first was a healthy hit, the second was a
  // total miss, and the log was identical for both. The state that mattered
  // was the only state nobody could see.
  if (memoryVerdict.trust && !memoryVerdict.trusted) {
    console.log('MEMORY_HIT [webhook] entry found and still for sale reason='
      + memoryVerdict.reason + ' addr=' + addrLabel(email));
  } else if (!memoryEntry) {
    console.log('MEMORY_MISS [webhook] no entry for this address reason=no-entry'
      + ' addr=' + addrLabel(email) + ' going to the table');
  }

  let saved = memoryVerdict.trust ? memoryEntry : null;
  let matchDecision = saved ? 'exact' : null;
  let matchReason = saved ? 'memory-exact' : null;
  let claimedRowId = null;
  let surveyEmailForAlert = null;
  let candidatePool = [];
  let wouldHaveInferredId = null;
  let shadowAlert = false;

  // v8.11.17 [A1]: A MEMORY HIT MUST STILL RETIRE THE TABLE ROW.
  //
  // It used to deliver and never touch the table, leaving the row unclaimed
  // and therefore a live candidate for the next buyer:
  //
  //   11:30  Y finishes a survey
  //   12:00  X finishes a survey, pays from the SAME address, memory hit,
  //          delivered, row left UNCLAIMED
  //   12:05  Y pays from a DIFFERENT address. The window holds exactly one
  //          unclaimed row, X's, and Y is delivered X's report.
  //
  // Every step of the matcher was right. The row was never retired.
  if (saved) {
    candidatePool = await fetchPendingCandidates({ payingEmail: email, now: Date.now() });
  }

  if (!saved) {
    const now = Date.now();
    const candidates = await fetchPendingCandidates({ payingEmail: email, now });
    candidatePool = candidates;
    // v8.11.29: the matcher now REFUSES to rank candidates it cannot order,
    // and a refusal must not become a 500 on a purchase that has been paid
    // for. A throw here means the candidate rows arrived in a shape this
    // service did not build, which is an operator problem and not the buyer's:
    // treat it as "no match", alert, and let the recovery path carry them.
    let raw;
    try {
      raw = matchPendingReport({ payingEmail: email, candidates, now });
    } catch (e) {
      console.log('PENDING_UNORDERABLE [pending] the matcher refused the candidate rows: '
        + (e && e.message) + ' addr=' + addrLabel(email));
      await alertWebhookProblem({
        kind: 'unorderable-candidates',
        detail: 'matchPendingReport refused a candidate row. A paid order fell through to '
          + 'recovery instead of matching. ' + (e && e.message),
      });
      raw = { decision: 'none', match: null, reason: 'candidates-unorderable' };
    }
    // v8.11.18 [A2]: inference ships switched off. The matcher still computes
    // it, nothing is delivered on it, and the buyer goes down the recovery
    // path exactly as for "none". RVP_INFER_DELIVERY=true turns it on.
    const m = applyShadowMode({ result: raw, deliverInferred: process.env.RVP_INFER_DELIVERY });
    wouldHaveInferredId = m.wouldHaveInferredId;
    shadowAlert = m.alert;
    console.log('PENDING_MATCH [pending] decision=' + m.logDecision + ' reason=' + m.reason
      + ' candidates=' + candidates.length + ' domain=' + addrLabel(email)
      + ' deliverInferred=' + (process.env.RVP_INFER_DELIVERY === 'true' ? 'on' : 'off')
      + (m.wouldHaveInferredId ? ' wouldHaveChosen=' + m.wouldHaveInferredId : ''));
    if (m.match) {
      saved = {
        report: m.match.report || {},
        survey: m.match.survey || {},
        product: m.match.product || product,
        savedAt: m.match.saved_at,
      };
      matchDecision = m.decision;
      matchReason = m.reason;
      claimedRowId = m.match.id;
      surveyEmailForAlert = m.match.email_normalized;
    }
  }

  if (!saved) {
    // CACHE_MISS is greppable on purpose, and uptimeSec is the point of it.
    // reportStore is an in-memory Map wiped by every restart, so the hypothesis
    // is that misses cluster at LOW uptime and are caused by the cache being
    // empty rather than by emails mismatching. That is falsifiable rather than
    // plausible: misses at high uptime would mean genuine email mismatch and
    // would argue for a narrow rule matched on local part AND domain family.
    // The next few weeks of this log line settle it.
    safeLog(() => '[webhook] CACHE_MISS domain=' + maskAddr(email)
      + ' product=' + product
      + ' storeSize=' + reportStore.size
      + ' uptimeSec=' + Math.round(process.uptime()));

    // The payment is still recorded. Losing the HubSpot marker as well would
    // turn a delivery failure into a lost sale.
    await markPurchasedAndEmail(email, firstName || '', payload.restaurantName || '', {}, product);

    // v8.11.18 [A2]: shadow mode still alerts, so the rule can be watched.
    //
    // v8.11.20: GATED ON THE SECRET TOO. The ship gate asked whether a call
    // without a valid secret is processed exactly as in v8.11.10, and this was
    // the one place it was not: an unauthenticated POST triggered an outbound
    // internal email, which anybody could repeat to flood hello@. It is also
    // pointless, because a forged call's would-infer says nothing about
    // whether the rule is right for real orders. The PENDING_MATCH log line
    // stays on every call, because a log line amplifies nothing.
    if (shadowAlert && recoveryAllowed(secretStatus)) {
      const wouldRow = candidatePool.find(c => c && c.id === wouldHaveInferredId);
      await alertInferredMatch({
        payingEmail: email, surveyEmail: wouldRow && wouldRow.email_normalized,
        restaurantName: payload.restaurantName || '', product,
        reason: 'shadow-mode-not-delivered', shadow: true,
      });
    }

    // v8.11.18 [A3]: a recovery link is a bearer credential that fetches a
    // report, and the placeholder row is a line in the revenue table. The
    // webhook is still unauthenticated, so a forged post naming the
    // attacker's own address must earn NEITHER. Both are created only when
    // the call carried a VALID secret. Everything else here is exactly
    // v8.11.10 behaviour.
    const mayRecover = recoveryAllowed(secretStatus);
    if (mayRecover) {
      await recordUnmatchedSale({
        payingEmail: email, firstName: firstName || '',
        restaurantName: payload.restaurantName || '', product,
        wouldHaveInferredId,
      });
    } else {
      console.log('UNMATCHED_SALE [sale] skipped: secret status=' + secretStatus
        + ', no placeholder row and no recovery link on an unauthenticated call');
    }
    // v8.11.51 [B2.1]: THE SALE THAT MATCHED NOTHING IS NOW RECORDED.
    //
    // A real payment arrives, no survey matches, a placeholder row and a
    // cache-miss alert are written, and this handler returned before the
    // outcome write at the bottom. So rvp_outcomes, the table that exists
    // to make sales queryable, was missing EXACTLY THE SALES THAT WENT
    // WRONG. Measured 2026-09-22: two purchases, zero kind=webhook rows.
    await writeOutcome(outcomeRecord({
      kind: 'webhook', secretStatus, secretVia, decision: matchDecision,
      reason: 'unmatched-at-purchase' + (mayRecover ? '' : '-no-recovery-link'),
      payingEmail: email, surveyEmail: surveyEmailForAlert,
      delivered: false,
    }));
    await notifyCacheMiss({
      email, firstName, product,
      restaurantName: payload.restaurantName || '',
      offerRecovery: mayRecover,
    });
    return;
  }

  console.log('[webhook] Match type: ' + matchDecision + ' (' + matchReason + ')');

  const report     = saved.report || {};
  const survey     = saved.survey || {};
  const resolvedFirstName = firstName || survey.contactName || survey.firstName || '';
  const restaurant = survey.name || body.restaurantName || '';
  const location   = survey.location || '';

  // The paying email is the delivery address, full stop. This used to be
  // overridden to the survey email whenever the time-window rule had matched,
  // which is how a payment ended up credited to a different person. With exact
  // match only, the two are the same address by definition.
  const destEmail = email;

  safeLog(() => '[webhook] Payment confirmed for: ' + maskAddr(destEmail) + ' ' + product + ' | Restaurant: ' + restaurant);

  // ── B5: WHICH CONTACT IS MARKED PURCHASED ────────────────────────────
  //
  // THE PAYING ADDRESS, AND ONLY THAT ONE, ON EVERY PATH.
  //
  // The paying address is the customer of record: it is who the money came
  // from, who the receipt names, and who a refund would go to. On an exact
  // match the two addresses are the same, so nothing changes. On an inferred
  // or recovered match they differ, and marking BOTH would write
  // report_purchased=true onto a contact who has not bought anything, which
  // is the same class of error as v8.9.37's rule 3: a billing fact asserted
  // about the wrong person. In an inferred match the survey address is a
  // guess, and a guess must not become a CRM fact.
  //
  // The survey address is not lost: it is in the pending_reports row, named
  // by domain in the inferred and recovery alerts, and reachable by hand.
  // Attaching it to the HubSpot contact as a NOTE rather than a flag is the
  // right next step and is deliberately not done here, because it needs a
  // decision about what that note says when the match was a guess.
  await markPurchasedAndEmail(destEmail, resolvedFirstName, restaurant, report, product);

  // v8.11.51 [B2.2]: A PAID ORDER THAT PRODUCED NO REPORT.
  //
  // No subscriber row, no outcome row and one log line. That combination
  // is the hardest kind of failure to find later, because nothing
  // queryable records that the sale happened at all.
  if (!report || Object.keys(report).length === 0) {
    await writeOutcome(outcomeRecord({
      kind: 'webhook', secretStatus, secretVia, decision: matchDecision,
      reason: 'no-report-data', payingEmail: destEmail,
      surveyEmail: surveyEmailForAlert, delivered: false,
    }));
    console.log('[webhook] No report data — skipping full customer creation');
    return;
  }

  // Unified flow: both Annual and one-off go through createCustomer.
  const planType = product === 'annual' ? 'annual' : 'one_off';
  // v8.11.45: NULL. The hard-coded payload fallback is gone with it. The
  // payload has never carried an amount: if it had, the 99 stored rows would
  // not all be identical. Reconciling history from the Wix orders export is
  // package item 6 and is the source of truth for what was charged.
  const amountPaid = amountPaidToWrite();

  // v8.11.30: WHICH ROW IS ABOUT TO BE RETIRED, computed BEFORE delivery.
  //
  // The claim happens after delivery, deliberately, so a failed send leaves the
  // survey available to the recovery link rather than burning it. But the email
  // has to name the survey it is answering and count what else is waiting, and
  // both need the row identified first. selectRowToClaim is a pure function of
  // inputs that do not change in between, so calling it early and reusing the
  // answer cannot make the two disagree.
  const toClaim = selectRowToClaim({
    decision: matchReason, matchedRow: claimedRowId ? { id: claimedRowId } : null,
    payingEmail: email, candidates: candidatePool,
  });

  // Other surveys THIS BUYER has waiting, under the address they paid from.
  // The exact pull in fetchPendingCandidates returns unclaimed rows for the
  // paying address only, so this counts what the buyer could still be sent
  // without any address guessing at all. Surveys under a DIFFERENT address are
  // not counted here and are not this sentence's business: those are what the
  // swap link is for.
  const otherWaitingCount = candidatePool.filter(c =>
    c && c.claimed_at == null
    && normalizeEmail(c.email_normalized) === normalizeEmail(email)
    && (!toClaim || c.id !== toClaim.id)).length;
  const strandedRows = candidatePool.filter(c =>
    c && c.claimed_at == null
    && normalizeEmail(c.email_normalized) === normalizeEmail(email)
    && (!toClaim || c.id !== toClaim.id));
  if (strandedRows.length > 0) {
    console.log('STRANDED [pending] this delivery leaves ' + strandedRows.length
      + ' unclaimed survey(s) under the same address addr=' + addrLabel(email));
    await alertStrandedRows({ payingEmail: email, stranded: strandedRows.map(r => ({
      id: r.id, restaurantName: (r.survey && r.survey.name) || '' })) });
  }

  // v8.11.31: WAS THIS AN OLD SURVEY DELIVERED WHILE NEWER ONES WAITED?
  //
  // This is 2026-09-20 exactly. A 17 hour old FarmShop row was the only exact
  // match for the paying address, and two Drum & Monkey rows from four and
  // eight minutes earlier were under a different address and therefore
  // invisible to the rule that chose it. The rule was right. Nobody could see
  // that it had been asked the wrong question.
  //
  // Two hours is the threshold because a survey finished in the same sitting
  // as the payment is the ordinary case and must not alert. Anything older,
  // with something newer waiting, is worth one look.
  const STALE_EXACT_MS = 2 * 60 * 60 * 1000;
  const deliveredAgeMs = (saved && saved.savedAt) ? (Date.now() - Number(saved.savedAt)) : 0;
  if (Number.isFinite(deliveredAgeMs) && deliveredAgeMs > STALE_EXACT_MS) {
    const newerElsewhere = candidatePool.filter(c =>
      c && c.claimed_at == null
      && normalizeEmail(c.email_normalized) !== normalizeEmail(email)
      && Number(c.saved_at) > Number(saved.savedAt));
    if (newerElsewhere.length > 0) {
      console.log('STALE_EXACT [pending] delivered a survey ' + (deliveredAgeMs / 3600000).toFixed(1)
        + 'h old while ' + newerElsewhere.length + ' newer unclaimed survey(s) waited under other addresses');
      await alertStaleExact({
        payingEmail: email,
        delivered: { restaurantName: restaurant, ageMs: deliveredAgeMs },
        newerElsewhere: newerElsewhere.map(r => ({
          restaurantName: (r.survey && r.survey.name) || '',
          ageMs: Date.now() - Number(r.saved_at),
          email: r.email_normalized })),
      });
    }
  }

  // v8.11.37: CLAIM BEFORE DELIVER.
  //
  // The claim used to happen after delivery, which is what let two requests
  // both pass their checks and both deliver on 2026-09-20. Now the row is
  // taken atomically first, and only the request that gets exactly one row
  // back proceeds. A lost race stops here and delivers nothing.
  //
  // WHEN THERE IS NO ROW TO CLAIM, delivery still goes ahead: that is the
  // table-unreachable case, where the spent flag in memory is the only
  // surviving guard and has to be enough. Harness scenario A7g covers it.
  let claim = { claimed: false, mayDeliver: true, rows: null, reason: 'no-row-to-claim' };
  if (toClaim && toClaim.id) {
    claim = await claimPendingReport({ id: toClaim.id, claimedBy: matchDecision });
    if (!claim.mayDeliver) {
      console.log('WEBHOOK_LOST_RACE [webhook] the pending row was claimed by another call, '
        + 'delivering nothing reason=' + claim.reason + ' addr=' + addrLabel(email));
      await writeOutcome(outcomeRecord({
        kind: 'webhook', secretStatus, secretVia, decision: matchDecision, reason: 'lost-claim-race',
        payingEmail: email, surveyEmail: surveyEmailForAlert,
        pendingRowId: toClaim.id, delivered: false, claimRows: claim.rows,
      }));
      return;
    }
  }

  const delivered = await deliverPaidReport({
    destEmail, firstName: resolvedFirstName, restaurant,
    location, report, survey, product, planType, amountPaid,
    source: 'webhook-' + matchDecision,
    surveySavedAt: (saved && saved.savedAt) || null,
    otherWaitingCount,
    // v8.11.31: the swap link rides on the SAME gate that already decides
    // whether this call may be offered recovery at all. An unauthenticated
    // caller must never be handed a signed link, because the link is the
    // authority to be sent somebody's report.
    swapUrl: recoveryAllowed(secretStatus) ? buildRecoveryUrl(email) : null,
  });

  // The row is claimed only once delivery has succeeded, so a failure earlier
  // leaves the survey available to the recovery link rather than burning it.
  //
  // v8.11.17 [A1]: selectRowToClaim names the row for EVERY path, including
  // the memory hit that has no row object in hand. Best effort: a failure here
  // logs and never blocks a sale that has already been delivered.
  // The claim already happened. What is left is undoing it if the send failed,
  // so a survey is never burned by a delivery that did not occur.
  if (!delivered && claim.claimed && toClaim && toClaim.id) {
    await releasePendingClaim({ id: toClaim.id, claimedBy: matchDecision, reason: 'delivery-failed' });
  }
  await writeOutcome(outcomeRecord({
    kind: 'webhook', secretStatus, secretVia, decision: matchDecision, reason: matchReason,
    payingEmail: email, surveyEmail: surveyEmailForAlert,
    pendingRowId: toClaim && toClaim.id, deliveredRestaurant: restaurant,
    delivered: !!delivered, claimRows: claim.rows, strandedCount: strandedRows.length,
  }));

  if (delivered) {
    if (toClaim && toClaim.id) {
      // claimed above, before delivery
    } else {
      console.log('PENDING_CLAIM [pending] nothing to claim for this delivery path='
        + matchReason + ' candidates=' + candidatePool.length);
    }

    // v8.11.21 [C1]: the Map entry is retired too, on every path.
    //
    // The table claim above is not enough on its own. It fixes the NEXT
    // process and any process that reads the table, but this one would keep
    // answering from the Map until it restarts, which is precisely the two
    // hours and twenty minutes that separated the two Zulu deliveries.
    const token = delivered.subscriber && delivered.subscriber.reportToken;
    markMemorySpent({ email, token, reason: 'delivered-' + matchReason });
    // The survey address, when the match came from the table and the two
    // differ. That entry now names a report that has been sold as well.
    if (surveyEmailForAlert && normalizeEmail(surveyEmailForAlert) !== normalizeEmail(email)) {
      markMemorySpent({ email: surveyEmailForAlert, token, reason: 'delivered-' + matchReason + '-survey-side' });
    }
  }
  // G3: an inferred delivery is never silent.
  if (delivered && matchDecision === 'inferred') {
    await alertInferredMatch({
      payingEmail: destEmail, surveyEmail: surveyEmailForAlert,
      restaurantName: restaurant, product, reason: matchReason,
    });
  }
}


// Registered on both routes so Wix can move to the path-secret form without a
// code change. As of v8.11.22 both enforce the secret when one is configured.
app.post('/payment-webhook', handlePaymentWebhook);
app.post('/payment-webhook/:secret', handlePaymentWebhook);

// ── v8.11.23 [C3]: a path that reaches neither route is no longer silent ────
//
// 2026-09-19. The Wix automation was set to /payment-webhook<secret> with no
// slash between them. Express matched neither route above, returned its
// default 404, and this service logged NOTHING, because the handler was never
// entered. Every sale failed for part of an afternoon and the only evidence
// was a 404 line in Railway's edge log, which nobody looks at until something
// is already known to be wrong.
//
// Mounted immediately after the two real routes, so it sees only what they did
// not take. It calls next() for everything else and therefore cannot shadow a
// route defined later in the file.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const m = misroutedHint(req.path);
  if (!m.misrouted) return next();
  res.status(404).json({ ok: false, error: 'not found' });
  console.log('WEBHOOK_MISROUTED [webhook] 404 path=/payment-webhook[' + m.hint + '...]'
    + ' tailLen=' + m.tailLength
    + ' hasSlash=' + (req.path.charAt('/payment-webhook'.length) === '/' ? 'yes' : 'NO'));
  alertWebhookProblem({
    kind: 'REJECTED payment webhook',
    detail: 'misrouted path: /payment-webhook[' + m.hint + '...], '
      + m.tailLength + ' characters after the prefix, '
      + (req.path.charAt('/payment-webhook'.length) === '/'
          ? 'too many path segments' : 'NO SLASH before the secret'),
  }).catch(() => {});
});

// ── Update the stored payload after the comparison lands ───────────────────
// Swallows its own failure on purpose. The customer's report has already been
// created and the email is next; losing the comparison on the page is worse
// than losing it, but far better than losing the email.
async function patchBaselineReport(reportToken, report) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key || !reportToken) return false;
  try {
    const res = await fetch(url + '/rest/v1/subscribers?report_token=eq.' + encodeURIComponent(reportToken), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' },
      body: JSON.stringify({ baseline_report: report }),
    });
    if (!res.ok) { console.log('[webhook] baseline_report patch failed ' + res.status); return false; }
    return true;
  } catch (e) {
    console.log('[webhook] baseline_report patch failed:', e.message);
    return false;
  }
}

// ── GET SUBSCRIBER FROM SUPABASE ─────────────────────────────
async function getSubscriberFromSupabase(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(url + '/rest/v1/subscribers?email=eq.' + encodeURIComponent(email) + '&select=*', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
  } catch(e) {
    console.log('[supabase] getSubscriber failed:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS BENCHMARK CAPTURE (v8.9.24)
// ═══════════════════════════════════════════════════════════════════
// Third and last of the three ports, after SVP v0.14.0 and EVP v1.5.0. RVP
// differs structurally from both, and the differences are recorded here so a
// future session does not read the gaps as omissions:
//
//   source_assessment_id is STRUCTURALLY null, not a fallback. SVP and EVP each
//     persist an assessment row and stamp its id here. RVP persists no
//     assessment at all: the only Supabase writes in this service are to
//     subscribers, and the report is returned to the browser and never stored.
//     There is nothing to point at. Do not try to populate this column without
//     first giving RVP assessment persistence.
//
//   attribute_scores is null. RVP has six pillars and no attribute layer.
//
//   cohort_tier is null, deliberately, even though Phase 3 seeded four rvp/tier
//     values. Those values are grounded in detectFocalContext(), but that
//     function is a regex over scraped search snippets that fails open to null
//     with no confidence signal, and its output exists to build a competitor
//     search string which is then discarded. It is a query heuristic, not a
//     fact about the restaurant, and a league table would treat this column as
//     ground truth. The heuristic is carried in cohort_extra under
//     tier_heuristic, named so nobody mistakes it for an observation.
//
//   cohort_size_band, cohort_sector, cohort_subsector and cohort_region are
//     null: RVP captures no size concept, and getRegion() returns this
//     service's own query-routing regions, which are not the analytics
//     15-region vocabulary.
//
// This is also the first shared Supabase helper in this service. The six
// existing inline fetch calls against /rest/v1/subscribers are deliberately
// NOT refactored into it; that is a separate change.

// Coerces a model-supplied score into the integer 0-100 the table's CHECK
// constraint requires. Returns null when there is no usable number, so the
// caller can decide rather than silently recording a fabricated zero.
function toBenchmarkScore(value) {
  // Reject the absent cases EXPLICITLY rather than relying on Number() to make
  // them non-finite, because for two of them it does not.
  //
  // Number(null) is 0 and Number('') is 0, both finite, so a model that returns
  // a literal null or an empty string for healthCheckScore used to produce a
  // clamped 0 here. That 0 then passed the no_score guard in
  // benchmarkSkipReason, and a row landed with overall_score = 0: precisely the
  // poisoned cohort average the comment above that guard says it prevents.
  //
  // Number(undefined) is NaN and Number('abc') is NaN, so the omitted-field and
  // non-numeric cases already returned null. That asymmetry is why this survived
  // unnoticed: the common failure, a model omitting the field, worked correctly,
  // and only a literal null failed. No stored row has overall_score = 0, so it
  // never fired in production.
  //
  // NaN is listed below even though Number.isFinite already catches it. The
  // guard should say what it rejects rather than leave it to a chain of
  // coercions two lines apart.
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isNaN(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function buildBenchmarkRow({ report, name, location, country, region, focalContext, focalGeo, focalPlaceId, focalReviewCount, newestReviewAt }) {
  // Computed from the same six pillars the report prints, by the same function
  // the renderer uses. Two code paths that disagreed about a subject's score
  // would be worse than either being wrong.
  const rvpOverall = computeOverall(report && report.pillars);
  // report.pillars is { cs, pa, es, sm, cp, bg }, each { score, label, status }.
  const pillarScores = {};
  for (const [key, p] of Object.entries((report && report.pillars) || {})) {
    if (!p) continue;
    const s = toBenchmarkScore(p.score);
    if (s !== null) pillarScores[key] = s;
  }

  return {
    // Generated here rather than left to the column default, so the id is known
    // BEFORE the row is written and can be returned in the response. See the
    // note above the capture block in /diagnose for what that id does and does
    // not promise.
    id:               crypto.randomUUID(),

    product:          'rvp',
    subject_name:     String(name || '').slice(0, 200),

    // ── The stable identity, added in v8.11.8, migration 009 ──
    //
    // A Google place_id, captured at assessment and NEVER re-resolved from a
    // name. subject_name is not an identity: one Santiago restaurant is stored
    // here across 22 rows as "Bocanáriz" and "Bocanariz", which is two names
    // for one business and no way to tell from the data.
    //
    // Null when Places resolved nothing, which is honest rather than a gap to
    // fill later: re-deriving it from the name afterwards would recreate the
    // ambiguity the column exists to remove. Measured on the 126 rows written
    // since geocoding replaced parsing, Places resolved a coordinate every
    // time, so null should be rare.
    //
    // NOT subject_id, and the difference is deliberate:
    // bulk_run_assessments.subject_id is a uuid FK to bulk_run_subjects(id).
    // See the column comment in migration 009. subject_id is no longer sent by
    // this service; EVP and SVP still send it as null until they are updated,
    // which is why 009 adds rather than renames.
    subject_key:      focalPlaceId || null,

    // ── The subject's own Google review data (overnight 2026-09-26) ──
    //
    // user_ratings_total from the focal findplacefromtext candidate, the figure
    // the review gate reads (lib-review-gate.js). Until now it reached only
    // report._debug, where no later read of this row could find it. NEVER the
    // Serper knowledge-graph count in focalContext: on Zulu (2026-09-19) that
    // said 4,552 where Places said 625. No Places figure, null.
    //
    // subject_newest_review_at: RVP makes no Place Details call, so no review
    // date is read and this is null on every run today. It is written only
    // when a real date is present.
    //
    // BOTH COLUMNS NEED A MIGRATION THAT IS PRINTED, NOT RUN. insertTolerant
    // drops them and retries once if the insert names them as missing.
    subject_review_count:     (typeof focalReviewCount === 'number' && Number.isFinite(focalReviewCount) && focalReviewCount >= 0)
                                ? Math.round(focalReviewCount) : null,
    subject_newest_review_at: (newestReviewAt && Number.isFinite(Date.parse(newestReviewAt)))
                                ? new Date(Date.parse(newestReviewAt)).toISOString() : null,

    cohort_sector:    null,
    cohort_subsector: null,
    cohort_tier:      null,
    cohort_region:    null,

    // cohort_country and cohort_metro are GEOCODED, not parsed (v8.9.33).
    //
    // The comma parser takes the last comma-part of the location string as the
    // country, unconditionally. On a six-input sample it was right twice: it
    // yields country "Santiago" for "Santiago", "Austin" for "Austin", "NY" for
    // "Brooklyn, NY" and "London" for "Shoreditch, London". The geocoder was
    // right six times out of six.
    //
    // The parse is NOT removed. It still feeds getRegion, buildRegionQueries
    // and the annual path, which is a wider change than this one. Only the
    // stored row changes source.
    //
    // Consequence, recorded rather than hidden: stored cohort_country is now
    // inconsistent by design. Rows before v8.9.33 hold parsed values and rows
    // after hold geocoded ones, so a Phase 5 filter on country mixes two
    // populations. country_source below makes that detectable. Backfilling the
    // older rows is NOT the answer: it would mean re-deriving country from
    // location_raw with the same parser that is wrong four times in six.
    //
    // Both are null when Places could not resolve a coordinate. A null country
    // is honest about what is known; "Santiago" as a country is wrong in a way
    // that does not announce itself when something filters on it. That makes
    // the column sparser as well as more correct, which is the intended trade.
    cohort_country:   (focalGeo && focalGeo.country) || null,
    cohort_size_band: null,
    cohort_metro:     (focalGeo && focalGeo.metro) || null,
    cohort_extra: {
      location_raw:    String(location || '').trim() || null,
      query_region:    region || null,
      // Which component answered, because a metro from administrative_area_
      // level_1 is not the same kind of value as one from level 2.
      metro_source:    (focalGeo && focalGeo.metroSource) || null,
      // Distinguishes a v8.9.33 row from the 78 that came before it.
      country_source:  focalGeo ? 'geocoded' : null,
      // What the comma parser would have said, kept for comparison rather than
      // for use. It is the value that still drives query building.
      country_parsed:  String(country || '').trim() || null,
      cuisine_detected: (report && report.cuisineDetected) || null,
      price_detected:   (report && report.priceDetected) || null,
      // Heuristic, NOT an observation. See the note above cohort_tier.
      tier_heuristic:  (focalContext && focalContext.tier) || null,
      // THE BAND OF THIS ROW'S OWN SCORE, never the model's word. This read
      // report.scoreVerdict, which the model stopped writing at b13449b, so
      // every row from 8.11.52 on carried null beside a computed score, and
      // 6 of the 69 rows before it carried a verdict that disagreed with
      // their own band (overnight 2026-09-24, A4). No score, no verdict.
      score_verdict:   verdictFor(toBenchmarkScore(rvpOverall.score))
    },

    // v8.11.50: THE COMPUTED SCORE, AND THE ROW SAYS SO.
    //
    // This was toBenchmarkScore(report.healthCheckScore), the model's own
    // number, which runs about 6 points above the mean of the six pillars in
    // the same payload (102 of 103 stored reports, median +7).
    //
    // `benchmarks` is shared by EVP, SVP and RVP, and method_version exists to
    // keep the two measurements apart. Its column comment says it plainly:
    // NULL means model-typed, a non-null value names the code path, and any
    // median or ranking over this table should filter to one value of it. The
    // 308 RVP rows already in the table are model-typed and are correctly
    // NULL. From here they are computed and must say THAT, or the cohort
    // average drifts downward for a reason no query can see.
    //
    // NO SCORE MEANS NO ROW. overall_score is NOT NULL on this table, so the
    // choice is between skipping and inventing; benchmarkSkipReason already
    // skips on null. Writing the typed value here instead would put the number
    // this release exists to replace back into the cohort, for a report that
    // itself refuses to show a score.
    overall_score:    toBenchmarkScore(rvpOverall.score),
    method_version:   rvpOverall.ok ? OVERALL_METHOD_VERSION : null,
    pillar_scores:    pillarScores,
    attribute_scores: null,

    data_source:          'real_assessment',
    source_assessment_id: null,
    ai_seed_batch:        null,
    // confidence_level is NULL, deliberately, and must stay null until RVP
    // actually measures something.
    //
    // This column previously received report.scoreVerdict (Excellent / Good /
    // Fair / Needs Attention). That is a verdict ON the score, not a statement
    // about the evidence behind it, so it was the wrong field in the wrong
    // column and a Phase 5 filter on it would have been meaningless. Nothing is
    // lost by removing it: scoreVerdict is still returned in the report and is
    // still carried in cohort_extra.score_verdict above.
    //
    // RVP has no confidence concept anywhere in the restaurant path. The
    // confidence vocabulary elsewhere in this file belongs to the embedded EVP
    // v1.0, which does not write product='rvp' rows.
    //
    // DO NOT SUBSTITUTE empties[]. It is the obvious candidate and it does not
    // work: across sixteen runs on the fixed corpus pipeline it logged 6/6
    // categories succeeded every time, for every subject, while one subject's
    // STAFF result was neighbourhood labour-market text that never mentioned
    // the restaurant. A search returning text is not the same as the text being
    // about the subject. Presence is not relevance, and relevance is what drives
    // a defaulted score.
    //
    // What would have to exist first: a per-score signal that distinguishes
    // subject-specific evidence from generic filler. Today the only component
    // that makes that distinction is the model, in prose, while the score still
    // defaults. See the Phase 5 blockers section of the diagnostix-analytics
    // README before changing this.
    confidence_level:     null,
    expires_at:           null
    // created_at defaults automatically. id does NOT: it is generated above so
    // the caller can return it before the write happens.
  };
}

// Why a row would not be written, decided BEFORE the response is sent (v8.9.35).
//
// Three of the four no-write paths are synchronous: capture disabled, no usable
// score, no subject name. Only a Supabase failure is not knowable in advance.
// Separating the decision from the write lets /diagnose tell a caller "no row is
// coming, and here is why" immediately, instead of leaving it to infer that from
// a row that never appears.
//
// Returns null when the write will be attempted.
function benchmarkSkipReason(row) {
  if (!BENCHMARK_ENABLED) return 'capture_disabled';
  if (!row) return 'row_not_built';
  // A benchmarks row cannot record a null score (overall_score is NOT NULL), and
  // writing a clamped 0 would quietly poison every future cohort average, so
  // these rows are skipped instead.
  if (row.overall_score === null) return 'no_score';
  if (!row.subject_name) return 'no_subject_name';
  return null;
}

// Writes a row that has ALREADY been built. Split from construction in v8.9.35
// so the caller can hold the row, read its id, respond, and only then write.
//
// NEVER throws and never rethrows. Every failure path logs and returns false.
// A Supabase outage must never surface to a user who just ran an assessment.
async function writeBenchmarkRow(row) {
  try {
    const skip = benchmarkSkipReason(row);
    if (skip) {
      // Distinct greppable markers, preserved from the previous shape.
      const marker = skip === 'no_score' ? 'BENCHMARK_SKIP_NO_SCORE '
        : skip === 'no_subject_name' ? 'BENCHMARK_SKIP_NO_SUBJECT ' : '';
      console.warn(`${marker}[benchmark] write skipped: ${skip}` +
        (row && row.subject_name ? ` subject="${row.subject_name}"` : ''));
      return false;
    }

    const res = await insertTolerant(BENCHMARKS_TABLE, row, BENCHMARK_UNMIGRATED_KEYS);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[benchmark] write failed ${res.status}: ${txt.slice(0, 300)}`);
      return false;
    }

    console.log(`[benchmark] wrote rvp row id=${row.id} subject="${row.subject_name}" score=${row.overall_score} pillars=${Object.keys(row.pillar_scores).length} country=${row.cohort_country || 'null'} metro=${row.cohort_metro || 'null'}`);
    return true;
  } catch (err) {
    console.error('[benchmark] write error:', err.message || err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// EVP ASSESSMENT MODULE — v1.0
// ───────────────────────────────────────────────────────────────────
// Sister service to DiagnostiX. Produces Employer Brand & Employee Value
// Proposition assessments for B2B advisory clients (e.g., Sodexo pitching
// Goldman Sachs). Mirrors the Sodexo/Goldman deck structure: heatmap,
// 4-box matrix, peer benchmarking, verbatim quotes, strategic gaps.
//
// Endpoints:
//   POST /evp/diagnose  → run assessment
//   GET  /evp           → survey form (served via static index-evp.html)
//   GET  /evp/report?token=...  → persistent report viewer
//
// Storage: separate Supabase table `evp_subscribers` (not implemented in v1.0
// — uses in-memory store only). Pattern matches DiagnostiX so DB upgrade is trivial.
// ═══════════════════════════════════════════════════════════════════

const evpStore = new Map();  // token → { company, report, savedAt }

// ── EVP attribute catalogue ──────────────────────────────────────────
// 15 fixed attributes scored on importance + delivery, gap drives priority.
// Importance baselines come from industry-standard EVP research; the AI
// adjusts them based on sector + cohort context.
const EVP_ATTRIBUTES = [
  { id: 'comp',       label: 'Compensation & carry',         baselineImportance: 91 },
  { id: 'career',     label: 'Career acceleration',          baselineImportance: 86 },
  { id: 'prestige',   label: 'Prestige & brand',             baselineImportance: 82 },
  { id: 'exit',       label: 'Exit opportunity quality',     baselineImportance: 80 },
  { id: 'wlb',        label: 'Work-life balance',            baselineImportance: 82 },
  { id: 'alumni',     label: 'Alumni network value',         baselineImportance: 70 },
  { id: 'rto',        label: 'Earn the commute (RTO)',       baselineImportance: 78 },
  { id: 'wellbeing',  label: 'Wellbeing support',            baselineImportance: 76 },
  { id: 'dining',     label: 'Workplace dining quality',     baselineImportance: 74 },
  { id: 'manager',    label: 'Manager quality',              baselineImportance: 88 },
  { id: 'hospitality',label: 'Hospitality & environment',    baselineImportance: 71 },
  { id: 'learning',   label: 'Learning & development',       baselineImportance: 72 },
  { id: 'tech',       label: 'Technology & tools',           baselineImportance: 68 },
  { id: 'mobility',   label: 'Internal mobility',            baselineImportance: 65 },
  { id: 'dei',        label: 'DEI & belonging',              baselineImportance: 62 }
];

// ── EVP listening channels — Tier 1 (always run) ─────────────────────
// Each channel is a search-query builder that targets a specific source.
// Returns text blobs for AI synthesis. Mirrors the multi-layer Serper
// pattern from DiagnostiX competitor search.
function buildEvpQueries(company, country, sector) {
  const c = company;
  const loc = country || '';
  return {
    GLASSDOOR: [
      `${c} Glassdoor reviews ratings work-life balance compensation`,
      `${c} Glassdoor employee reviews ${loc}`,
      `${c} Glassdoor culture management benefits`
    ],
    INDEED: [
      `${c} Indeed employee reviews ${loc}`,
      `${c} Indeed work happiness score benefits`,
      `${c} Indeed salaries ratings`
    ],
    GREATPLACE: [
      `${c} "Great Place to Work" certified trust index`,
      `${c} Best Workplaces ranking certified`,
      `${c} Great Place to Work survey results`
    ],
    FORTUNE: [
      `${c} Fortune 100 Best Companies to Work For`,
      `${c} Fortune Best Workplaces ranking`,
      `${c} Fortune diversity ranking`
    ],
    LINKEDIN: [
      `${c} LinkedIn Top Companies ranking ${loc}`,
      `${c} LinkedIn employees headcount growth attrition`,
      `${c} LinkedIn talent insights`
    ],
    GOVSTATS: [
      `${sector} median salary ${loc} ${new Date().getFullYear()}`,
      `${sector} labor statistics employment ${loc}`,
      `${sector} wages benefits ${loc} Bureau Labor Statistics`
    ],
    SEC_NEWS: [
      `${c} 10-K human capital disclosure attrition turnover`,
      `${c} layoffs return to office RTO policy news`,
      `${c} compensation policy changes leadership`
    ]
  };
}

// ── runEvpScrape() — runs all Tier 1 channels in parallel ────────────
async function runEvpScrape({ company, country, sector }) {
  const queries = buildEvpQueries(company, country, sector);
  const t0 = Date.now();
  console.log(`[evp] scraping ${Object.keys(queries).length} channels for "${company}" (${sector}, ${country})...`);
  const [gd, ind, gptw, fortune, li, gov, sec] = await Promise.all([
    searchWithFallback(queries.GLASSDOOR,  { label: 'EVP-GLASSDOOR' }),
    searchWithFallback(queries.INDEED,     { label: 'EVP-INDEED' }),
    searchWithFallback(queries.GREATPLACE, { label: 'EVP-GPTW' }),
    searchWithFallback(queries.FORTUNE,    { label: 'EVP-FORTUNE' }),
    searchWithFallback(queries.LINKEDIN,   { label: 'EVP-LINKEDIN' }),
    searchWithFallback(queries.GOVSTATS,   { label: 'EVP-GOVSTATS' }),
    searchWithFallback(queries.SEC_NEWS,   { label: 'EVP-SEC-NEWS' })
  ]);
  const elapsed = Date.now() - t0;
  const channels = { gd, ind, gptw, fortune, li, gov, sec };
  const empties = Object.entries(channels).filter(([k,v]) => v === 'no data' || v === 'no api key' || v.startsWith('err:')).map(([k]) => k);
  console.log(`[evp] scrape complete: ${7 - empties.length}/7 succeeded, ${elapsed}ms` + (empties.length ? ` | EMPTY: ${empties.join(',')}` : ''));
  return {
    glassdoor: gd, indeed: ind, greatPlaceToWork: gptw, fortune: fortune,
    linkedin: li, governmentStats: gov, secAndNews: sec,
    elapsed, channelsSucceeded: 7 - empties.length
  };
}

// ── runEvpPeerSearch() — find talent competitors for benchmarking ────
// Mirrors searchCompetitorsMultiple from DiagnostiX. Auto-discovers talent
// competitors based on sector + uses any user-named ones as ground truth.
async function runEvpPeerSearch({ company, country, sector, peers }) {
  const userPeers = Array.isArray(peers)
    ? peers.slice(0, 5).filter(p => p && p.trim().length >= 2)
    : [];

  // Layer 1: user-named peers — each gets a dedicated structured search
  const userSearches = userPeers.map(peerName =>
    searchStructured(`${peerName} ${sector} Glassdoor reviews work life balance compensation`, { label: `EVP-PEER[${peerName}]` })
      .catch(() => ({ text: '', rating: null, reviewCount: null, title: null }))
  );

  // Layer 2: auto-discover similar-tier talent competitors
  const autoSearches = [
    searchWithFallback([
      `top ${sector} employers ${country} talent compensation`,
      `best ${sector} companies to work for ${country}`,
      `${company} competitors employer ranking`
    ], { label: 'EVP-AUTO-PEERS' })
  ];

  const t0 = Date.now();
  const [userResults, ...autoResults] = await Promise.all([
    Promise.all(userSearches),
    ...autoSearches
  ]);

  // Stitch into labeled sections for the AI synthesis
  const sections = [];
  for (let i = 0; i < userPeers.length; i++) {
    const r = userResults[i] || {};
    const hint = (r.rating !== null || r.reviewCount !== null)
      ? ` (Glassdoor signal: rating=${r.rating ?? 'n/a'}, reviewCount=${r.reviewCount ?? 'n/a'})`
      : '';
    sections.push(`[USER-NAMED-PEER: ${userPeers[i]}]${hint}\n${r.text || 'no data'}`);
  }
  sections.push(`[AUTO-DISCOVERED-PEERS]\n${autoResults[0]}`);

  const merged = sections.join('\n\n---\n\n');
  console.log(`[evp] peer scrape: ${userPeers.length} user-named + auto-discovery, ${Date.now()-t0}ms, ${merged.length}ch`);
  return { merged, userPeers, userResults };
}

// ── analyzeEvp() — Anthropic synthesis to produce the scored report ──
async function analyzeEvp({ company, country, sector, cohort, proposerProfile, scrapedData, peerData }) {
  const attributeList = EVP_ATTRIBUTES
    .map(a => `  - id="${a.id}" | label="${a.label}" | baseline_importance=${a.baselineImportance}`)
    .join('\n');

  // Compress scraped data to fit prompt budget
  const slice = (s, n) => String(s || '').slice(0, n);
  const dataBlob = [
    `GLASSDOOR:\n${slice(scrapedData.glassdoor, 2200)}`,
    `INDEED:\n${slice(scrapedData.indeed, 1500)}`,
    `GREAT PLACE TO WORK:\n${slice(scrapedData.greatPlaceToWork, 1200)}`,
    `FORTUNE BEST PLACES:\n${slice(scrapedData.fortune, 1200)}`,
    `LINKEDIN TOP COMPANIES:\n${slice(scrapedData.linkedin, 1200)}`,
    `GOVERNMENT LABOUR STATS:\n${slice(scrapedData.governmentStats, 1200)}`,
    `SEC FILINGS + RECENT NEWS:\n${slice(scrapedData.secAndNews, 1800)}`,
    `PEER BENCHMARK DATA:\n${slice(peerData.merged, 3500)}`
  ].join('\n\n---\n\n');

  const proposerBlock = proposerProfile && proposerProfile.trim()
    ? `\nPROPOSER PROFILE, the entity using this assessment to pitch ${company}:\n  ${proposerProfile.trim()}\n\nFor each top-5 critical gap, flag whether it falls within the proposer's service scope (\"proposerAddressable\": true/false). When true, write a 1-sentence \"rightToWin\" angle showing how the proposer can credibly close the gap.`
    : '';

  const prompt = `You are conducting an Employer Brand & Employee Value Proposition (EVP) assessment for ${company} (${sector} sector, ${country}). The target cohort is ${cohort || 'professional / mid-career employees'}.

You will receive raw scraped data from 7 listening channels plus peer benchmark data. Your job is to synthesise this into a structured, defensible EVP analysis.

EVP ATTRIBUTES (score each on 0 to 100 importance for this cohort, and 0 to 100 delivery by ${company}):
${attributeList}

RAW DATA:
${dataBlob}
${proposerBlock}

RULES:
1. Importance scores: start from each attribute's baseline_importance, adjust ±10 based on sector + cohort signals in the data. Cohorts in high-stress sectors (finance, consulting, law) weight WLB and wellbeing higher. Tech weights tech tools and learning higher.
2. Delivery scores: ground every score in scraped evidence. If Glassdoor WLB is 2.9/5, that maps to ~58/100 baseline; if Goldman 13 survey shows 98-hour weeks, drag it down to 28. Cite the source in evidence.
3. Gap = importance − delivery. Top-5 critical gaps are the most actionable.
4. Verbatims: 5 to 6 direct employee quotes pulled VERBATIM from the scraped data. Never invent quotes. Each quote must include source platform + sentiment + (optional) cohort label.
5. Peer benchmarking: identify 3 to 5 talent competitors from the peer data. For each, score workplace experience (0-100), compensation ceiling (0-100), prestige (0-100), work-life balance (0-100). Use user-named peers if present, supplement with auto-discovered.
6. Quadrant assignment: each attribute → one of {criticalGap, competitiveStrength, lowPriority, overInvestment} based on importance×delivery thresholds (importance >70 = high; delivery >55 = high).
7. Be honest about data thinness. If a channel returned no usable data, lower the confidence score and say so in methodology notes.

Return ONLY valid JSON in this exact schema (no preamble, no markdown):
{
  "company": "${company}",
  "sector": "${sector}",
  "country": "${country}",
  "cohort": "${cohort || 'professional / mid-career employees'}",
  "overallEvpScore": 50,
  "scoreVerdict": "one of: Strong / Solid / Mixed / Weak",
  "executiveSummary": "3-4 sentences citing real numbers from the data",
  "attributes": [
    {"id":"comp","label":"Compensation & carry","importance":91,"delivery":82,"gap":9,"evidence":"short citation from data","quadrant":"competitiveStrength"}
  ],
  "criticalGaps": [
    {"id":"wlb","label":"Work-life balance","gap":54,"importance":82,"delivery":28,"insight":"1-2 sentences","proposerAddressable":false,"rightToWin":""}
  ],
  "competitiveStrengths": [
    {"id":"prestige","label":"Prestige & brand","delivery":94,"importance":82,"insight":"1 sentence"}
  ],
  "verbatims": [
    {"text":"verbatim quote from data","source":"Glassdoor","sentiment":"negative","cohort":"analyst"}
  ],
  "peers": [
    {"name":"Morgan Stanley","workplaceExperience":52,"compensation":78,"prestige":88,"workLifeBalance":35,"note":"1 sentence comparison"}
  ],
  "peerInsight": "2-3 sentences on where ${company} sits in the competitive talent landscape",
  "talentContextStats": [
    {"stat":"360K+","label":"Applications for 2,600 internship spots","detail":"0.7% acceptance rate","tone":"neutral"}
  ],
  "strategicRecommendations": [
    {"priority":"urgent","title":"short title","description":"1-2 sentences","linkedGapIds":["wlb","wellbeing"]}
  ],
  "methodology": {
    "channelsSucceeded": ${scrapedData.channelsSucceeded},
    "channelsTotal": 7,
    "confidenceNote": "1-2 sentences on data confidence and any thinness",
    "sources": ["Glassdoor","Indeed","Great Place to Work","Fortune Best Places","LinkedIn Top Companies","Government Labour Statistics","SEC Filings + News"]
  }
}`;

  const t0 = Date.now();
  const raw = await claude(prompt, { label: 'evp-analyze', model: 'claude-sonnet-4-5-20250929' });
  console.log(`[evp] Claude synthesis: ${Date.now() - t0}ms`);

  // Parse JSON — Claude sometimes wraps responses in markdown code fences,
  // sometimes adds preamble like "Here is the analysis:", sometimes adds
  // trailing commentary. We try three increasingly-aggressive recovery
  // strategies before giving up.
  let json;
  const rawStr = String(raw);
  try {
    // Strategy 1: strip code fences anywhere, parse what remains
    let cleaned = rawStr.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    json = JSON.parse(cleaned);
  } catch (e1) {
    try {
      // Strategy 2: find the first '{' and the last '}', parse what's between
      const firstBrace = rawStr.indexOf('{');
      const lastBrace = rawStr.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const extracted = rawStr.slice(firstBrace, lastBrace + 1);
        json = JSON.parse(extracted);
      } else {
        throw new Error('no JSON object boundary found');
      }
    } catch (e2) {
      console.error('[evp] JSON parse failed after 2 recovery strategies:', e2.message);
      console.error('[evp] raw response (first 800ch):', rawStr.slice(0, 800));
      throw new Error('AI returned invalid JSON: ' + e2.message);
    }
  }

  // Sanity-check the shape — make sure we got at least the critical fields
  if (!json || typeof json !== 'object') {
    throw new Error('AI returned a non-object response');
  }
  if (!Array.isArray(json.attributes) || json.attributes.length === 0) {
    console.warn('[evp] AI returned no attributes array — report will be sparse');
  }

  return json;
}

// ── POST /evp/diagnose — main entry point ─────────────────────────────
app.post('/evp/diagnose', async (req, res) => {
  const t0 = Date.now();
  try {
    const body = req.body || {};
    const company = String(body.company || '').trim();
    const country = String(body.country || 'United States').trim();
    const sector = String(body.sector || 'Financial Services').trim();
    const cohort = String(body.cohort || '').trim();
    const proposerProfile = String(body.proposerProfile || '').trim();
    const peers = Array.isArray(body.peers) ? body.peers : (String(body.peers || '').split(/[,;]/).map(s => s.trim()).filter(Boolean));
    const email = String(body.email || '').trim();
    const contactName = String(body.contactName || '').trim();

    if (!company || company.length < 2) {
      return res.status(400).json({ error: 'company name required' });
    }
    console.log(`[evp] /diagnose START: company="${company}", sector="${sector}", country="${country}", cohort="${cohort || '(default)'}", peers=${peers.length}, proposer="${proposerProfile ? 'yes' : 'no'}"`);

    // Parallel: scrape + peer benchmark
    const [scrapedData, peerData] = await Promise.all([
      runEvpScrape({ company, country, sector }),
      runEvpPeerSearch({ company, country, sector, peers })
    ]);

    // AI synthesis
    const report = await analyzeEvp({ company, country, sector, cohort, proposerProfile, scrapedData, peerData });

    // Generate token + cache report for shareable URL
    const token = require('crypto').randomBytes(16).toString('hex');
    evpStore.set(token, {
      company, country, sector, cohort, proposerProfile, peers,
      email, contactName,
      report,
      scrapedData: {
        channelsSucceeded: scrapedData.channelsSucceeded,
        elapsed: scrapedData.elapsed
      },
      savedAt: Date.now()
    });
    // Keep store small: prune entries older than 7 days
    for (const [k, v] of evpStore.entries()) {
      if (Date.now() - v.savedAt > 7 * 24 * 60 * 60 * 1000) evpStore.delete(k);
    }

    report._token = token;
    report._reportUrl = `${process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app'}/evp/report?token=${token}`;
    report._debug = {
      version: '1.0',
      channelsSucceeded: scrapedData.channelsSucceeded,
      scrapeMs: scrapedData.elapsed,
      totalMs: Date.now() - t0
    };

    console.log(`[evp] /diagnose SUCCESS: ${Date.now() - t0}ms, token=${token.slice(0, 8)}...`);
    return res.status(200).json(report);
  } catch (e) {
    console.error('[evp] /diagnose FAILED:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /evp/report?token=... — persistent report viewer ──────────────
app.get('/evp/report', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token || token.length < 16) {
    return res.status(400).send(renderErrorPage('Invalid link', 'This EVP report link is malformed.'));
  }
  const stored = evpStore.get(token);
  if (!stored) {
    return res.status(404).send(renderErrorPage('Report not found', 'This EVP report has expired or was not found. EVP reports are kept for 7 days.'));
  }
  try {
    const html = renderEvpReportHtml(stored);
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch (e) {
    console.error('[evp/report] render error:', e.message);
    return res.status(500).send(renderErrorPage('Render error', e.message));
  }
});

// ── GET /evp — serve the survey form ─────────────────────────────────
app.get('/evp', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, 'public', 'index-evp.html'));
});

// ── renderEvpReportHtml() — server-side HTML render of EVP report ────
// Mirrors the structure of the Sodexo/Goldman deck: cover, talent stats,
// attribute heatmap, 4-box matrix, peer competitive map, verbatims,
// strategic recommendations, methodology block.
// DELIMITER WARNING, do not "clean" it. The character class in
// stored.proposerProfile.split() below uses an em-dash as a SEPARATOR, not as
// prose. It splits a profile like "Acme Partners, hospitality advisory" on
// whichever separator the user typed, and users type the dash form. Substituting
// it silently changes parsing and the split stops matching those profiles. Same
// class as competitors[].name in sanitizeReportProse: a dash that is a wire
// value rather than display text.
//
// This note used to live as an HTML comment inside the template literal below,
// which meant it was emitted into the customer's page source. Internal notes do
// not ship in markup.
function renderEvpReportHtml(stored) {
  const r = stored.report || {};
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const sortedAttrs = (r.attributes || []).slice().sort((a, b) => (b.gap || 0) - (a.gap || 0));
  const maxAbsGap = sortedAttrs.reduce((m, a) => Math.max(m, Math.abs(a.gap || 0)), 1) || 1;

  // ── Heatmap rows ─────────────────────────────────────────────────
  const heatmapRows = (r.attributes || []).map(a => {
    const imp = Math.max(0, Math.min(100, a.importance || 0));
    const del = Math.max(0, Math.min(100, a.delivery || 0));
    const gap = a.gap || 0;
    const gapColor = gap >= 30 ? '#C0392B' : gap >= 15 ? '#E67E22' : gap >= 0 ? '#95A5A6' : '#27AE60';
    return `<tr>
      <td style="font-size:13px;color:#1B1464;font-weight:600;padding:8px 12px 8px 0;width:200px">${esc(a.label)}</td>
      <td style="padding:8px 0;width:240px"><div style="background:#e8e3d8;border-radius:4px;height:20px;position:relative"><div style="background:#5B7BB8;height:20px;border-radius:4px;width:${imp}%"></div><span style="position:absolute;top:2px;right:6px;font-size:11px;color:#fff;font-weight:600">${imp}</span></div></td>
      <td style="padding:8px 12px;width:240px"><div style="background:#e8e3d8;border-radius:4px;height:20px;position:relative"><div style="background:#1B1464;height:20px;border-radius:4px;width:${del}%"></div><span style="position:absolute;top:2px;right:6px;font-size:11px;color:#fff;font-weight:600">${del}</span></div></td>
      <td style="font-size:14px;font-weight:700;color:${gapColor};text-align:right;padding:8px 0;width:80px">${gap > 0 ? '−' : '+'}${Math.abs(gap)}</td>
    </tr>`;
  }).join('');

  // ── Critical gaps cards ──────────────────────────────────────────
  const criticalGaps = (r.criticalGaps || []).slice(0, 5).map(g => {
    const proposerTag = g.proposerAddressable
      ? `<div style="display:inline-block;background:#F4B400;color:#1B1464;font-size:9px;font-weight:800;letter-spacing:0.1em;padding:3px 8px;border-radius:3px;text-transform:uppercase;margin-bottom:8px">PROPOSER ADDRESSABLE</div>`
      : '';
    const rightToWin = g.rightToWin
      ? `<div style="background:#f4f3fb;padding:10px 12px;border-radius:5px;border-left:3px solid #F4B400;margin-top:10px"><div style="font-size:9px;color:#F4B400;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">RIGHT TO WIN</div><div style="font-size:12px;color:#1B1464;line-height:1.5">${esc(g.rightToWin)}</div></div>`
      : '';
    return `<div style="background:#fff;border:1px solid #e8e3d8;border-top:3px solid #C0392B;border-radius:7px;padding:16px;display:flex;flex-direction:column">
      ${proposerTag}
      <div style="font-size:13px;font-weight:700;color:#1B1464;margin-bottom:6px">${esc(g.label)}</div>
      <div style="font-family:'League Spartan',sans-serif;font-size:1.9rem;font-weight:900;color:#C0392B;line-height:1;margin-bottom:4px">−${g.gap}<span style="font-size:11px;color:#999;font-weight:500"> pt gap</span></div>
      <div style="font-size:10px;color:#888;letter-spacing:0.06em;font-weight:600;text-transform:uppercase;margin-bottom:10px">importance ${g.importance} · delivery ${g.delivery}</div>
      <div style="font-size:12px;color:#555;line-height:1.55;flex:1">${esc(g.insight)}</div>
      ${rightToWin}
    </div>`;
  }).join('');

  // ── 4-box matrix ─────────────────────────────────────────────────
  const quadrantBuckets = {
    criticalGap: [], competitiveStrength: [], lowPriority: [], overInvestment: []
  };
  (r.attributes || []).forEach(a => {
    if (quadrantBuckets[a.quadrant]) quadrantBuckets[a.quadrant].push(a);
  });
  const quadrantBox = (title, subtitle, items, borderColor, bgColor) => {
    const itemsHtml = items.map(i => `<li style="font-size:12px;color:#1B1464;padding:3px 0;line-height:1.4">${esc(i.label)}</li>`).join('');
    return `<div style="background:${bgColor};border-left:4px solid ${borderColor};padding:16px 18px;border-radius:5px;min-height:160px">
      <div style="font-size:14px;font-weight:800;color:${borderColor};margin-bottom:4px;letter-spacing:0.02em">${title}</div>
      <div style="font-size:11px;color:#666;margin-bottom:10px;font-style:italic">${subtitle}</div>
      <ul style="margin:0;padding-left:18px;list-style:disc">${itemsHtml || '<li style="font-size:12px;color:#999;list-style:none;padding-left:0">None</li>'}</ul>
    </div>`;
  };

  // ── Peer competitive map ─────────────────────────────────────────
  const peerRows = (r.peers || []).slice(0, 7).map(p => {
    const wxColor = p.workplaceExperience >= 70 ? '#27AE60' : p.workplaceExperience >= 50 ? '#E67E22' : '#C0392B';
    const compColor = p.compensation >= 80 ? '#27AE60' : p.compensation >= 60 ? '#E67E22' : '#95A5A6';
    return `<tr>
      <td style="font-size:13px;color:#1B1464;font-weight:700;padding:10px 12px 10px 0">${esc(p.name)}</td>
      <td style="padding:10px 6px"><div style="background:#e8e3d8;border-radius:4px;height:18px;position:relative;width:140px"><div style="background:${wxColor};height:18px;border-radius:4px;width:${p.workplaceExperience || 0}%"></div><span style="position:absolute;top:1px;right:5px;font-size:10px;color:#fff;font-weight:700">${p.workplaceExperience || 0}</span></div></td>
      <td style="padding:10px 6px"><div style="background:#e8e3d8;border-radius:4px;height:18px;position:relative;width:140px"><div style="background:${compColor};height:18px;border-radius:4px;width:${p.compensation || 0}%"></div><span style="position:absolute;top:1px;right:5px;font-size:10px;color:#fff;font-weight:700">${p.compensation || 0}</span></div></td>
      <td style="padding:10px 6px;font-size:11px;color:#666;line-height:1.4">${esc(p.note || '')}</td>
    </tr>`;
  }).join('');

  // ── Verbatim quotes ──────────────────────────────────────────────
  const verbatimCards = (r.verbatims || []).slice(0, 6).map(v => {
    const sentColor = v.sentiment === 'negative' ? '#C0392B' : v.sentiment === 'positive' ? '#27AE60' : '#888';
    return `<div style="background:#f7f5f0;padding:14px 18px;border-radius:6px;border-left:3px solid ${sentColor}">
      <div style="font-size:13px;color:#1B1464;line-height:1.5;font-style:italic;margin-bottom:8px">&ldquo;${esc(v.text)}&rdquo;</div>
      <div style="font-size:10px;color:#888;font-weight:600;letter-spacing:0.04em;text-transform:uppercase">${esc(v.source || '')}${v.cohort ? ' · ' + esc(v.cohort) : ''}</div>
    </div>`;
  }).join('');

  // ── Talent context stat cards (top of report, like Sodexo deck p.2) ──
  const talentStats = (r.talentContextStats || []).slice(0, 3).map(s => {
    const tone = s.tone === 'negative' ? '#C0392B' : s.tone === 'positive' ? '#27AE60' : '#1B1464';
    return `<div style="background:#fff;border-top:3px solid ${tone};padding:18px 20px;border-radius:6px;flex:1;min-width:200px">
      <div style="font-family:'League Spartan',sans-serif;font-size:2.4rem;font-weight:900;color:${tone};line-height:1;margin-bottom:6px">${esc(s.stat)}</div>
      <div style="font-size:13px;color:#1B1464;font-weight:700;margin-bottom:4px">${esc(s.label)}</div>
      <div style="font-size:11px;color:#666;line-height:1.5">${esc(s.detail || '')}</div>
    </div>`;
  }).join('');

  // ── Strategic recommendations ────────────────────────────────────
  const recs = (r.strategicRecommendations || []).map((rec, i) => {
    const priColor = rec.priority === 'urgent' ? '#C0392B' : rec.priority === 'next30days' ? '#E67E22' : '#5B7BB8';
    const priLabel = rec.priority === 'urgent' ? 'URGENT' : rec.priority === 'next30days' ? '30 DAYS' : 'ONGOING';
    return `<div style="display:flex;gap:14px;margin-bottom:14px">
      <div style="font-family:'League Spartan',sans-serif;font-size:1.6rem;font-weight:900;color:#1B1464;width:32px;flex-shrink:0">${i+1}</div>
      <div style="flex:1">
        <div style="display:inline-block;background:${priColor};color:#fff;font-size:9px;font-weight:800;letter-spacing:0.1em;padding:3px 8px;border-radius:3px;margin-bottom:6px">${priLabel}</div>
        <div style="font-size:14px;color:#1B1464;font-weight:700;margin-bottom:4px">${esc(rec.title)}</div>
        <div style="font-size:12px;color:#555;line-height:1.55">${esc(rec.description)}</div>
      </div>
    </div>`;
  }).join('');

  const proposerLine = stored.proposerProfile
    ? `<div style="margin-top:6px;font-size:13px;color:rgba(255,255,255,0.85);font-style:italic">Strategic lens: ${esc(stored.proposerProfile)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(r.company)}, EVP Assessment</title>
<link href="https://fonts.googleapis.com/css2?family=League+Spartan:wght@600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f4f3fb;color:#1B1464;line-height:1.6;padding:20px 0}
.shell{max-width:1080px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(27,20,100,0.08)}
.cover{background:linear-gradient(135deg,#0f1b3d 0%,#1B1464 70%,#2D2E83 100%);padding:48px 56px;color:#fff}
.cover-tag{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#F4B400;font-weight:700;margin-bottom:14px}
.cover-title{font-family:'League Spartan',sans-serif;font-size:2.5rem;font-weight:900;line-height:1.1;margin-bottom:10px}
.cover-sub{font-size:15px;color:rgba(255,255,255,0.85);max-width:680px;line-height:1.55}
.cover-divider{width:60px;height:3px;background:#F4B400;margin-top:24px;margin-bottom:18px}
.cover-meta{display:flex;gap:32px;flex-wrap:wrap;font-size:12px;color:rgba(255,255,255,0.7);letter-spacing:0.04em;text-transform:uppercase}
.cover-meta strong{color:#fff;font-weight:600;text-transform:none;letter-spacing:0;margin-left:4px;font-size:13px}
.body{padding:40px 56px}
.section{margin-bottom:48px}
.section-h{font-family:'League Spartan',sans-serif;font-size:1.4rem;font-weight:800;color:#1B1464;margin-bottom:6px;border-bottom:2px solid #1B1464;padding-bottom:6px}
.section-sub{font-size:13px;color:#777;margin-bottom:20px;font-style:italic}
.exec-box{background:linear-gradient(135deg,#f4f3fb 0%,#fff 100%);border-left:4px solid #1B1464;padding:20px 24px;border-radius:6px;font-size:14px;line-height:1.7;color:#333}
.score-banner{display:flex;align-items:center;gap:24px;background:#1B1464;color:#fff;padding:24px 28px;border-radius:8px;margin-bottom:24px}
.score-num{font-family:'League Spartan',sans-serif;font-size:3.6rem;font-weight:900;line-height:1}
.score-label{font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.7)}
.score-verdict{font-size:1.4rem;font-weight:700;color:#F4B400;margin-top:4px}
.grid-stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:32px}
.grid-gaps{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.grid-quad{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid-verb{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
table{width:100%;border-collapse:collapse}
.methodology{margin-top:40px;padding:24px;background:#f7f5f0;border-radius:8px;font-size:12px;color:#666;line-height:1.7}
.methodology h4{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#1B1464;font-weight:800;margin-bottom:10px}
.methodology .src-pill{display:inline-block;background:#fff;border:1px solid #ddd;padding:4px 10px;border-radius:14px;font-size:11px;color:#555;margin:3px 4px 3px 0}
.footer{background:#0f1b3d;color:rgba(255,255,255,0.6);padding:24px 56px;font-size:11px;text-align:center;letter-spacing:0.04em}
.footer strong{color:#F4B400;font-weight:700}
@media (max-width:760px){.body{padding:28px 24px}.cover{padding:32px 24px}.cover-title{font-size:1.8rem}.grid-quad{grid-template-columns:1fr}.score-banner{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<div class="shell">

  <!-- COVER -->
  <div class="cover">
    <div class="cover-tag">EMPLOYER BRAND &amp; EVP ASSESSMENT</div>
    <div class="cover-title">${esc(r.company)}</div>
    <div class="cover-sub">A framework for understanding talent competition, workplace experience gaps, and strategic opportunity in the ${esc(r.sector || '')} sector.</div>
    ${proposerLine}
    <div class="cover-divider"></div>
    <div class="cover-meta">
      <div>Sector<strong>${esc(r.sector || 'N/A')}</strong></div>
      <div>Country<strong>${esc(r.country || 'N/A')}</strong></div>
      <div>Cohort<strong>${esc(r.cohort || 'Professional')}</strong></div>
      <div>Generated<strong>${new Date().toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })}</strong></div>
    </div>
  </div>

  <div class="body">

    <!-- OVERALL SCORE -->
    <div class="section">
      <div class="score-banner">
        <div>
          <div class="score-label">Overall EVP Strength</div>
          <div class="score-num">${r.overallEvpScore || 0}<span style="font-size:1.2rem;color:rgba(255,255,255,0.5);font-weight:500">/100</span></div>
          <div class="score-verdict">${esc(r.scoreVerdict || '')}</div>
        </div>
        <div style="flex:1;font-size:14px;line-height:1.65;color:rgba(255,255,255,0.92);padding-left:24px;border-left:1px solid rgba(255,255,255,0.15)">${esc(r.executiveSummary || '')}</div>
      </div>
    </div>

    <!-- TALENT CONTEXT STATS -->
    ${talentStats ? `<div class="section">
      <div class="section-h">The Talent Battleground</div>
      <div class="section-sub">Strategic context for ${esc(r.company)}'s position in the talent market</div>
      <div class="grid-stats">${talentStats}</div>
    </div>` : ''}

    <!-- EVP ATTRIBUTE HEATMAP -->
    <div class="section">
      <div class="section-h">EVP Attribute Heatmap</div>
      <div class="section-sub">Importance to talent vs. ${esc(r.company)}'s current delivery. The gap is the opportunity</div>
      <div style="background:#fff;border:1px solid #e8e3d8;border-radius:8px;padding:20px;overflow-x:auto">
        <table>
          <thead><tr>
            <th style="text-align:left;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:8px">Attribute</th>
            <th style="text-align:left;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:8px">Importance to Talent</th>
            <th style="text-align:left;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:8px;padding-left:12px">${esc(r.company)} Delivery</th>
            <th style="text-align:right;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:8px">Gap</th>
          </tr></thead>
          <tbody>${heatmapRows}</tbody>
        </table>
      </div>
    </div>

    <!-- CRITICAL GAPS -->
    ${criticalGaps ? `<div class="section">
      <div class="section-h">Critical Gaps, Fix Urgently</div>
      <div class="section-sub">High-importance attributes where ${esc(r.company)} significantly under-delivers</div>
      <div class="grid-gaps">${criticalGaps}</div>
    </div>` : ''}

    <!-- 4-BOX MATRIX -->
    <div class="section">
      <div class="section-h">4-Box EVP Positioning Matrix</div>
      <div class="section-sub">Where to act: prioritise by quadrant</div>
      <div class="grid-quad">
        ${quadrantBox('Critical Gaps', 'High value · Low delivery, fix or lose talent', quadrantBuckets.criticalGap, '#C0392B', '#fef5f3')}
        ${quadrantBox('Competitive Strengths', 'High value · High delivery, protect, don&rsquo;t over-invest', quadrantBuckets.competitiveStrength, '#27AE60', '#f3faf5')}
        ${quadrantBox('Low Priority', 'Low value · Low delivery, table stakes only', quadrantBuckets.lowPriority, '#95A5A6', '#f7f8f9')}
        ${quadrantBox('Over-Investment Risk', 'Low value · High delivery, rationalise', quadrantBuckets.overInvestment, '#E67E22', '#fef9f3')}
      </div>
    </div>

    <!-- PEER COMPETITIVE MAP -->
    ${peerRows ? `<div class="section">
      <div class="section-h">Competitive Positioning vs. Talent Competitors</div>
      <div class="section-sub">Where ${esc(r.company)} sits on dimensions that drive hiring and retention</div>
      <div style="background:#fff;border:1px solid #e8e3d8;border-radius:8px;padding:18px;overflow-x:auto">
        <table>
          <thead><tr>
            <th style="text-align:left;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:10px">Peer</th>
            <th style="text-align:left;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:10px;padding-left:6px">Workplace Experience</th>
            <th style="text-align:left;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:10px;padding-left:6px">Compensation Ceiling</th>
            <th style="text-align:left;font-size:10px;color:#888;letter-spacing:0.1em;text-transform:uppercase;padding-bottom:10px;padding-left:6px">Note</th>
          </tr></thead>
          <tbody>${peerRows}</tbody>
        </table>
      </div>
      ${r.peerInsight ? `<div style="margin-top:14px;padding:14px 18px;background:#f4f3fb;border-radius:6px;font-size:13px;color:#333;line-height:1.65">${esc(r.peerInsight)}</div>` : ''}
    </div>` : ''}

    <!-- VERBATIMS -->
    ${verbatimCards ? `<div class="section">
      <div class="section-h">What Employees Actually Say</div>
      <div class="section-sub">Verbatim quotes from published surveys, Glassdoor and analyst reports</div>
      <div class="grid-verb">${verbatimCards}</div>
    </div>` : ''}

    <!-- STRATEGIC RECOMMENDATIONS -->
    ${recs ? `<div class="section">
      <div class="section-h">Strategic Recommendations</div>
      <div class="section-sub">${stored.proposerProfile ? 'Where ' + esc(stored.proposerProfile.split(/[,—-]/)[0].trim()) + ' has the right to win' : 'Priority actions to close the gaps'}</div>
      <div style="background:#fff;border:1px solid #e8e3d8;border-radius:8px;padding:24px">${recs}</div>
    </div>` : ''}

    <!-- METHODOLOGY -->
    <div class="methodology">
      <h4>Methodology &amp; Sources</h4>
      <p style="margin-bottom:12px">${esc(r.methodology?.confidenceNote || 'Scores derived from synthesis of multiple listening channels.')} <strong style="color:#1B1464">Data confidence: ${r.methodology?.channelsSucceeded || 0}/${r.methodology?.channelsTotal || 7} listening channels returned usable data.</strong></p>
      <div style="margin-bottom:8px"><strong style="color:#1B1464;font-size:11px;letter-spacing:0.08em;text-transform:uppercase">Sources consulted:</strong></div>
      <div>${(r.methodology?.sources || []).map(s => `<span class="src-pill">${esc(s)}</span>`).join('')}</div>
      <p style="margin-top:14px;font-size:11px;font-style:italic;color:#888">EVP Assessment is an analytical estimate, not statistically validated research. Importance and delivery scores represent best-effort synthesis of publicly available employer-brand signals. Designed to structure strategic thinking and inform proposal positioning. Update as new survey data becomes available.</p>
    </div>

  </div>

  <div class="footer">
    <strong>EVP Assessment</strong> &middot; powered by 4xi Global Consulting &middot; data through ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long' })}
  </div>

</div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════
// END EVP ASSESSMENT MODULE
// ═══════════════════════════════════════════════════════════════════

// ── v8.11.49: THE MODULE CAN BE IMPORTED WITHOUT BEING STARTED ─────────────
//
// WHY. Every subscriber write in this service lives in a function in this
// file, and until now no test could reach any of them: importing server.js
// bound port 3000, so the only tests that existed were written against a
// re-implementation of the rule rather than against the rule. A test that
// restates the code it is testing cannot fail on the code being wrong, and an
// overnight run left a stray listener on port 3000 for eleven hours proving
// exactly how this gets exercised by accident.
//
// THE GUARD IS OPT-OUT, NOT AUTO-DETECTED. An argv[1] check would be tidier
// and would silently stop serving if Railway ever started this file by any
// route other than `node server.js`. Production sets nothing and listens
// exactly as before; only a test sets RVP_IMPORT_ONLY.
if (process.env.RVP_IMPORT_ONLY === '1') {
  console.log(`DiagnostiX v${VERSION} imported without listening (RVP_IMPORT_ONLY)`);
} else {
  app.listen(PORT, () => console.log(`DiagnostiX v${VERSION} + EVP v1.0 on port ${PORT}`));
}

// ── THE TEST SEAM ──────────────────────────────────────────────────────────
//
// Exported for tests only. Nothing in this service imports server.js, so
// these exports add no production code path; they make the subscriber write
// functions reachable so a test can count what they really do.
//
// They take no injected client: each one reads SUPABASE_URL and SUPABASE_KEY
// from the environment and calls global fetch, so a test points the env at an
// unroutable host and replaces globalThis.fetch. That keeps the seam at the
// boundary the code already has instead of adding a parameter for the test.
export const __test__ = {
  // Replaces the module's fetch and hands back a restore function, so a test
  // cannot leave the real one swapped out for the files that run after it.
  setFetch(fn) { const was = fetch; fetch = fn; return () => { fetch = was; }; },
  setClaude(fn) { const was = claude; claude = fn; return () => { claude = was; }; },
  getClaude() { return claude; },
  // The express app, so a test can POST to a REAL route on an ephemeral port.
  // RVP_IMPORT_ONLY stops the module listening; the test listens on port 0.
  app,
  writeExecutiveSummary,
  sendEmailViaResend,
  MODEL_TIMEOUT_MS_DEFAULT,
  SUMMARY_TARGET_WORDS,
  SUMMARY_MAX_WORDS,
  // Exposed so the ship gate can render a real report page in a real browser
  // rather than asserting on a string this file also builds.
  renderReportHtml,
  serveScoreLib,
  writeOrderRow,
  // The places that RECORD a score outside the page, so a test can read back
  // the exact value each one sends.
  sendInternalSummaryEmail,
  saveToHubSpot,
  markPurchasedAndEmail,
  pushReportContextToHubSpot,
  // The delivery path and the sentence it writes when there is no comparison.
  deliverPaidReport,
  PEER_COMPARISON_ABSENT,
  handlePaymentWebhook,
  buildBenchmarkRow,
  benchmarkSkipReason,
  writeBenchmarkRow,
  writeOutcome,
  createCustomer,
  findOrderRow,
  // The dash backstop, exposed so its two sides can be asserted: that it
  // converts what the prompt rule failed to prevent, and that it is not what
  // hard coded template copy relies on.
  stripDashes,
  sanitizeReportProse,
  writeSubscribers,
  VERSION,
};
