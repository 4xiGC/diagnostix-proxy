// ════════════════════════════════════════════════════════════════════════════
// THE SUITE REFUSES TO RUN AGAINST A PRODUCTION DATABASE.
//
// Found 2026-09-24: an integrity harness ran the suites under `railway run`.
// Tests that set no database URL of their own inherited PRODUCTION's: the EVP
// suite wrote two test rows into evp_assessments (deleted since, with
// before-images), and RVP tests sent three real "summary-gate-failed" alerts
// through Resend (00:12:24Z, 00:38:55Z, 00:39:00Z). The harness now strips
// credentials; this guard is the second line, in every repo:
//
//   `npm test` runs scripts/guard-test-env.cjs FIRST. It exits non-zero, and
//   no test runs, when ANY environment variable naming a Supabase URL points
//   at one of the three production projects.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const GUARD = path.join(REPO, 'scripts', 'guard-test-env.cjs');
const PROD = { rvp_analytics: 'gxinqurxmstvoovfbgqr', evp: 'vdjnufvfyopuolxvheqk', svp: 'gowyzlhqccaiybyjjqwp' };

function guard(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/SUPABASE/i.test(k)));
  return spawnSync(process.execPath, [GUARD], { env: { ...clean, ...env }, encoding: 'utf8' });
}

test('the guard REFUSES each production project, whichever variable carries it', () => {
  for (const [name, ref] of Object.entries(PROD)) {
    for (const v of ['SUPABASE_URL', 'ANALYTICS_SUPABASE_URL', 'EVP_SUPABASE_URL']) {
      const r = guard({ [v]: 'https://' + ref + '.supabase.co' });
      assert.notEqual(r.status, 0, v + ' at ' + name + ' was allowed');
      assert.match(r.stdout + r.stderr, /REFUSED/);
      assert.match(r.stdout + r.stderr, new RegExp(v));
    }
  }
});

test('CONTROL: a test database URL, or none, is allowed', () => {
  assert.equal(guard({ SUPABASE_URL: 'https://db.invalid' }).status, 0);
  assert.equal(guard({}).status, 0);
});

test('the guard runs BEFORE the tests: npm test starts with it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /^node scripts\/guard-test-env\.cjs && node --test/);
});
