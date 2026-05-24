import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const reportStore = new Map();
const annualSubscribers = new Map();

// ── SHARED HELPERS (Serper + Claude) ─────────────────────────
// Lifted out so both /diagnose and generateProgressReport can use them.
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
    (d.organic||[]).slice(0,8).forEach(i => { o += `${i.title}: ${i.snippet||''}\n`; });
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
    (d.organic||[]).slice(0,8).forEach(i => {
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

// searchWithFallback() — try progressive queries until one yields substantive content.
// `queries` is an array ordered from most-specific to most-general.
// Returns the first result with > MIN_CHARS of content. If all fall below threshold,
// returns the best (longest) attempt rather than 'no data'.
// MIN_CHARS = 120: filters out lone knowledge-graph one-liners that don't give the AI
// enough to triangulate from. Tune up if reports remain thin; tune down if too aggressive.
const FALLBACK_MIN_CHARS = 120;
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
  const { name, location, region, userCompetitors } = opts;

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

  console.log(`[serper] COMP-MULTI locale: searchLoc="${searchLoc}", neighborhood="${neighborhood || '(none)'}"`);

  // Layer 1: User-supplied competitors. Each name gets 2 parallel searches
  // using searchStructured() which extracts rating/reviewCount directly from
  // Serper's knowledgeGraph and from organic-result snippets. This is more
  // reliable than asking the AI to text-parse the same data, and gives us
  // authoritative rating data we can inject directly into the response.
  //
  // Returns structured per-competitor data alongside the text blob.
  const userNames = Array.isArray(userCompetitors)
    ? userCompetitors.slice(0, 3).filter(n => n && n.trim().length >= 3)
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
    const results = await Promise.all(queries.map(q =>
      searchStructured(q, { label: `COMP-USER[${competitorName}]` })
        .catch(e => { console.log(`[serper] COMP-USER[${competitorName}] error: ${e.message}`); return { text: '', rating: null, reviewCount: null, title: null }; })
    ));
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
    console.log(`[serper] COMP-USER[${competitorName}] aggregated: rating=${bestRating} count=${bestCount} title="${bestTitle||''}" ${Date.now()-t}ms`);
    return {
      userName: competitorName,
      resolvedTitle: bestTitle,
      rating: bestRating,
      reviewCount: bestCount,
      text
    };
  }

  const userSearches = userNames.map(n => lookupUserNamed(n));

  // Layer 2: "Similar to X" — Google often surfaces "people also search for"
  // panels here, which are great signals for direct concept-overlap competitors.
  const similarSearches = [
    searchWithFallback(
      region === 'LATAM'
        ? [
            `restaurantes similares a ${name} ${searchLoc}`,
            `alternativas a ${name} ${searchLoc}`,
            `restaurants like ${name} ${searchLoc}`
          ]
        : [
            `restaurants like ${name} ${searchLoc}`,
            `restaurants similar to ${name} ${searchLoc}`,
            `alternatives to ${name} ${searchLoc}`
          ],
      { label: 'COMP-SIMILAR' }
    )
  ];

  // Layer 3: Neighborhood-narrowed (only when location has 3+ parts and the
  // first part is a true neighborhood rather than a city).
  const neighborhoodSearches = neighborhood ? [
    searchWithFallback(
      region === 'LATAM'
        ? [
            `mejores restaurantes ${neighborhood} ${stateOrRegion}`,
            `restaurantes ${neighborhood}`,
            `dónde comer ${neighborhood}`
          ]
        : [
            `best restaurants ${neighborhood} ${stateOrRegion}`,
            `top restaurants ${neighborhood}`,
            `where to eat ${neighborhood}`
          ],
      { label: 'COMP-NEIGHBORHOOD' }
    )
  ] : [];

  // Layer 4: Broad "top restaurants" — last-mile fallback to ensure we always
  // have at least one usable result even when other layers fail.
  const topSearches = [
    searchWithFallback(
      region === 'LATAM'
        ? [
            `mejores restaurantes ${searchLoc} TripAdvisor`,
            `top restaurants ${searchLoc}`,
            `restaurantes recomendados ${searchLoc}`
          ]
        : [
            `top restaurants ${searchLoc} TripAdvisor`,
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
  const t0 = Date.now();
  const [userResults, ...otherResults] = await Promise.all([
    Promise.all(userSearches),
    ...similarSearches,
    ...neighborhoodSearches,
    ...topSearches
  ]);
  const elapsed = Date.now() - t0;

  // Stitch together with provenance labels so the AI can see which pile each
  // chunk came from. User-supplied names get priority placement at the top.
  const sections = [];
  let otherIdx = 0;
  for (const userResult of userResults) {
    const ratingHint = (userResult.rating !== null || userResult.reviewCount !== null)
      ? ` (extracted rating=${userResult.rating ?? 'n/a'}, reviews=${userResult.reviewCount ?? 'n/a'})`
      : '';
    sections.push(`[USER-NAMED: ${userResult.userName}]${ratingHint}\n${userResult.text}`);
  }
  sections.push(`[SIMILAR-TO]\n${otherResults[otherIdx++]}`);
  if (neighborhoodSearches.length) sections.push(`[NEIGHBORHOOD]\n${otherResults[otherIdx++]}`);
  sections.push(`[TOP-IN-CITY]\n${otherResults[otherIdx++]}`);

  const merged = sections.join('\n\n---\n\n');
  const ratingsFound = userResults.filter(r => r.rating !== null).length;
  console.log(`[serper] COMP-MULTI: ${sections.length} layers, ${userNames.length} user-named (${ratingsFound} with ratings), ${elapsed}ms, ${merged.length}ch`);
  return { merged, userNames, userResults };
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
// for both /diagnose and generateProgressReport.
async function claude(prompt, opts) {
  opts = opts || {};
  const maxTokens         = opts.maxTokens         || 8000;
  const retryOnParseFail  = opts.retryOnParseFail  !== false; // default true
  const label             = opts.label             || 'claude';
  const model             = opts.model             || 'claude-sonnet-4-5-20250929';

  const ak = process.env.ANTHROPIC_API_KEY;
  if (!ak) throw new Error('ANTHROPIC_API_KEY missing');

  // Single Anthropic call — returns {ok:true,data,stopReason} or {ok:false,...diag}
  async function callOnce(tokenBudget, extraInstruction) {
    const systemPrompt = 'You are a JSON API. Output ONLY valid JSON. No markdown. No backticks. Start with { end with }. CRITICAL: All text values in the JSON must be written in English, regardless of the language of the source data or the restaurant\'s location.'
      + (extraInstruction ? ' ' + extraInstruction : '');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
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
      })
    });

    // Read body as text first so we can log it on failure (Anthropic 5xx etc.).
    const rawBody = await r.text();
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

  // Attempt 1: normal budget.
  let result = await callOnce(maxTokens);
  if (result.ok) return result.data;

  console.log(`[${label}] parse failed on attempt 1 — stop_reason=${result.stopReason}, length=${result.length}ch, truncated=${result.truncated}, preview="${result.preview}"`);

  if (!retryOnParseFail) {
    throw new Error('JSON parse failed (no retry): ' + result.preview);
  }

  // Attempt 2: larger budget + concise-output reinforcement.
  console.log(`[${label}] retrying with max_tokens=16000 and length reinforcement...`);
  result = await callOnce(16000, 'Your previous attempt was truncated. Keep all string values concise (1-2 sentences max per field). Return ONLY valid JSON.');

  if (result.ok) {
    console.log(`[${label}] retry succeeded`);
    return result.data;
  }

  console.log(`[${label}] retry also failed — stop_reason=${result.stopReason}, length=${result.length}ch, preview="${result.preview}"`);
  throw new Error('JSON parse failed after retry: ' + result.preview);
}

// ── EMAIL VIA RESEND ─────────────────────────────────────────
async function sendEmailViaResend({ to, subject, html, fromName, bcc }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || 'reports@4xi360.com';
  if (!key) {
    console.log('[email] RESEND_API_KEY missing — skipping send to', to);
    return { ok: false, reason: 'missing key' };
  }

  const payload = {
    from: (fromName || 'DiagnostiX') + ' <' + from + '>',
    to: [to],
    subject,
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
    console.log('[email] sent to', to, bcc ? '| bcc: ' + (Array.isArray(bcc) ? bcc.join(',') : bcc) : '', '| id:', result.id);
    return result;
  }

  // Retry once on transient errors after a 2s backoff
  if (result.retryable) {
    console.log('[email] transient failure — retrying in 2s:', result.reason);
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = await attempt();
    if (result.ok) {
      console.log('[email] sent to', to, bcc ? '| bcc: ' + (Array.isArray(bcc) ? bcc.join(',') : bcc) : '', '| id:', result.id, '(after retry)');
      return result;
    }
    console.log('[email] retry also failed:', result.reason);
  }

  return result;
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
  const score = report?.healthCheckScore ?? 0;
  const verdict = report?.scoreVerdict || '';
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
    ? 'Full Report ($49.99)'
    : `Annual Subscription ($99.99) — Report ${reportNumber || 1} of 3`;
  const subject = `[DiagnostiX] New ${planLabel} report: ${restaurant}${location ? ' (' + location + ')' : ''} — Score ${score}`;

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
    <strong>Location:</strong> ${escE(location || '—')}<br>
    ${cuisine ? `<strong>Cuisine:</strong> ${escE(cuisine)}<br>` : ''}
    ${price ? `<strong>Price:</strong> ${escE(price)}<br>` : ''}
    <strong>Submitted by:</strong> ${escE(ownerName || '—')} (${escE(ownerEmail)})<br>
    <strong>Plan:</strong> ${escE(reportTag)}<br>
    <br>
    <strong>Overall Score:</strong> <span style="font-weight:900;color:${score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24'}">${score} / 100</span> ${verdict ? '— ' + escE(verdict) : ''}<br>
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
    res.json({ status: 'running', version: '8.9.11' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '8.9.11' });
});

