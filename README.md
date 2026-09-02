# DiagnostiX RVP

**Restaurant Vitality Profile.** 4xi Global Consulting. Internal.

A single-subject assessment service: a restaurant name plus a location in,
a scored report out. Also hosts the embedded EVP surface at `/evp`.

- ESM, `type: module`. Express. One file, `server.js`.
- Version comes from `package.json` and nowhere else.
- Supabase: `SUPABASE_URL` and `SUPABASE_KEY` point at
  `gxinqurxmstvoovfbgqr`, the SHARED project that also holds `benchmarks`,
  `subscribers` and `cohort_taxonomy`. Unlike SVP and EVP this service needs
  no separate `ANALYTICS_*` pair, and adding one would be a second name for the
  same thing.
- Railway project is **`diagnostix-restaurants`**, not `diagnostix-proxy`.
  `railway link -p diagnostix-restaurants` is the command; linking by the
  directory name fails.

## THE DESIGN RECORD IS NOT IN THIS REPO

**It lives in the `diagnostix-analytics` README.** That file is the record for
the whole estate, not just for Analytics, and it is where investigations are
written up before anything is built. This file exists because a README holding only a stub
title, in a repo with a 4,500 line `server.js`, reads as "nothing is written
down", which is false and expensive.

Findings that are about THIS service but recorded there:

- **The metro cannot be derived, and `METRO_CHAIN` is right twice out of four
  by accident.** Measured across Chile, the UK, the US and Germany. Google
  returns no component at all for a US metropolitan statistical area. Under
  "Phase 4 blockers".
- **The annual path breaks silently on any location format change.**
  `server.js` re-parses comma-format location strings read from
  `subscribers.baseline_report`. A new format does not migrate them:
  `getRegion('')` returns `'US'` and a Chilean restaurant gets English query
  templates on its annual re-run, with no error and a year's delay. Any change
  to the location field has to read BOTH formats. Same section.
- **`getRegion` is correct for the US by luck rather than by matching.** Its
  LATAM list is 24 lowercase exact matches, so `usa` and `united states` match
  nothing and fall through to the default. Under "Known drift".
- **The corpus truncation defect**, fixed in v8.9.26, which had four of six
  pillars scored with no access to their sources. It invalidates every variance
  measurement taken before it. Under "Variance is not reducible by prompt
  design".
- **The dash rule**, its sanitizer and the allow list, under "Known drift" and
  in the RVP commit history from v8.9.30 to v8.9.34.

Read that file before changing the location field, the scoring prompts or
anything that writes a `benchmarks` row.

## Routes

```
GET  /health                  version and config, unauthenticated
POST /diagnose                the assessment
POST /translate               report translation
GET  /report, /get-report     stored report retrieval
POST /save-report
POST /trigger-annual-report   the annual re-run, see the warning above
POST /payment-webhook
GET  /evp, POST /evp/diagnose the embedded EVP surface
```

## Running locally

```bash
npm install
node server.js
```

Requires `ANTHROPIC_API_KEY`, `SERPER_API_KEY` and
`GOOGLE_PLACES_API_KEY`. Benchmark writes additionally need `SUPABASE_URL`,
`SUPABASE_KEY` and `BENCHMARK_WRITE_ENABLED`.

Not licensed for distribution. Internal tool.
