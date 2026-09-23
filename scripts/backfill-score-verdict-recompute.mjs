// score_verdict backfill, recompute: rows since 2026-09-22 carrying the model's verdict get the band of their own computed score (the 69 Simon decided on).
// The old text is kept as cohort_extra.score_verdict_model. See
// scripts/lib-verdict-backfill.mjs for the plan, the audit and the guard.
//
// DRY RUN BY DEFAULT. Nothing is written without --write AND
// --approved-audit=<the dry-run audit file Simon approved>, and the write is
// refused unless the plan matches that audit row for row.
//
// Run: railway run -- node scripts/backfill-score-verdict-recompute.mjs [--audit-dir=DIR]
import { run } from './lib-verdict-backfill.mjs';

const dirArg = process.argv.find((a) => a.startsWith('--audit-dir='));
await run({
  mode: 'recompute', since: '2026-09-22T00:00:00Z', argv: process.argv, env: process.env,
  auditDir: dirArg ? dirArg.slice('--audit-dir='.length) : process.cwd(),
  name: 'rvp-score-verdict-recompute',
});
