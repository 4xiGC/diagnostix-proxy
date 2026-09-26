// ════════════════════════════════════════════════════════════════════════════
// ONE RANKED ACTION PLAN (2026-10-01, recommendation 9, B1).
//
// Stored reports carry `actions` (operational, each with a priority) and
// `commercialActions` (tied to the owner's numbers, each with an evidence line).
// They rendered as two sections at the END of the report. The plan merges them
// into one ranked list the page shows FIRST:
//   urgent operational, then commercial, then 30-day, then ongoing, each in its
//   stored order (the model's own order within a priority is kept).
// A report written under the flagged prompt carries `plan` directly; it is used
// as written.
//
// NOTHING IS INVENTED. owner, horizon, indicator and finding are the payload's
// own fields: `horizon` is "30 days" only for the 30-day priority ("urgent" and
// "ongoing" say nothing about when), and a commercial action's `evidence` is its
// finding. A missing field is null and the page prints no label for it.
// Items whose titles normalise to the same words merge (the first is kept).
// Pure; never throws.
// ════════════════════════════════════════════════════════════════════════════

const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function buildActionPlan(report) {
  const r = (report && typeof report === 'object') ? report : {};
  if (Array.isArray(r.plan) && r.plan.length) {
    return r.plan.filter((p) => p && typeof p === 'object').map((p, i) => ({
      title: s(p.title) || '', desc: s(p.desc) || '', owner: s(p.owner), horizon: s(p.horizon), indicator: s(p.indicator),
      finding: s(p.finding), priority: s(p.priority), source: 'plan[' + i + ']',
    }));
  }
  const actions = (Array.isArray(r.actions) ? r.actions : []).map((a, i) => ({ a, i }));
  const commercial = (Array.isArray(r.commercialActions) ? r.commercialActions : []).map((a, i) => ({ a, i }));
  const pick = (p) => actions.filter(({ a }) => ((a && a.priority) || 'ongoing') === p);
  const ranked = [
    ...pick('urgent').map(({ a, i }) => ({ a, source: 'actions[' + i + ']', kind: 'operational' })),
    ...commercial.map(({ a, i }) => ({ a, source: 'commercialActions[' + i + ']', kind: 'commercial' })),
    ...pick('30days').map(({ a, i }) => ({ a, source: 'actions[' + i + ']', kind: 'operational' })),
    ...actions.filter(({ a }) => !['urgent', '30days'].includes((a && a.priority) || 'ongoing')).map(({ a, i }) => ({ a, source: 'actions[' + i + ']', kind: 'operational' })),
  ];
  const seen = new Set();
  const out = [];
  for (const { a, source, kind } of ranked) {
    if (!a || typeof a !== 'object') continue;
    const key = norm(a.title);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({
      title: s(a.title) || '', desc: s(a.desc) || '',
      owner: s(a.owner), horizon: s(a.horizon) || (a.priority === '30days' ? '30 days' : null),
      indicator: s(a.indicator), finding: s(a.finding) || s(a.evidence),
      priority: kind === 'commercial' ? 'commercial' : ((a.priority) || 'ongoing'), source,
    });
  }
  return out;
}
