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

import { findContradictions, rankFacts } from './lib-comparisons.js';

// THE REWRITE'S MECHANICAL CHECKS (moved here from overnight\rewrite-field.js on
// 2026-10-02, so they are tested in the repo). A rewrite passes only when:
//   1. the comparison check finds nothing in the new text (with the subject's
//      own rating, when given, so "higher-rated" is checked too);
//   2. every number in the old passage is still in the new one, and no number
//      is added, EXCEPT a rank on a list of known size ("#95 of 117"), which
//      may go, as a pair, only as its percentile (the second pass, Simon
//      2026-09-26) or not at all;
//   3. no em or en dash;
//   4. the length is within 60 to 140 percent of the old.
const numbersIn = (t) => (String(t).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ''));
export function rewriteProblems(before, after, opts = {}) {
  const p = [];
  const flags = findContradictions({ passage: after }, { subjectRating: opts.subjectRating });
  if (flags.length) p.push('the comparison check still flags it: ' + flags.map((f) => f.kind + ' ' + f.detail).join('; '));
  const facts = rankFacts(before);
  const mayGo = new Set(facts.flatMap((f) => [String(f.n), String(f.size)]));
  const mayCome = new Set(facts.map((f) => String(f.pct)));
  const inAfter = numbersIn(after), inBefore = numbersIn(before);
  const lost = inBefore.filter((n) => !inAfter.includes(n) && !mayGo.has(n));
  if (lost.length) p.push('numbers dropped: ' + lost.join(', '));
  const added = inAfter.filter((n) => !inBefore.includes(n) && !mayCome.has(n));
  if (added.length) p.push('numbers added: ' + added.join(', '));
  if (/[–—]/.test(after)) p.push('a dash');
  const ratio = String(after).length / Math.max(1, String(before).length);
  if (ratio < 0.6 || ratio > 1.4) p.push('length ' + Math.round(ratio * 100) + ' percent of the old');
  return p;
}

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
