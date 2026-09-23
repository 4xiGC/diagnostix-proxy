// score_verdict backfill, null-fill: rows whose cohort_extra.score_verdict is null get the band of their own computed score.
// The old text is kept as cohort_extra.score_verdict_model. See
// scripts/lib-verdict-backfill.mjs for the plan, the audit and the guard.
//
// DRY RUN BY DEFAULT. Nothing is written without --write AND
// --approved-audit=<the dry-run audit file Simon approved>, and the write is
// refused unless the plan matches that audit row for row.
//
// Run: railway run -- node scripts/backfill-score-verdict-null-fill.mjs [--audit-dir=DIR]
import { run } from './lib-verdict-backfill.mjs';

const dirArg = process.argv.find((a) => a.startsWith('--audit-dir='));
await run({
  mode: 'null-fill', since: null, argv: process.argv, env: process.env,
  auditDir: dirArg ? dirArg.slice('--audit-dir='.length) : process.cwd(),
  name: 'rvp-score-verdict-null-fill',
});
