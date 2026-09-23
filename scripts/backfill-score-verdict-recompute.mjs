// score_verdict backfill, recompute: every row carrying the model's verdict gets the band of its own computed score: the whole table, one rule (Simon, 2026-09-24).
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
  mode: 'recompute', since: null, argv: process.argv, env: process.env,
  auditDir: dirArg ? dirArg.slice('--audit-dir='.length) : process.cwd(),
  name: 'rvp-score-verdict-recompute',
});
