// ════════════════════════════════════════════════════════════════════════════
// A REVISED FIELD SAYS SO, BESIDE THE FIELD (2026-09-30, B4).
//
// The field-level rewrite route (overnight\rewrite-field.js) writes the approved
// text into ONE field of a stored report and keeps what it replaced in
// meta.fieldRevisions[]: { path, text, at, model, reason }. The page prints a
// note beside that field. The note is about the SENTENCE, not the score: the
// score did not change, the wording did. COPY FOR SIMON'S APPROVAL.
//
// FIELD_REVISION_PATHS are the prose fields diagnose-p2 writes that can carry a
// comparison and that the page prints as one passage. The executive summary is
// not here: it has its own note (summaryRevisedNote in server.js).
// ════════════════════════════════════════════════════════════════════════════

export const FIELD_REVISION_PATHS = [
  /^competitiveInsight$/,
  /^actions\[\d+\]\.desc$/,
  /^competitors\[\d+\]\.note$/,
  /^commercialActions\[\d+\]\.desc$/,
];

const WHY = {
  comparison: 'so that its comparisons agree with their numbers',
};

export function fieldRevisionNote(report, path) {
  if (!FIELD_REVISION_PATHS.some((re) => re.test(String(path)))) return '';
  const revs = report && report.meta && Array.isArray(report.meta.fieldRevisions) ? report.meta.fieldRevisions : [];
  const mine = revs.filter((r) => r && r.path === path);
  if (!mine.length) return '';
  const last = mine[mine.length - 1];
  const t = Date.parse(last.at);
  const day = Number.isNaN(t) ? '' : ' on ' + new Date(t).toISOString().slice(0, 10);
  const why = WHY[last.reason] ? ' ' + WHY[last.reason] : '';
  return 'This passage was revised' + day + why + '. The wording first issued with this report is retained in our records.';
}
