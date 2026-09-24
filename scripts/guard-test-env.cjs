// ════════════════════════════════════════════════════════════════════════════
// THE TEST SUITE REFUSES TO RUN AGAINST A PRODUCTION DATABASE, AND EVERYTHING
// IT SENDS SAYS IT CAME FROM A TEST.
//
// `npm test` runs `node scripts/guard-test-env.cjs --test`. The guard exits 1,
// and no test runs, when any environment variable whose NAME contains SUPABASE
// and URL points at one of the three DiagnostiX production projects.
// Otherwise, given --test, it runs `node --test` itself with
// DIAGNOSTIX_TEST_RUN=1 set, and exits with the suite's status.
//
// Why (2026-09-24): an integrity harness ran the suites under `railway run`.
// Tests that set no database URL inherited production's; the EVP suite wrote
// two test rows into evp_assessments and RVP tests sent three real alerts
// through Resend. The project reference is a host name, not a secret.
//
// THE MARKER (Simon, 2026-09-24): a suite can still hold a live mail key, so
// every email sender prefixes "[TEST RUN] " to the subject while
// DIAGNOSTIX_TEST_RUN is "1". A separate process cannot set another's
// environment, which is why the guard starts the suite rather than preceding
// it with `&&`.
//
// Deliberately NOT a check on the name "production" or on NODE_ENV: those are
// what a shell happens to say, and the host is what the requests reach.
//
// This file is byte-identical in diagnostix-proxy, diagnostix-svp,
// diagnostix-evp and diagnostix-analytics.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const PRODUCTION = {
  gxinqurxmstvoovfbgqr: 'RVP and Analytics',
  vdjnufvfyopuolxvheqk: 'EVP',
  gowyzlhqccaiybyjjqwp: 'SVP',
};

const hits = [];
for (const [name, value] of Object.entries(process.env)) {
  if (!/SUPABASE/i.test(name) || !/URL/i.test(name)) continue;
  for (const [ref, product] of Object.entries(PRODUCTION)) {
    if (String(value || '').toLowerCase().includes(ref)) hits.push(name + ' points at the ' + product + ' production project (' + ref + ')');
  }
}

if (hits.length) {
  console.error('REFUSED: this test suite will not run against a production database.');
  for (const h of hits) console.error('  ' + h);
  console.error('Run it without production credentials (not under `railway run`). No test was started.');
  process.exit(1);
}

const at = process.argv.indexOf('--test');
if (at !== -1) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(at + 1)], {
    stdio: 'inherit',
    env: { ...process.env, DIAGNOSTIX_TEST_RUN: '1' },
  });
  process.exit(r.status == null ? 1 : r.status);
}