app.get('/test', async (req, res) => {
  const ak = process.env.ANTHROPIC_API_KEY;
  const sk = process.env.SERPER_API_KEY;
  const result = { ak_present: !!ak, ak_prefix: ak ? ak.slice(0,15)+'...' : 'MISSING', sk_present: !!sk };
  if (ak) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] })
      });
      const d = await r.json();
      result.ak_status = r.status;
      result.ak_ok = !d.error;
      if (d.error) result.ak_error = d.error.message;
    } catch(e) { result.ak_error = e.message; }
  }
  res.json(result);
});

// ── /diagnose ────────────────────────────────────────────────
app.post('/diagnose', async (req, res) => {
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
    const userCompetitorsRaw = String(body.competitors || '');
    const userCompetitors = userCompetitorsRaw
      .split(/[,;]/)
      .map(s => s.trim())
      .filter(s => s.length >= 3 && s.length <= 60);
    if (userCompetitors.length) {
      console.log(`[diagnose] user-named competitors: ${userCompetitors.join(' | ')}`);
    }

    console.log('[diagnose] searching...');
    const [g,rv,st,so,dl,compResult] = await Promise.all([
      searchWithFallback(queries.GOOGLE,      { label: 'GOOGLE' }),
      searchWithFallback(queries.REVIEWS,     { label: 'REVIEWS' }),
      searchWithFallback(queries.STAFF,       { label: 'STAFF' }),
      searchWithFallback(queries.SOCIAL,      { label: 'SOCIAL' }),
      searchWithFallback(queries.DELIVERY,    { label: 'DELIVERY' }),
      searchCompetitorsMultiple({ name, location, region, userCompetitors })
    ]);
    const co = compResult.merged;
    const compUserResults = compResult.userResults || [];
    const web = `GOOGLE:${g}\nREVIEWS:${rv}\nSTAFF:${st}\nSOCIAL:${so}\nDELIVERY:${dl}\nCOMPETITORS:${co}`;
    // Scraping summary: count which categories returned 'no data' so empty-report cases are visible in logs.
    const cats = { GOOGLE:g, REVIEWS:rv, STAFF:st, SOCIAL:so, DELIVERY:dl, COMPETITORS:co };
    const empties = Object.entries(cats).filter(([k,v]) => v === 'no data' || v === 'no api key' || v.startsWith('err:')).map(([k]) => k);
    const ok = 6 - empties.length;
    console.log(`[diagnose] scraping summary: ${ok}/6 succeeded, ${Date.now()-tSearch}ms total, ${web.length} chars` + (empties.length ? ` | EMPTY: ${empties.join(',')}` : ''));
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

CRITICAL — INTEGRATE QUALITATIVE WITH QUANTITATIVE, BUT ONLY FOR METRICS THE USER SHARED:
A metric marked "Not tracked (user opted out)" means the user did NOT share that number. You MUST NOT mention or analyze it. Do NOT speculate about its value. Do NOT include it in businessRealityAnalysis. Return empty string "" for its pillarGapNarratives entry.

For metrics the user DID share (those with a percentage value): blend them with the qualitative pillar scores and web data to produce holistic findings. Examples:
  • If guest count is down but Customer Sentiment pillar is high → "Sentiment among existing customers is strong, but acquisition is failing. The issue isn't the experience, it's getting people through the door."
  • If average check is down but Pricing pillar is high → "Pricing strategy reads well from the menu, but operators aren't capturing the upside in real ticket value — likely an upselling or menu-mix execution gap."
  • If profitability is down but revenue stable → "Top line holds but margins erode — this is a cost-control problem, not a demand problem."
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
          : ' [NO STRUCTURED RATING DATA — check the [USER-NAMED] web data section below for snippets]';
        return `  ${i+1}. ${r.userName}${hint}`;
      }).join('\n');
      userCompBlock = `USER-NAMED COMPETITORS (the restaurant owner explicitly identified these as their direct competitors — these MUST appear in your competitors array):
${list}

IMPERATIVE: Your competitors array MUST include every name above. For each:
- If a rating/reviewCount value is shown in [EXTRACTED FROM SERPER: ...] above, USE THOSE EXACT VALUES — they came directly from Google's knowledge graph. Do NOT override them with null.
- If the EXTRACTED block shows "null" for rating, scan the [USER-NAMED: X] section in the COMPETITORS web data for any rating signal (4.5/5, 4.5 stars, etc) and extract it. Only use null if you genuinely cannot find any signal anywhere.
- Use the resolvedName from Serper if provided (it's more accurate, e.g. "Hog Island Oyster Co." instead of "Hog Island"); otherwise keep the user's input name.
- Write a 1-sentence note describing the competitor's position relative to the focal restaurant.

After listing all user-named competitors, you MUST add additional competitors from the [SIMILAR-TO] / [NEIGHBORHOOD] / [TOP-IN-CITY] sections until you reach 5 total competitors. Scan ALL sections for any restaurant name that appears verbatim in the data. Common patterns: restaurants mentioned in TripAdvisor "Top 10" lists, restaurants in "people also search for" sections, restaurants with Google Maps listings. Include any restaurant whose name is plausibly in the same tier/category as the focal restaurant. Aim for exactly 5. Only return fewer than 5 if you genuinely cannot find more verifiable competitor names in the entire web data — but the data typically contains many; look harder.`;
    } else {
      userCompBlock = '';
    }

    console.log('[diagnose] claude part1 + part2 in parallel (p2 uses Haiku for speed)...');
    const tClaude = Date.now();
    const [p1, p2] = await Promise.all([
      claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language.\n\nRestaurant:${name}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${sv}\n\n${bmBlock}\n\nReturn JSON. Use WebData for scores. Use Reviewer Self-Assessment to write ownerSentimentSummary (2 sentences interpreting what the reviewer thinks vs what data shows) and sentimentGap (1 sentence on biggest gap between reviewer perception and reality). businessRealityAnalysis and perceptionGap follow the rules above. When business metrics are provided, ALSO populate pillarGapNarratives with one short sentence per relevant pairing (guest count ↔ Customer Sentiment pillar; average check ↔ Pricing & Accessibility pillar; profitability ↔ Brand Experience & Growth pillar). Each narrative should be 1 punchy sentence interpreting the gap or alignment between the financial metric and the qualitative pillar score. If a metric is not provided, return empty string "" for its narrative.\n{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"from data","priceDetected":"$$","executiveSummary":"2-3 sentences citing real ratings","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":"real"},{"name":"Yelp","score":65,"note":"real"},{"name":"TripAdvisor","score":55,"note":"real"},{"name":"OpenTable","score":60,"note":"real"},{"name":"Social Media","score":50,"note":"real"},{"name":"Delivery Platforms","score":35,"note":"real"}]},"ownerSentimentSummary":"2 sentences","sentimentGap":"1 sentence","businessRealityAnalysis":"","perceptionGap":"","pillarGapNarratives":{"guest":"","check":"","profit":""}}\nRules:good>=65 warn=45-64 bad<45 scoreVerdict=Excellent/Good/Fair/Needs Attention. NOTE: Do NOT change the healthCheckScore or pillar scores based on businessMetrics — the score remains qualitative+web-data driven. Financial metrics are reported separately via businessRealityAnalysis, perceptionGap, and pillarGapNarratives.`, { label: 'diagnose-p1' }),
      claude(`IMPORTANT: Write ALL text values in English only, even if web data is in another language. Translate any non-English review quotes into English.\n\nRestaurant:${name}\nLocation:${location}\nWebData:\n${web.slice(0,4500)}\n\n${bmBlock}\n\n${userCompBlock}\n\nReturn JSON with real data.\n\nIMPORTANT — TWO DISTINCT ACTION LISTS:\n1. "actions" — 5 OPERATIONAL recommendations driven by the qualitative pillars and web data (customer experience, staff, social media, brand, competitive positioning). These exist regardless of whether financial metrics were provided. Do NOT mention specific financial numbers in these actions.\n2. "commercialActions" — 2-3 COMMERCIAL/FINANCIAL recommendations driven SPECIFICALLY by the business metrics the user SHARED. Rules: (a) If the businessMetrics block says all metrics are "Not tracked (user opted out)", return empty array []. (b) Each item MUST reference only a metric the user actually shared — never reference a "Not tracked" metric or speculate about one. (c) Each item must include "title", "desc", and "evidence" (a short phrase referencing the specific shared financial metric, e.g. "Guest count -12% YoY" or "Profitability -8% YoY").\n\nCommercial action guidance (only for shared metrics): declining guest count → acquisition/awareness/traffic actions; declining average check → menu mix, pricing strategy, upselling actions; declining profitability with stable revenue → cost control, prime cost management, supplier/labor optimization. Strong growth → reinvestment/expansion suggestions.\n\nIMPORTANT — COMPETITORS schema: list 3 TO 5 actual competing restaurants from the COMPETITORS web data (NOT the focal restaurant itself). The COMPETITORS web data is organised into LABELED SECTIONS: [USER-NAMED: X] (the restaurant owner identified X as a direct competitor — HIGHEST PRIORITY, always include each user-named competitor if you can find any data about them); [SIMILAR-TO] (restaurants with concept overlap surfaced via \"restaurants like X\" queries — SECOND PRIORITY); [NEIGHBORHOOD] (restaurants in the same neighborhood/district — THIRD PRIORITY, only include if plausibly similar tier/cuisine); [TOP-IN-CITY] (broad city-level results — LOWEST PRIORITY, only use if other sections thin). RULES: (1) Only include competitors whose NAMES appear VERBATIM in the web data — never invent names like \"Restaurant Market\" or generic placeholders. (2) Fewer real competitors is better than padded fakes. If you only have 3 strong, return 3. Do not pad to 5 with weak matches. (3) Skip restaurants that are clearly a different tier (fast-food when focal is fine-dining) or different cuisine concept. (4) For each named competitor, ACTIVELY SEARCH the web data for star ratings (Google, TripAdvisor, Yelp ratings typically appear as \"4.5\", \"4.5/5\", \"4.5 stars\", or similar). Convert to a number 0-5. Only use null if you genuinely cannot find any rating signal — do not default to null out of excessive caution. (5) Same for reviewCount — look for \"850 reviews\", \"1.2k reviews\", \"(642)\" patterns. Convert k-suffixed numbers (1.2k → 1200). Only null if truly absent. (6) Do NOT include the focal restaurant in this list — it will be added by the renderer.\n\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":4,"sentiment":"positive"},{"text":"real quote","source":"Yelp","stars":3,"sentiment":"negative"},{"text":"real quote","source":"Google","stars":2,"sentiment":"negative"}],"strengths":["real strength 1","real strength 2","real strength 3"],"risks":["real risk 1","real risk 2","real risk 3"],"themes":{"positive":["t1","t2","t3"],"negative":["t1","t2"],"neutral":["t1","t2"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real competitor name","rating":4.5,"reviewCount":850,"note":"1 sentence on their position"},{"name":"real competitor name","rating":4.2,"reviewCount":340,"note":"1 sentence"},{"name":"real competitor name","rating":4.7,"reviewCount":1200,"note":"1 sentence"},{"name":"real competitor name","rating":4.0,"reviewCount":520,"note":"1 sentence"},{"name":"real competitor name","rating":4.3,"reviewCount":890,"note":"1 sentence"}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based, operational"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}],"commercialActions":[{"title":"t","desc":"d","evidence":"financial metric reference"},{"title":"t","desc":"d","evidence":"financial metric reference"}]}`, { label: 'diagnose-p2', model: 'claude-haiku-4-5-20251001' })
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
    if (!report.healthCheckScore || !report.pillars) throw new Error('missing fields: '+Object.keys(report).join(','));

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
          if (serperData) {
            if (serperData.rating !== null) {
              if (entry.rating !== serperData.rating) {
                console.log(`[diagnose] safety-net override ${entry.name}: rating ${entry.rating} → ${serperData.rating} (Serper)`);
                overridden++;
              }
              entry.rating = serperData.rating;
            }
            if (serperData.reviewCount !== null) {
              entry.reviewCount = serperData.reviewCount;
            }
            // Prefer Serper's resolved title (e.g. "Hog Island Oyster Co.") over user's input
            if (serperData.resolvedTitle && norm(entry.name).length < norm(serperData.resolvedTitle).length) {
              entry.name = serperData.resolvedTitle;
            }
          }
          merged.push(entry);
          usedAiIdx.add(aiIdx);
          promoted++;
        } else {
          // AI dropped this competitor — synthesize using Serper data when available.
          const displayName = (serperData && serperData.resolvedTitle) || userName;
          merged.push({
            name: displayName,
            rating: serperData ? serperData.rating : null,
            reviewCount: serperData ? serperData.reviewCount : null,
            note: (serperData && serperData.rating !== null)
              ? 'Owner-identified direct competitor — rating data extracted from public review platforms.'
              : 'Owner-identified direct competitor; public review data was limited in this scrape.'
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

    // ── AI-discovered competitor Serper backfill ─────────────────────────
    // After the user-named safety net runs, the array may still contain
    // AI-discovered competitors (like "Farmhouse Local") with null ratings.
    // Run Serper structured lookup on each so they show real ratings.
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
          console.log(`[diagnose] AI-competitor backfill: looking up ${needsBackfill.length} names via Serper`);
          const locParts = String(location || '').split(',').map(s => s.trim()).filter(Boolean);
          const cityLoc = locParts.length >= 3 ? `${locParts[0]}, ${locParts[locParts.length - 2]}` : (locParts[0] || location);
          const lookups = await Promise.all(
            needsBackfill.map(({ c }) =>
              searchStructured(`${c.name} restaurant ${cityLoc}`, { label: `BACKFILL[${c.name}]` })
                .catch(e => { console.log(`[diagnose] BACKFILL[${c.name}] error: ${e.message}`); return { text: '', rating: null, reviewCount: null, title: null }; })
            )
          );
          let backfilled = 0;
          needsBackfill.forEach(({ idx }, i) => {
            const lookup = lookups[i] || {};
            if (lookup.rating !== null && lookup.rating !== undefined) {
              report.competitors[idx].rating = lookup.rating;
              if (lookup.reviewCount !== null && lookup.reviewCount !== undefined) {
                report.competitors[idx].reviewCount = lookup.reviewCount;
              }
              if (lookup.title && lookup.title.length > report.competitors[idx].name.length) {
                report.competitors[idx].name = lookup.title;
              }
              backfilled++;
            }
          });
          console.log(`[diagnose] AI-competitor backfill: ${backfilled}/${needsBackfill.length} got ratings, ${Date.now() - t}ms`);
        }
      }
    } catch (e) {
      console.error('[diagnose] AI-competitor backfill FAILED (continuing without backfill):', e.message);
    }

    // _debug: attach scraping provenance so issues are diagnosable from the
    // browser DevTools network tab without needing Railway log access.
    report._debug = {
      version: '8.9.11',
      userCompetitorsReceived: userCompetitorsRaw,
      userCompetitorsParsed: userCompetitors,
      serperExtracted: compUserResults.map(r => ({
        name: r.userName,
        resolvedTitle: r.resolvedTitle,
        rating: r.rating,
        reviewCount: r.reviewCount
      })),
      aiReturnedCompetitorNames: Array.isArray(p2.competitors)
        ? p2.competitors.map(c => c && c.name).filter(Boolean)
        : [],
      aiReturnedCompetitorCount: Array.isArray(p2.competitors) ? p2.competitors.length : 0,
      finalCompetitors: Array.isArray(report.competitors)
        ? report.competitors.map(c => ({ name: c.name, rating: c.rating, reviewCount: c.reviewCount }))
        : [],
      competitorWebDataChars: (co || '').length,
      competitorSectionLabels: (co || '').match(/\[(USER-NAMED|SIMILAR-TO|NEIGHBORHOOD|TOP-IN-CITY)[^\]]*\]/g) || []
    };
    console.log('[diagnose] _debug:', JSON.stringify(report._debug));

    console.log('[diagnose] SUCCESS score:', report.healthCheckScore);
    return res.status(200).json(report);
  } catch(e) {
    console.error('[diagnose] FAILED:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

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
app.post('/save-report', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { email, report, survey, product } = req.body;
  if (!email || !report) {
    return res.status(400).json({ error: 'email and report required' });
  }
  const key = email.toLowerCase().trim();
  reportStore.set(key, { report, survey, product: product || 'full', savedAt: Date.now() });
  console.log('[save-report] Saved for:', key);
  res.status(200).json({ ok: true });
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
      diagnostix_score:        report.healthCheckScore || 0,
      diagnostix_verdict:      report.scoreVerdict || '',
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
    console.log('[hubspot] Contact saved:', email);
  } catch(e) {
    console.log('[hubspot] Failed:', e.message);
  }
}

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
      console.log('[hubspot] Marked purchased:', email, product);

      await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          properties: {
            hs_note_body: 'DiagnostiX ' + product + ' report purchased. Score: ' + (report.healthCheckScore || 'N/A') + '. Restaurant: ' + restaurantName,
            hs_timestamp: new Date().toISOString()
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
          }]
        })
      });
    }
    console.log('[hubspot] Note added for:', email);
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
  const amountPaidSafe = subField('amount_paid', 'amountPaid') || 0;
  const subscribedAtRaw = subField('subscribed_at', 'subscribedAt');
  // subscribedAt in-memory is a ms timestamp; subscribed_at in Supabase is ISO string.
  const subscribedAtIso = typeof subscribedAtRaw === 'number'
    ? new Date(subscribedAtRaw).toISOString()
    : (subscribedAtRaw || new Date().toISOString());

  const isAnnual = planTypeSafe === 'annual';
  const score = report?.healthCheckScore || 0;
  const baselineScore = baseline?.healthCheckScore || 0;

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
    diagnostix_amount_paid_usd:     amountPaidSafe,
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
      console.log('[hubspot-ctx] Updated', subscriber.email, '|', subscriber.plan_type, '| report', reportNumber, '| score', score);
    } else {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ properties })
      });
      console.log('[hubspot-ctx] Created', subscriber.email, '|', subscriber.plan_type);
    }
  } catch(e) {
    console.log('[hubspot-ctx] Push failed for', subscriber.email, e.message);
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
async function sendCustomerReportEmail({ subscriber, report, reportNumber, survey }) {
  const baseUrl = process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app';

  // Subscriber object can arrive in two shapes (Supabase snake_case vs in-memory camelCase).
  // Read each field with a fallback so the email works in both flows.
  const subField = (snake, camel) => subscriber[snake] !== undefined ? subscriber[snake] : subscriber[camel];
  const reportTokenSafe = subField('report_token', 'reportToken') || '';
  const restaurantNameSafe = subField('restaurant_name', 'restaurantName') || 'your restaurant';
  const firstNameSafe = subField('first_name', 'firstName') || 'there';
  const planTypeSafe = subField('plan_type', 'planType') || '';

  const link = baseUrl + '/report?token=' + reportTokenSafe;
  const score = report?.healthCheckScore ?? 0;
  const verdict = report?.scoreVerdict || '';
  const restaurant = restaurantNameSafe;
  const firstName = firstNameSafe;
  const isOneOff = planTypeSafe === 'one_off';

  let subject, headline, intro;
  if (isOneOff) {
    subject = `Your DiagnostiX Full Report is ready — ${restaurant}`;
    headline = 'Your DiagnostiX Full Report is ready';
    intro = 'Thank you for purchasing the DiagnostiX Full Report. Your full HealthCheck is now permanently available at the link below — bookmark it for future reference. If you would like ongoing tracking with reports every 4 months, you can upgrade to DiagnostiX Annual at any time.';
  } else if (reportNumber === 1) {
    subject = `Welcome to DiagnostiX Annual — your baseline report for ${restaurant}`;
    headline = 'Your DiagnostiX baseline is ready';
    intro = 'Thank you for subscribing to DiagnostiX Annual. Your baseline report is now stored and ready to view anytime over the next 12 months. We will send you Report 2 in 4 months and Report 3 in 8 months automatically.';
  } else if (reportNumber === 2) {
    subject = `Your DiagnostiX Report 2 is ready — ${restaurant}`;
    headline = 'Your Month 4 progress report is ready';
    intro = 'Four months on from your baseline, your second DiagnostiX report is ready. The link below shows your latest scores side-by-side with your baseline so you can see exactly what is moving.';
  } else {
    subject = `Your DiagnostiX Year-End Report is ready — ${restaurant}`;
    headline = 'Your year-end DiagnostiX report is ready';
    intro = 'Your third and final DiagnostiX report of this year is ready. Inside you will find a year-end side-by-side comparison of all three reports across every pillar.';
  }

  // Score color matches the survey banding (green ≥65, amber ≥45, red <45)
  const scoreColor = score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24';
  const escE = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escE(subject)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=League+Spartan:wght@300;400;500;700;900&display=swap');
</style>
</head>
<body style="margin:0;padding:0;background:#F5F4FC;font-family:'League Spartan',-apple-system,Segoe UI,Arial,sans-serif;color:#1B1464;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F5F4FC">
<tr><td align="center" style="padding:24px 12px">

  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%">

    <!-- Purple gradient header -->
    <tr><td style="background:#1B1464;background-image:linear-gradient(135deg,#92278F,#2E3192,#1B1464);border-radius:14px 14px 0 0;padding:32px 32px 28px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-weight:900;letter-spacing:1px;color:#ffffff;font-size:22px;line-height:1">diagnosti<span style="color:#0072BC">X</span></div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:2px;color:rgba(255,255,255,.75);text-transform:uppercase;margin-top:4px;font-weight:500">Restaurant HealthCheck · by 4xi</div>
        </td></tr>
        <tr><td style="padding-top:28px">
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:3px;color:rgba(255,255,255,.7);text-transform:uppercase;font-weight:700">Performance Intelligence Report</div>
          <div style="font-family:'League Spartan',Arial,sans-serif;color:#ffffff;font-size:26px;font-weight:900;line-height:1.2;margin-top:6px">${escE(restaurant)}</div>
        </td></tr>
      </table>
    </td></tr>

    <!-- Gold/blue gradient divider -->
    <tr><td style="height:4px;background:#0072BC;background-image:linear-gradient(90deg,#92278F,#0072BC);font-size:0;line-height:0">&nbsp;</td></tr>

    <!-- White content body -->
    <tr><td style="background:#ffffff;padding:32px;border-radius:0 0 14px 14px">

      <div style="font-family:'League Spartan',Arial,sans-serif;font-size:20px;font-weight:900;color:#1B1464;margin:0 0 14px;line-height:1.25">${escE(headline)}</div>
      <p style="font-family:'League Spartan',Arial,sans-serif;font-size:14px;line-height:1.65;color:#444;margin:0 0 24px;font-weight:400">Hi ${escE(firstName)}, ${escE(intro)}</p>

      <!-- Score block -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F5F4FC;border-radius:10px;margin:0 0 28px">
        <tr><td align="center" style="padding:22px 18px">
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:2px;color:#1B1464;text-transform:uppercase;font-weight:700;opacity:.7">Overall HealthCheck Score</div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:54px;font-weight:900;color:${scoreColor};line-height:1;margin:10px 0 4px">${score}<span style="font-size:20px;color:#999;font-weight:500">/100</span></div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:13px;color:#1B1464;font-weight:700;letter-spacing:1px;text-transform:uppercase">${escE(verdict)}</div>
        </td></tr>
      </table>

      <!-- CTA button -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td align="center" style="padding:0 0 8px">
          <a href="${link}" style="display:inline-block;background:#1B1464;background-image:linear-gradient(135deg,#92278F,#2E3192,#1B1464);color:#ffffff;text-decoration:none;padding:16px 36px;border-radius:8px;font-family:'League Spartan',Arial,sans-serif;font-weight:900;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;mso-padding-alt:0">View Your Full Report &rarr;</a>
        </td></tr>
      </table>

      <p style="font-family:'League Spartan',Arial,sans-serif;font-size:12px;color:#999;line-height:1.6;margin:28px 0 0;text-align:center">Or paste this link into your browser:<br><span style="color:#1B1464;word-break:break-all;font-weight:500">${link}</span></p>

    </td></tr>
  </table>

  <!-- Footer -->
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;margin-top:8px">
    <tr><td align="center" style="padding:20px 24px;font-family:'League Spartan',Arial,sans-serif;font-size:11px;color:#999;line-height:1.6;letter-spacing:.5px">
      <div style="font-weight:900;color:#1B1464;letter-spacing:1px;text-transform:uppercase;font-size:10px">DiagnostiX by 4xi</div>
      <div style="margin-top:4px">24/7 · 365 Intelligence Platform</div>
      <div style="margin-top:10px;opacity:.8">This link is private to you. Keep it safe.</div>
    </td></tr>
  </table>

</td></tr></table>
</body></html>`;

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
        baseline_score:       memSub.reports?.[0]?.report?.healthCheckScore || 0,
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
    let report = sub.baseline_report;
    let reportLabel = sub.plan_type === 'one_off' ? 'Full Report' : 'Baseline Report (Day 0)';
    if (sub.report_2) { report = sub.report_2; reportLabel = 'Report 2 — Month 4'; }
    if (sub.report_3) { report = sub.report_3; reportLabel = 'Report 3 — Month 8'; }

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
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — DiagnostiX</title>
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
  const score      = report?.healthCheckScore ?? 0;
  const verdict    = report?.scoreVerdict || '';
  const summary    = report?.executiveSummary || '';
  const cuisine    = report?.cuisineDetected || '';
  const price      = report?.priceDetected || '';
  const location   = subscriber.location || '';

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Survey banding: green ≥65, amber ≥45, red <45
  const scoreColor = score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24';

  // Circular score gauge SVG (matches survey's dialSVG)
  const r = 48, cx = 56, cy = 56;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  const gaugeSvg = `<svg viewBox="0 0 112 112" width="112" height="112" aria-hidden="true" style="display:block">
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

  // Competitors — uniform card layout for visual consistency.
  // Every card has the same shape: big number on top, scale label, then metadata
  // and note. Different scales are visually denoted via the scale-suffix ("/100"
  // vs "/5 ★") and the small tag ("YOU" vs "PEER"). This way the eye can scan
  // all 6 cards as one comparison set without scale-confusion sleight-of-hand.
  //
  // Aggressive shape interpreter — the AI sometimes returns the rating in different
  // fields depending on which model ran and whether it inferred the new schema or
  // hung on to the legacy one. Order of preference:
  //   1. c.rating  (number 0-5)     → new schema, treat as stars
  //   2. c.score   (number 0-5)     → legacy shape, looks like stars → stars
  //   3. c.score   (number > 5)     → legacy shape, looks like a /100 score → stars (÷20)
  //   4. nothing parseable          → show "—" and let the note explain
  // This keeps cards looking complete instead of saying "undefined" or "Rating n/a".

  const competitorList = Array.isArray(report?.competitors) ? report.competitors : [];

  // Helper: turn whatever the AI gave us into a {rating0to5, source} pair.
  function interpretCompetitorRating(c) {
    if (typeof c?.rating === 'number' && isFinite(c.rating)) {
      // Clamp to 0–5 in case the AI returned something weird.
      return { rating: Math.max(0, Math.min(5, c.rating)), source: 'rating' };
    }
    if (typeof c?.score === 'number' && isFinite(c.score)) {
      if (c.score > 0 && c.score <= 5) return { rating: c.score, source: 'score-as-stars' };
      if (c.score > 5 && c.score <= 100) return { rating: c.score / 20, source: 'score-as-100' };
    }
    // Sometimes the AI puts a string like "4.5★" or "4.5 stars" — last-ditch parse.
    const m = typeof c?.rating === 'string' ? c.rating.match(/([0-5](?:\.\d)?)/)
           : typeof c?.score  === 'string' ? c.score.match(/([0-5](?:\.\d)?)/)
           : null;
    if (m) return { rating: parseFloat(m[1]), source: 'string-parse' };
    return { rating: null, source: 'none' };
  }

  function interpretReviewCount(c) {
    if (typeof c?.reviewCount === 'number' && isFinite(c.reviewCount)) return Math.round(c.reviewCount);
    if (typeof c?.reviews === 'number' && isFinite(c.reviews)) return Math.round(c.reviews);
    // String fallback: "1,237 reviews" or just "1237"
    const s = c?.reviewCount || c?.reviews;
    if (typeof s === 'string') {
      const m = s.replace(/,/g, '').match(/(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // YOU card — always built from authoritative data, not from the AI's competitor list
  const youCard = `<div class="comp-card comp-me">
    <div class="comp-card-tag" style="background:var(--blue);color:#fff">YOU</div>
    <div class="comp-name">${esc(restaurant)}</div>
    <div class="comp-big">${score}<span class="comp-big-scale">/100</span></div>
    <div class="comp-metric-label">DiagnostiX HealthCheck Score</div>
    <div class="comp-note">Full diagnostic across 6 pillars</div>
  </div>`;

  // PEER cards — filter out any competitor whose name matches the focal restaurant
  const focalNameLower = String(restaurant || '').trim().toLowerCase();
  const peers = competitorList.filter(c => {
    const peerName = String(c?.name || '').trim().toLowerCase();
    return peerName && peerName !== focalNameLower;
  });

  const peerCards = peers.slice(0, 5).map(c => {
    const { rating: ratingRaw } = interpretCompetitorRating(c);
    const reviewCount = interpretReviewCount(c);
    const hasRating = ratingRaw !== null;

    // Star colour band: 4.5+ green, 4.0+ amber, below 4.0 red, none grey.
    const ratingColor = !hasRating ? '#999'
                      : ratingRaw >= 4.5 ? '#00A651'
                      : ratingRaw >= 4.0 ? '#F7941D'
                      : '#ED1C24';

    // Big-number block — when we have a rating, show it boldly with stars.
    // When we don't, show a discreet "no public rating" pill instead of a
    // misleading dash that looks like a render bug.
    const bigBlock = hasRating
      ? `<div class="comp-big" style="color:${ratingColor}">${ratingRaw.toFixed(1)}<span class="comp-big-scale"> / 5 ★</span></div>`
      : `<div class="comp-no-rating">No public rating found</div>`;

    // Metric label only shown when we have meaningful data
    const metricLabel = hasRating
      ? (reviewCount !== null
          ? (reviewCount >= 1000 ? (reviewCount/1000).toFixed(1) + 'k' : String(reviewCount)) + ' reviews'
          : 'Market rating')
      : 'Profile only';

    return `<div class="comp-card comp-peer">
      <div class="comp-card-tag" style="background:#e8e3d8;color:#666">PEER</div>
      <div class="comp-name">${esc(c.name || 'Unknown')}</div>
      ${bigBlock}
      <div class="comp-metric-label">${esc(metricLabel)}</div>
      <div class="comp-note">${esc(c.note || '')}</div>
    </div>`;
  }).join('');

  const competitors = youCard + peerCards;

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
    <p class="body-p" style="margin:0 0 14px;color:#666;font-size:13px">Actions tied directly to your financial reality. These complement &mdash; not replace &mdash; the operational actions below.</p>
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

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(restaurant)} — DiagnostiX Report</title>
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

.body-p{font-size:14px;line-height:1.7;color:#333;margin:10px 0}

/* Pillar score rows */
.sc-row{
  display:flex;align-items:center;gap:14px;margin:10px 0;
}
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
@media (max-width:680px){.comp-grid{grid-template-columns:1fr}}
.comp-card{
  background:var(--soft-bg);
  border-top:3px solid var(--amber);
  padding:16px 18px;
  border-radius:0 0 6px 6px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.comp-me{border-top-color:var(--blue)}
.comp-name{font-weight:900;font-size:14px;color:var(--navy);letter-spacing:.3px}
.comp-note{font-size:12px;color:#555;line-height:1.55}
.comp-no-rating{display:inline-block;font-size:10px;color:#999;background:#ede9e2;padding:5px 9px;border-radius:3px;margin-bottom:6px;letter-spacing:0.04em;font-weight:600;text-transform:uppercase}
.comp-card{position:relative;padding-top:22px}
.comp-card-tag{
  position:absolute;top:10px;right:10px;
  font-size:9px;font-weight:900;letter-spacing:1.5px;
  padding:2px 7px;border-radius:3px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
/* Unified big-number style — same visual prominence for YOU /100 and PEER /5 ★ */
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

/* PRINT — clean PDF output */
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
  .act,.comp-card,.qblock{page-break-inside:avoid}
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
      <div>${gaugeSvg}<div style="text-align:center;font-size:10px;letter-spacing:2.5px;color:rgba(255,255,255,.85);text-transform:uppercase;font-weight:700;margin-top:8px">${esc(verdict)}</div></div>
    </div>
  </div>

  <div class="grad-line"></div>

  <!-- White body card -->
  <div class="body-card">

    ${summary ? `
      <h2 class="rpt-h">Executive Summary</h2>
      <div class="exec-box">${esc(summary)}</div>
    ` : ''}

    ${pillarRows ? `
      <h2 class="rpt-h">Pillar Scores</h2>
      ${pillarRows}
    ` : ''}

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
    ` : ''}

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
async function createCustomer({ email, firstName, restaurantName, location, website, report, survey, planType, amountPaid }) {
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
                '| email:', email);
  } else {
    console.log('[business-metrics] skipped (all) | email:', email);
  }

  const subscriber = {
    email,
    firstName: firstName || '',
    restaurantName: restaurantName || '',
    location: location || '',
    website: website || '',
    subscribedAt: now,
    planType,
    amountPaid: amountPaid || 0,
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
          amount_paid:        amountPaid || 0,
          baseline_score:     report?.healthCheckScore || 0,
          baseline_report:    report || null,
          report_token:         reportToken,
          guest_count_change:   guestCountChange,
          avg_check_change:     avgCheckChange,
          profitability_change: profitabilityChange
        })
      });
      console.log('[customer] saved', planType, email, '| token:', reportToken);
    } catch(e) {
      console.log('[customer] Supabase save failed:', e.message);
    }
  }

  return subscriber;
}

