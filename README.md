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
POST /payment-webhook         accepts a secret, rejects nothing, see below
POST /payment-webhook/:secret same handler, path-secret form
GET  /evp, POST /evp/diagnose the embedded EVP surface
```

## v8.11.10: the payment webhook can be watched, and stops logging what it should not

**This route has never authenticated anything.** No secret, no signature, no
allow-list, no rate limit, and it answers `200 {ok:true}` before it reads the
body. Every paying customer this product has exists because an unauthenticated
POST said so: `createCustomer` is called from exactly one place, inside this
handler, and `/report` is gated only by the token that call issues.

Requiring a secret today would break every genuine Wix call the moment it
deployed, because the automation posts to the bare URL. So this release adds
SIGHT and changes no behaviour:

- **A secret is read and logged, never enforced.** `RVP_WEBHOOK_SECRET` is
  compared timing-safely against a `/payment-webhook/:secret` path segment, and
  the result is logged as `WEBHOOK_SECRET [webhook] status=valid|invalid|absent|not-configured`.
  With the variable unset, or with no secret presented, the call is processed
  exactly as before. The value is never logged.
- **The body dump is gone.** `JSON.stringify(req.body)` wrote the buyer's
  address, name and restaurant into the platform log on every call, forged or
  genuine. `WEBHOOK_SHAPE` replaces it with key names and value types.
- **The store key dump is gone**, and it was the worse of the two: `reportStore`
  is keyed BY email address, so that line printed the address of everyone
  holding a pending report, on every call.
- **Five log lines carry the domain instead of the address**, and one of them
  also carried the REPORT TOKEN, which is an unlock credential: anyone reading
  the log could open that paid report.
- **The response is unchanged.**

**Logging cannot interrupt a purchase.** Every one of these lines runs after
the handler has already answered 200 and is doing the work: HubSpot, Supabase,
the peer comparison, the customer's email. A throw there is not a 500 the
caller sees, it is a genuine buyer silently receiving no report because a log
line failed. So all eight new log calls go through `safeLog`, all masking
through `maskAddr`, and the shape through `safeShape`, each total by
construction.

That was not theoretical. `emailDomainOnly(Object.create(null))` threw, because
`String()` throws on a value with no prototype. Found by diffing this file
against the EVP copy; fixed there first (EVP v1.8.69, with a red test), then
copied here.

**There is no test harness in this repo.** `lib-webhook-log.js` is copied
verbatim from `diagnostix-evp/lib-webhook-log.js`, which has 12 tests, and the
only permitted differences are the header comment and `export` in place of
`module.exports`. It was checked here by running the EVP test file's own case
lists against this copy from a throwaway script: 9 of 9 applicable cases pass,
including null, a number, an array of arrays, an object with no prototype and
a 1 MB string. That is a one-off check, not something that runs on every
change. Stated, not glossed.

**Next step, not taken here:** once the log shows every genuine Wix call
carrying a valid secret, require it. Not before.

## Running locally

```bash
npm install
node server.js
```

Requires `ANTHROPIC_API_KEY`, `SERPER_API_KEY` and
`GOOGLE_PLACES_API_KEY`. Benchmark writes additionally need `SUPABASE_URL`,
`SUPABASE_KEY` and `BENCHMARK_WRITE_ENABLED`.

Not licensed for distribution. Internal tool.
