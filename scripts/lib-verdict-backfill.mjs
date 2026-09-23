// ════════════════════════════════════════════════════════════════════════════
// THE score_verdict BACKFILL: THE PLAN, THE AUDIT, THE GUARDED WRITE.
//
// Simon's decisions of 2026-09-23 (BUILD_REPORT_2026-09-23, "score_verdict:
// SIMON'S DECISIONS"):
//   null-fill   rows whose cohort_extra.score_verdict is null get the band of
//               their own computed score
//   recompute   rows since 2026-09-22 that carry the MODEL's verdict get the
//               band of their own computed score
//   both        the old text is kept, as cohort_extra.score_verdict_model
//
// THE COMPUTED SCORE is the mean of the six stored pillar_scores, rounded half
// up, by lib-score.js computeOverall, banded by verdictFor. Nothing is copied.
//
// NO MIGRATION. cohort_extra is jsonb. A PostgREST PATCH REPLACES the column,
// so the patch carries every key the row already had.
//
// THE WRITE IS GUARDED on the value that was read: the PATCH filters on
// cohort_extra->>score_verdict, so a row changed since the dry run matches
// nothing and is reported, not overwritten.
// ════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { computeOverall, verdictFor, PILLAR_KEYS } from '../lib-score.js';

export function planVerdictBackfill(rows, { mode, since } = {}) {
  if (mode !== 'null-fill' && mode !== 'recompute') throw new Error('unknown mode: ' + mode);
  const plan = [];
  const skipped = [];
  for (const b of Array.isArray(rows) ? rows : []) {
    const ex = (b && b.cohort_extra && typeof b.cohort_extra === 'object') ? b.cohort_extra : {};
    const old = ex.score_verdict == null ? null : String(ex.score_verdict);
    if ('score_verdict_model' in ex) continue;            // already backfilled once
    if (mode === 'null-fill' && old !== null) continue;
    if (mode === 'recompute') {
      if (old === null) continue;
      if (!since || !(String(b.created_at) >= since)) continue;
    }
    const pillars = {};
    for (const k of PILLAR_KEYS) {
      const v = b.pillar_scores ? b.pillar_scores[k] : undefined;
      if (v !== undefined && v !== null) pillars[k] = { score: v };
    }
    const c = computeOverall(pillars);
    if (!c.ok) { skipped.push({ id: b.id, subject: b.subject_name, reason: c.reason }); continue; }
    const next = verdictFor(c.score);
    if (next === old) continue;
    plan.push({
      id: b.id, created_at: b.created_at, subject: b.subject_name, old, next, score: c.score, mode,
      guard: old === null ? 'cohort_extra->>score_verdict=is.null' : 'cohort_extra->>score_verdict=eq.' + old,
      patch: { cohort_extra: Object.assign({}, ex, { score_verdict: next, score_verdict_model: old }) },
    });
  }
  planVerdictBackfill.lastSkipped = skipped;
  return plan;
}
planVerdictBackfill.lastSkipped = [];

// One JSONL line per decision, flushed BEFORE anything is printed or written
// (the lib-audit.js rule from the overnight folder).
export function openAudit(dir, name) {
  const file = path.join(dir, 'audit-' + name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
  const write = (o) => fs.appendFileSync(file, JSON.stringify(Object.assign({ at: new Date().toISOString() }, o)) + '\n', 'utf8');
  return { file, write };
}

export async function readRvpRows({ url, key }) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(url + '/rest/v1/benchmarks?select=id,created_at,subject_name,overall_score,pillar_scores,cohort_extra&product=eq.rvp&order=created_at.asc',
      { headers: { apikey: key, Authorization: 'Bearer ' + key, Range: from + '-' + (from + 999) } });
    if (!r.ok) throw new Error('read benchmarks ' + r.status);
    const j = await r.json(); rows.push(...j); if (j.length < 1000) break;
  }
  return rows;
}

// The whole run: read, plan, audit, print; write only when asked AND when the
// plan is exactly the one a dry run already audited.
export async function run({ mode, since, argv, env, auditDir, name }) {
  const write = argv.includes('--write');
  const approved = (argv.find((a) => a.startsWith('--approved-audit=')) || '').slice('--approved-audit='.length);
  const url = env.SUPABASE_URL; const key = env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY are required (railway run)');
  const rows = await readRvpRows({ url, key });
  const plan = planVerdictBackfill(rows, { mode, since });
  const audit = openAudit(auditDir, name + (write ? '-WRITE' : '-dry-run'));
  for (const p of plan) audit.write({ kind: 'decision', rowId: p.id, subject: p.subject, action: write ? 'will-write' : 'would-write', old: p.old, next: p.next, score: p.score, guard: p.guard });
  for (const s of planVerdictBackfill.lastSkipped) audit.write({ kind: 'skip', rowId: s.id, subject: s.subject, reason: s.reason });

  console.log((write ? 'WRITE RUN' : 'DRY RUN, NOTHING WRITTEN') + ': ' + mode + (since ? ' since ' + since : '') + ', ' + rows.length + ' rvp rows read, ' + plan.length + ' planned, ' + planVerdictBackfill.lastSkipped.length + ' skipped');
  for (const p of plan) console.log([p.id, String(p.created_at).slice(0, 16), JSON.stringify(p.subject), p.old || 'null', '->', p.next, p.score].join(' | '));
  for (const s of planVerdictBackfill.lastSkipped) console.log('SKIPPED ' + s.id + ' ' + JSON.stringify(s.subject) + ' ' + s.reason);
  console.log('audit: ' + audit.file);
  if (!write) return { plan, wrote: 0 };

  // A write must match an approved dry run row for row, or nothing is sent.
  if (!approved || !fs.existsSync(approved)) throw new Error('--write needs --approved-audit=<the dry-run audit file Simon approved>');
  const ok = fs.readFileSync(approved, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'decision')
    .map((x) => x.rowId + ':' + x.next).sort().join(',');
  const now = plan.map((p) => p.id + ':' + p.next).sort().join(',');
  if (ok !== now) throw new Error('the plan differs from the approved dry run; nothing written. Rerun the dry run and approve it.');
  let wrote = 0;
  for (const p of plan) {
    const r = await fetch(url + '/rest/v1/benchmarks?id=eq.' + p.id + '&' + p.guard, {
      method: 'PATCH', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(p.patch) });
    const body = r.ok ? await r.json() : [];
    const landed = Array.isArray(body) && body.length === 1;
    audit.write({ kind: 'write', rowId: p.id, status: r.status, landed });
    if (landed) wrote += 1; else console.log('NOT WRITTEN ' + p.id + ' status ' + r.status + (r.ok ? ' (the row changed since the dry run)' : ''));
  }
  console.log('wrote ' + wrote + ' of ' + plan.length);
  return { plan, wrote };
}