// ── /payment-webhook ─────────────────────────────────────────
app.post('/payment-webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  console.log('[webhook] Received body:', JSON.stringify(req.body));
  console.log('[webhook] Current report store keys:', Array.from(reportStore.keys()));

  const body = req.body;
  if (!body) {
    console.log('[webhook] Empty body received');
    return;
  }

  const payload = body.data || body;
  const email = (payload.email || payload.Email || payload.contactEmail || body.email || '').toLowerCase().trim();
  const product = payload.product || payload.Product || body.product || 'full';
  const firstName = payload.firstName || payload.first_name || body.firstName || '';

  if (!email) {
    console.log('[webhook] No email found in body:', JSON.stringify(body));
    return;
  }

  console.log('[webhook] Looking up email:', email);

  // 1. Exact email match
  let saved = reportStore.get(email);
  let matchType = 'exact';

  // 2. Local-part match (e.g. simon@a.com vs simon@b.com)
  if (!saved) {
    for (const [k, v] of reportStore.entries()) {
      if (k.includes(email.split('@')[0]) || email.includes(k.split('@')[0])) {
        saved = v;
        matchType = 'local-part';
        console.log('[webhook] Found report via local-part match:', k, '->', email);
        break;
      }
    }
  }

  // 3. Time-window fallback: most recent report saved within last 5 minutes.
  // Covers the common case where the user fills the survey with one email
  // (e.g. restaurant email) but checks out via Wix using a different email
  // (e.g. logged-in member account email).
  if (!saved) {
    const FIVE_MIN = 5 * 60 * 1000;
    const now = Date.now();
    let mostRecent = null;
    let mostRecentKey = null;
    for (const [k, v] of reportStore.entries()) {
      if (!v.savedAt) continue;
      const age = now - v.savedAt;
      if (age > FIVE_MIN) continue;
      if (!mostRecent || v.savedAt > mostRecent.savedAt) {
        mostRecent = v;
        mostRecentKey = k;
      }
    }
    if (mostRecent) {
      saved = mostRecent;
      matchType = 'time-window';
      const ageSec = Math.round((now - mostRecent.savedAt) / 1000);
      console.log('[webhook] Found report via time-window fallback:', mostRecentKey, '->', email, '| age:', ageSec + 's');
    }
  }

  if (!saved) {
    console.log('[webhook] No saved report for:', email, '| Store has:', reportStore.size, 'entries');
    await markPurchasedAndEmail(email, firstName || '', payload.restaurantName || '', {}, product);
    return;
  }

  console.log('[webhook] Match type:', matchType);

  const report     = saved.report || {};
  const survey     = saved.survey || {};
  const resolvedFirstName = firstName || survey.contactName || survey.firstName || '';
  const restaurant = survey.name || body.restaurantName || '';
  const location   = survey.location || '';

  // If we matched via time-window fallback, the Wix-supplied email is likely
  // a logged-in member account that differs from the survey email. The survey
  // email is the customer's real contact for this restaurant — send there.
  let destEmail = email;
  if (matchType === 'time-window' && survey.email && survey.email.toLowerCase() !== email) {
    console.log('[webhook] Time-window fallback: overriding webhook email', email, '-> survey email', survey.email);
    destEmail = survey.email.toLowerCase().trim();
  }

  console.log('[webhook] Payment confirmed for:', destEmail, product, '| Restaurant:', restaurant);

  // Legacy HubSpot purchase marker (kept for backward compatibility).
  await markPurchasedAndEmail(destEmail, resolvedFirstName, restaurant, report, product);

  if (!report || Object.keys(report).length === 0) {
    console.log('[webhook] No report data — skipping full customer creation');
    return;
  }

  // Unified flow: both Annual and one-off go through createCustomer.
  const planType = product === 'annual' ? 'annual' : 'one_off';
  const amountPaid = planType === 'annual' ? 99.99 : Number(payload.amountPaid || payload.amount || 24.99);

  const subscriber = await createCustomer({
    email: destEmail,
    firstName: resolvedFirstName,
    restaurantName: restaurant,
    location: survey.location || '',
    website:  survey.website  || '',
    report,
    survey,
    planType,
    amountPaid
  });

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

  const reportUrl = (process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app')
                   + '/report?token=' + subscriber.reportToken;

  await Promise.all([
    sendCustomerReportEmail({ subscriber: supaShaped, report, reportNumber: 1, survey }),
    pushReportContextToHubSpot({ subscriber: supaShaped, report, reportNumber: 1, reportUrl, baseline: report })
  ]);

  console.log('[webhook] Full flow complete for', destEmail, '| plan:', planType);
});

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

