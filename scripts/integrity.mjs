// ════════════════════════════════════════════════════════════════════════════
// THE INTEGRITY REGRESSION HARNESS: EVERY GATE, ONE COMMAND, ONE TABLE.
//
// Run quarterly (or after any release) from this checkout:
//     railway run -- npm run integrity
// Every gate the program built runs against ALL stored payloads, and one
// summary table prints with a verdict per gate and a final PASS or FAIL line.
//
// The gate scripts live beside the measurements (GATES_DIR, default
// ../diagnostix-svp-measurements/overnight). Each runs as a child process with
// this process's environment (the railway credentials), and its verdict is
// READ FROM ITS OWN OUTPUT or result file, never assumed:
//   PASS      the gate printed its green line (GATE GREEN, ALL N CHECKS
//             PASSED, "PASS:") or its result file says so
//   FAIL      it printed a red line (GATE FAILED, CHECK(S) FAILED, "FAIL",
//             CONTROLS FAILED); a red line always beats a green one
//   ERROR     it exited non-zero with no verdict line
//   MEASURED  a measurement with no pass rule; its counts are printed
//   SKIPPED   cannot run at zero spend or without an input; the reason is shown
// The final line is FAIL when any gate is FAIL or ERROR.
//
// READ ONLY: every gate here only reads tables. Nothing is written.
// ════════════════════════════════════════════════════════════════════════════
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATES_DIR = process.env.GATES_DIR || path.resolve(REPO, '..', 'diagnostix-svp-measurements', 'overnight');

export function parseVerdict(stdout, code) {
  const out = String(stdout || '');
  const red = /GATE FAILED|CHECK\(S\) FAILED|CONTROLS FAILED|^FAIL\b/m.test(out);
  const green = /GATE GREEN|ALL \d+ CHECKS PASSED|^PASS\b/m.test(out);
  if (red) return 'FAIL';
  if (green) return 'PASS';
  return code === 0 ? null : 'ERROR';
}

export function suiteCounts(stdout) {
  const n = (k) => { const m = String(stdout).match(new RegExp('ℹ ' + k + ' (\\d+)')); return m ? Number(m[1]) : null; };
  return { tests: n('tests'), pass: n('pass'), fail: n('fail') };
}

// THE SUITE NEVER SEES A PRODUCTION CREDENTIAL. Found by the first full run
// (2026-09-25): under railway run, tests that do not set their own database URL
// inherited production's, and one wrote two test rows into evp_assessments. The
// gates read tables and keep the credentials; the suite gets them stripped.
const CREDENTIAL = /SUPABASE|ANTHROPIC|SERPER|RESEND|WIX|GOOGLE|PLACES|HUBSPOT|RAILWAY|ANALYTICS|SECRET|PASSWORD|TOKEN|_KEY$|API_KEY/i;
export function suiteEnv(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([k]) => !CREDENTIAL.test(k)));
}

function run(cmd, args, { cwd = REPO, timeoutMs = 90 * 60 * 1000, env = process.env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && cmd === 'npm' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}

export async function runGates(gates, title) {
  const rows = [];
  for (const g of gates) {
    const started = Date.now();
    let verdict = 'SKIPPED', counts = g.skip || '';
    if (!g.skip) {
      const script = g.script ? path.join(GATES_DIR, g.script) : null;
      if (script && !fs.existsSync(script)) { verdict = 'ERROR'; counts = 'gate script missing: ' + script; }
      else {
        const r = g.npm ? run('npm', ['test'], { env: suiteEnv(process.env) }) : run(process.execPath, [script, ...(g.args || [])], { cwd: g.cwd || REPO });
        if (r.timedOut) { verdict = 'ERROR'; counts = 'timed out'; }
        else {
          const parsed = g.parse ? g.parse(r.out, r.code) : null;
          verdict = (parsed && parsed.verdict) || parseVerdict(r.out, r.code) || (g.measure ? 'MEASURED' : (r.code === 0 ? 'MEASURED' : 'ERROR'));
          counts = (parsed && parsed.counts) || (g.counts ? g.counts(r.out) : '');
        }
      }
    }
    rows.push({ name: g.name, verdict, counts, s: Math.round((Date.now() - started) / 1000) });
    console.log('[integrity] ' + g.name + ': ' + verdict + (counts ? '  ' + counts : ''));
  }
  const failed = rows.filter((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR');
  console.log('\n' + title + ', ' + new Date().toISOString());
  console.log('='.repeat(110));
  console.log('gate'.padEnd(44) + 'verdict'.padEnd(10) + 'secs'.padStart(6) + '  counts');
  for (const r of rows) console.log(r.name.padEnd(44) + r.verdict.padEnd(10) + String(r.s).padStart(6) + '  ' + String(r.counts).slice(0, 140));
  console.log('='.repeat(110));
  console.log(failed.length ? 'FAIL: ' + failed.length + ' gate(s): ' + failed.map((r) => r.name).join(', ')
    : 'PASS: every gate that has a pass rule passed (' + rows.filter((r) => r.verdict === 'PASS').length + '), '
      + rows.filter((r) => r.verdict === 'MEASURED').length + ' measured, ' + rows.filter((r) => r.verdict === 'SKIPPED').length + ' skipped');
  return failed.length ? 1 : 0;
}

// ── THE RVP GATES ───────────────────────────────────────────────────────────
const line = (re) => (out) => { const m = String(out).match(re); return m ? m[0].replace(/\s+/g, ' ').trim() : ''; };
export const RVP_GATES = [
  { name: 'suite (incl. in-suite Chrome gates)', npm: true,
    parse: (out) => { const c = suiteCounts(out); return { verdict: c.fail === 0 && c.pass > 0 ? 'PASS' : 'FAIL', counts: c.pass + ' of ' + c.tests + ' pass' }; } },
  { name: 'print at Letter and A4, every report (Chrome)', script: 'print-gate-all.js', counts: line(/ALL \d+ CHECKS PASSED|\d+ CHECK\(S\) FAILED/) },
  { name: 'verdict words match the computed band (Chrome)', script: 'rvp-narrative-gate.js', counts: line(/(PASS|FAIL): [^\n]*/) },
  { name: 'benchmark score_verdict is its own band', script: 'rvp-verdict-consistency.mjs',
    counts: line(/rvp rows \d+, scored \d+, null verdicts \d+, verdicts off their own band \d+/) },
  { name: 'statistics tied to a stored input (Stage 4)', script: 'rvp-stat-shapes.mjs', measure: true,
    counts: line(/reports \d+, statistics \d+, tied \d+ \(\d+%\)/) },
  { name: 'review-count coverage gate', skip: 'SKIPPED: not built; the focal Places count is not stored (RVP_SAFEGUARDS_SPEC.md)' },
];

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await runGates(RVP_GATES, 'RVP INTEGRITY');
}
