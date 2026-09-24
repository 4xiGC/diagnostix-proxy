// ════════════════════════════════════════════════════════════════════════════
// THE TEST SUITE REFUSES TO RUN AGAINST A PRODUCTION DATABASE.
//
// `npm test` runs this first. It exits 1, and no test runs, when any
// environment variable whose NAME contains SUPABASE and URL points at one of
// the three DiagnostiX production projects.
//
// Why (2026-09-24): an integrity harness ran the suites under `railway run`.
// Tests that set no database URL inherited production's; the EVP suite wrote
// two test rows into evp_assessments and RVP tests sent three real alerts
// through Resend. The project reference is a host name, not a secret.
//
// Deliberately NOT a check on the name "production" or on NODE_ENV: those are
// what a shell happens to say, and the host is what the requests reach.
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