// ── UPDATE SUBSCRIBER IN SUPABASE (Reports 2/3) ──────────────
async function updateSubscriberInSupabase(sub, reportNumber) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    const latest = sub.reports[sub.reports.length - 1]?.report || null;
    const body = {
      reports_sent:   reportNumber,
      next_report_at: sub.nextReportAt ? new Date(sub.nextReportAt).toISOString() : null,
      active:         sub.nextReportAt ? true : false,
      latest_score:   latest?.healthCheckScore || 0
    };
    if (reportNumber === 2) {
      body.report_2 = latest;
      body.report_2_score = latest?.healthCheckScore || 0;
      body.report_2_date = new Date().toISOString();
    } else if (reportNumber === 3) {
      body.report_3 = latest;
      body.report_3_score = latest?.healthCheckScore || 0;
      body.report_3_date = new Date().toISOString();
    }
    await fetch(`${url}/rest/v1/subscribers?report_token=eq.${encodeURIComponent(sub.reportToken)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(body)
    });
    console.log('[supabase] Subscriber updated:', sub.email, '| token:', sub.reportToken, 'report', reportNumber);
  } catch(e) {
    console.log('[supabase] Subscriber update failed:', e.message);
  }
}

// ── GENERATE PROGRESS REPORT (Reports 2 and 3) ───────────────
async function generateProgressReport(sub) {
  const { email, restaurantName, location } = sub;
  const baseline = sub.reports[0];
  const previous = sub.reports[sub.reports.length - 1];
  const reportNumber = sub.reports.length + 1;

  console.log('[annual] Generating report', reportNumber, 'for:', email);

  try {
    const tSearch2 = Date.now();
    const locParts2 = String(location || '').split(',').map(s => s.trim()).filter(Boolean);
    const country2 = locParts2.length > 0 ? locParts2[locParts2.length - 1] : '';
    const region2 = getRegion(country2);
    console.log(`[annual] region=${region2} (country=${country2 || 'none'})`);
    const queries2 = buildRegionQueries(region2, restaurantName, location);
    const [g, rv, st, so, dl, co] = await Promise.all([
      searchWithFallback(queries2.GOOGLE,      { label: 'GOOGLE-progress' }),
      searchWithFallback(queries2.REVIEWS,     { label: 'REVIEWS-progress' }),
      searchWithFallback(queries2.STAFF,       { label: 'STAFF-progress' }),
      searchWithFallback(queries2.SOCIAL,      { label: 'SOCIAL-progress' }),
      searchWithFallback(queries2.DELIVERY,    { label: 'DELIVERY-progress' }),
      searchWithFallback(queries2.COMPETITORS, { label: 'COMPETITORS-progress' })
    ]);
    const web = `GOOGLE:${g}\nREVIEWS:${rv}\nSTAFF:${st}\nSOCIAL:${so}\nDELIVERY:${dl}\nCOMPETITORS:${co}`;
    const cats2 = { GOOGLE:g, REVIEWS:rv, STAFF:st, SOCIAL:so, DELIVERY:dl, COMPETITORS:co };
    const empties2 = Object.entries(cats2).filter(([k,v]) => v === 'no data' || v === 'no api key' || v.startsWith('err:')).map(([k]) => k);
    console.log(`[annual] scraping summary: ${6 - empties2.length}/6 succeeded, ${Date.now()-tSearch2}ms` + (empties2.length ? ` | EMPTY: ${empties2.join(',')}` : ''));

    const baselineCtx = `BASELINE REPORT (${new Date(baseline.generatedAt).toLocaleDateString()}):
- HealthCheck Score: ${baseline.report.healthCheckScore}/100 (${baseline.report.scoreVerdict})
- Customer Sentiment: ${baseline.report.pillars?.cs?.score}/100
- Pricing & Accessibility: ${baseline.report.pillars?.pa?.score}/100
- Employee Sentiment: ${baseline.report.pillars?.es?.score}/100
- Social Media: ${baseline.report.pillars?.sm?.score}/100
- Competitive Position: ${baseline.report.pillars?.cp?.score}/100
- Brand Experience: ${baseline.report.pillars?.bg?.score}/100
- Online Presence: ${baseline.report.onlinePresence?.overall}/100
PREVIOUS ACTIONS: ${(baseline.report.actions||[]).map(a=>a.title).join('; ')}`;

    const prevCtx = sub.reports.length > 1 ? `PREVIOUS REPORT (${new Date(previous.generatedAt).toLocaleDateString()}):
- HealthCheck Score: ${previous.report.healthCheckScore}/100
- Trend: ${previous.report.healthCheckScore > baseline.report.healthCheckScore ? 'Improving' : 'Declining'}` : '';

    const p1 = await claude(`Restaurant:${restaurantName}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${baselineCtx}\n${prevCtx}\n\nThis is report ${reportNumber} of 3 for an annual subscriber. Return JSON:\n{"healthCheckScore":72,"scoreVerdict":"Good","cuisineDetected":"","priceDetected":"$$","executiveSummary":"2-3 sentences citing real ratings and progress vs baseline","pillars":{"cs":{"score":75,"label":"Customer Sentiment","status":"good"},"pa":{"score":65,"label":"Pricing & Accessibility","status":"good"},"es":{"score":48,"label":"Employee Sentiment","status":"warn"},"sm":{"score":55,"label":"Social Media Impact","status":"warn"},"cp":{"score":70,"label":"Competitive Positioning","status":"good"},"bg":{"score":68,"label":"Brand Experience & Growth","status":"good"}},"onlinePresence":{"overall":62,"channels":[{"name":"Google Business","score":80,"note":""},{"name":"Yelp","score":65,"note":""},{"name":"TripAdvisor","score":55,"note":""},{"name":"OpenTable","score":60,"note":""},{"name":"Social Media","score":50,"note":""},{"name":"Delivery Platforms","score":35,"note":""}]},"ownerSentimentSummary":"","sentimentGap":""}\nRules:good>=65 warn=45-64 bad<45`, { label: 'annual-p1' });

    const p2 = await claude(`Restaurant:${restaurantName}\nLocation:${location}\nWebData:\n${web.slice(0,2500)}\n\n${baselineCtx}\n\nReturn JSON with progress tracking. For competitors: list UP TO 3 actual competing restaurants from web data (NOT the focal restaurant). Only include names that appear verbatim in the web data — never invent generic placeholder names. Fewer real competitors is better than padded fakes. For each, actively search web data for star ratings (Google/TripAdvisor/Yelp; convert to 0-5 number) and review counts (handle \"1.2k\" → 1200). Only use null if truly absent. Do NOT invent ratings.\n{"reviewVerbatims":[{"text":"real quote","source":"Google","stars":5,"sentiment":"positive"},{"text":"real quote","source":"TripAdvisor","stars":3,"sentiment":"negative"}],"strengths":["strength 1","strength 2","strength 3"],"risks":["risk 1","risk 2","risk 3"],"themes":{"positive":["t1","t2"],"negative":["t1"],"neutral":["t1"]},"employeeSentiment":"from data","competitiveInsight":"from data","competitors":[{"name":"real competitor","rating":4.5,"reviewCount":850,"note":""},{"name":"real competitor","rating":4.2,"reviewCount":340,"note":""},{"name":"real competitor","rating":4.7,"reviewCount":1200,"note":""}],"actions":[{"priority":"urgent","title":"t","desc":"evidence-based"},{"priority":"urgent","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"30days","title":"t","desc":"d"},{"priority":"ongoing","title":"t","desc":"d"}],"progress":{"overallChange":${(p1.healthCheckScore||70) - baseline.report.healthCheckScore},"pillarsProgress":{"cs":${(p1.pillars?.cs?.score||70) - (baseline.report.pillars?.cs?.score||70)},"pa":${(p1.pillars?.pa?.score||65) - (baseline.report.pillars?.pa?.score||65)},"es":${(p1.pillars?.es?.score||50) - (baseline.report.pillars?.es?.score||50)},"sm":${(p1.pillars?.sm?.score||55) - (baseline.report.pillars?.sm?.score||55)},"cp":${(p1.pillars?.cp?.score||70) - (baseline.report.pillars?.cp?.score||70)},"bg":${(p1.pillars?.bg?.score||65) - (baseline.report.pillars?.bg?.score||65)}},"completedActions":[],"ongoingPriorities":[],"progressNarrative":"2 sentences on what has improved and what still needs work"}}`, { label: 'annual-p2' });

    const report = Object.assign({}, p1, p2, {
      reportNumber,
      baselineScore: baseline.report.healthCheckScore,
      generatedAt: new Date().toISOString(),
      isProgressReport: true
    });

    sub.reports.push({ generatedAt: Date.now(), report, reportNumber });

    if (reportNumber < 3) {
      sub.nextReportAt = Date.now() + (4 * 30 * 24 * 60 * 60 * 1000);
    } else {
      sub.nextReportAt = null;
      sub.completedAt = Date.now();
    }

    console.log('[annual] Report', reportNumber, 'generated for:', email, '| Score:', report.healthCheckScore);

    // Save to Supabase.
    await updateSubscriberInSupabase(sub, reportNumber);

    // Email customer + push HubSpot context, using the canonical Supabase row.
    const refreshed = await getSubscriberFromSupabase(sub.email);
    if (refreshed && refreshed.report_token) {
      const reportUrl = (process.env.APP_BASE_URL || 'https://diagnostix-proxy-production.up.railway.app')
                       + '/report?token=' + refreshed.report_token;
      await Promise.all([
        sendCustomerReportEmail({ subscriber: refreshed, report, reportNumber }),
        pushReportContextToHubSpot({
          subscriber:    refreshed,
          report,
          reportNumber,
          reportUrl,
          baseline:      refreshed.baseline_report
        })
      ]);
    } else {
      console.log('[annual] Skipping email/HubSpot — no token for', sub.email);
    }

    return report;
  } catch(e) {
    console.log('[annual] Report generation failed for:', email, e.message);
  }
}

// ── LOAD SUBSCRIBERS FROM SUPABASE ON STARTUP ────────────────
async function loadSubscribersFromSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/subscribers?active=eq.true&select=*`, {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    const rows = await res.json();
    if (Array.isArray(rows)) {
      rows.forEach(row => {
        if (!row.report_token) return; // skip rows without token (legacy/test data)
        annualSubscribers.set(row.report_token, {
          email:          row.email,
          firstName:      row.first_name || '',
          restaurantName: row.restaurant_name || '',
          location:       row.location || '',
          website:        row.website || '',
          reportToken:    row.report_token,
          subscribedAt:   new Date(row.subscribed_at).getTime(),
          nextReportAt:   row.next_report_at ? new Date(row.next_report_at).getTime() : null,
          reports:        [{ generatedAt: new Date(row.subscribed_at).getTime(), report: row.baseline_report || { healthCheckScore: row.baseline_score || 0, pillars: {} }, reportNumber: 1 }]
        });
      });
      console.log('[annual] Loaded', annualSubscribers.size, 'active subscribers from Supabase');
    }
  } catch(e) {
    console.log('[annual] Failed to load subscribers from Supabase:', e.message);
  }
}
loadSubscribersFromSupabase();

