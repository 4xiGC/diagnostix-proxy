// ════════════════════════════════════════════════════════════════════════════
// WHAT A RUN RECORDS ABOUT ITSELF (2026-09-30, B5; Simon Q27).
//
// Built at the end of /diagnose and carried on the report (so it reaches
// pending_reports and subscribers.baseline_report with it) and on the
// benchmark row (a nullable `provenance` column, drafted in
// overnight\migration-rvp-provenance-DRAFT.sql). Pure.
//
// PROMPT VERSIONS are dated ids ending in the first 12 hex characters of the
// sha256 of the prompt's SOURCE TEXT in server.js (the template literal as
// written, before any restaurant's data is interpolated). test/provenance.test.js
// recomputes the hash, so a prompt edited without a new id fails the suite.
// Limits, stated: COMPARISON_RULE is interpolated into p2 and the summary and
// lives in lib-comparisons.js, so a change to the rule alone does not move the
// p2 hash; the summary prompt is assembled from an array and carries a dated
// id only.
// ════════════════════════════════════════════════════════════════════════════
import { OVERALL_METHOD_VERSION } from './lib-score.js';

export const PROMPT_VERSIONS = Object.freeze({
  'diagnose-p1': 'p1-2026-09-29-0ced20243c98',
  // 2026-10-01: the call gained the flagged plan rule (lib-plan-prompt.js). With the
  // flag off the text SENT is identical to p2-2026-09-29; the source moved, so the id did.
  'diagnose-p2': 'p2-2026-10-01-plan-flag-8b25ce616f9e',
  'diagnose-summary': 'summary-2026-09-29-comparison-rule',
});

// RVP HAS NO MODEL-RATED CONFIDENCE. Its only measure of how much the reading
// can bear is the coverage gate (lib-review-gate.js): pass, limited, or not
// judged. So the level is the coverage state in words, and the basis says so.
// FOR SIMON'S APPROVAL: the three words and the sentence shape.
export function rvpConfidence(coverage) {
  const c = coverage && typeof coverage === 'object' ? coverage : null;
  const n = c && typeof c.subjectReviewCount === 'number' ? c.subjectReviewCount : null;
  if (!c || !c.state) return { level: 'not assessed', basis: 'no coverage reading (an Analytics peer run, or no confirmed place)' };
  if (c.state === 'limited') return { level: 'limited', basis: 'coverage limited: ' + (n ?? 'an unknown number of') + ' Google reviews, below the rule for a full reading' };
  if (c.state === 'pass') return { level: 'standard', basis: 'coverage pass: ' + (n ?? 'an unknown number of') + ' Google reviews, the rule met' };
  return { level: 'not assessed', basis: 'coverage state ' + String(c.state) };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// passes: the model calls the request made, as claude() recorded them
// ({ label, model, input, output, ms }). Two calls under one label (a parse
// retry, a gate retry) are ONE pass with `calls` > 1 and summed tokens.
// promptSuffixes (2026-10-01): an addition a flag appends to a prompt, recorded
// after that prompt's id (the B1 plan rule: { 'diagnose-p2': '+plan-...' }).
export function buildProvenance({ passes, coverage, durationMs, promptSuffixes = {}, now = () => new Date().toISOString() }) {
  const versions = Object.fromEntries(Object.entries(PROMPT_VERSIONS).map(([k, v]) => [k, v + (promptSuffixes[k] || '')]));
  const byLabel = new Map();
  for (const p of Array.isArray(passes) ? passes : []) {
    const k = String(p.label || 'model');
    const was = byLabel.get(k);
    if (!was) {
      byLabel.set(k, { label: k, model: p.model || null, promptVersion: versions[k] || null,
        inputTokens: num(p.input), outputTokens: num(p.output), ms: num(p.ms) });
    } else {
      was.calls = (was.calls || 1) + 1;
      was.inputTokens = was.inputTokens === null || num(p.input) === null ? null : was.inputTokens + p.input;
      was.outputTokens = was.outputTokens === null || num(p.output) === null ? null : was.outputTokens + p.output;
      was.ms = (was.ms || 0) + (num(p.ms) || 0);
    }
  }
  return {
    methodVersion: OVERALL_METHOD_VERSION,
    passes: [...byLabel.values()],
    promptVersions: versions,
    confidence: rvpConfidence(coverage),
    durationMs: num(durationMs),
    writtenAt: now(),
  };
}

// What the harness's "complete provenance" count checks. Empty means complete.
export function missingProvenance(p) {
  const miss = [];
  if (!p || typeof p !== 'object') return ['provenance'];
  if (!p.methodVersion) miss.push('methodVersion');
  if (!p.confidence || !p.confidence.level) miss.push('confidence');
  if (num(p.durationMs) === null) miss.push('durationMs');
  if (!Array.isArray(p.passes) || !p.passes.length) miss.push('passes');
  for (const x of p.passes || []) {
    if (!x.model) miss.push('model:' + x.label);
    if (!x.promptVersion) miss.push('promptVersion:' + x.label);
    if (x.inputTokens === null || x.outputTokens === null) miss.push('tokens:' + x.label);
  }
  return miss;
}