// ── DAILY SCHEDULER — check every 6 hours ────────────────────
setInterval(async () => {
  const now = Date.now();
  console.log('[scheduler] Checking', annualSubscribers.size, 'subscribers for due reports...');
  for (const [token, sub] of annualSubscribers.entries()) {
    if (sub.nextReportAt && now >= sub.nextReportAt) {
      console.log('[scheduler] Report due for:', sub.email, '|', sub.restaurantName, '| token:', token);
      await generateProgressReport(sub);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}, 6 * 60 * 60 * 1000);

// ── MANUAL TRIGGER (for testing) ─────────────────────────────
// Accepts either { email } (fires for ALL matching subscriptions) or { token } (specific subscription)
app.post('/trigger-annual-report', async (req, res) => {
  const { email, token, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  let targets = [];
  if (token) {
    const sub = annualSubscribers.get(token);
    if (sub) targets.push(sub);
  } else if (email) {
    const emailLower = email.toLowerCase();
    for (const sub of annualSubscribers.values()) {
      if (sub.email && sub.email.toLowerCase() === emailLower) targets.push(sub);
    }
  }

  if (targets.length === 0) return res.status(404).json({ error: 'No matching annual subscription found' });

  res.status(200).json({ ok: true, message: `Report generation started for ${targets.length} subscription(s)` });
  for (const sub of targets) {
    await generateProgressReport(sub);
    await new Promise(r => setTimeout(r, 3000));
  }
});

app.listen(PORT, () => console.log(`DiagnostiX v8.7 on port ${PORT}`));
