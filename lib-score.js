// ════════════════════════════════════════════════════════════════════════════
// THE OVERALL SCORE, COMPUTED FROM THE PILLARS THE REPORT PRINTS (v8.11.50)
//
// RVP's healthCheckScore is produced by the model in the SAME JSON object as
// the six pillars, and nothing has ever checked that it is the mean of them.
//
// MEASURED 2026-09-22 across the 103 stored reports that carry six pillars and
// a typed score (overnight/rvp-score-measure.js, SELECT only):
//
//     typed HIGHER than the mean of the pillars    102 of 103    99.0%
//     identical                                      1 of 103     1.0%
//     typed LOWER                                    0 of 103     0.0%
//     median delta +7   mean delta +6.28   range 0 to +11
//
// ONE-DIRECTIONAL, WHICH IS WHAT SAYS IT IS NOT ROUNDING NOISE. A model that
// rounded badly would miss both ways. This misses one way, every time, so the
// printed total has been reliably kinder than the six numbers printed beside
// it. That is the defect: not that the number is wrong in the abstract, but
// that the report shows its working and the working does not add up.
//
// Worked example, Teclados 2026-05-18: pillars 66, 70, 42, 48, 58, 72 sum to
// 356, over 6 is 59.333, so 59. The delivered report said 68.
//
// THE RULE. Round half UP on the mean of the six pillar scores. Half up, so a
// reader who adds the six printed numbers and divides gets the printed total.
// This is the rule SVP shipped as lib-pillars.js, deliberately: two products
// that both average six pillars should not disagree about how.
//
// NO FALLBACK, ANYWHERE IN THIS FILE. If the six pillars are not all present
// and in range there is NO SCORE, and the caller prints a sentence saying so.
// Falling back to healthCheckScore would reintroduce the exact number this
// exists to replace, silently, on precisely the payloads nobody inspected.
// ════════════════════════════════════════════════════════════════════════════

// The six the report actually renders. Not a guess: these are the keys in the
// prompt's own JSON schema, and the keys every stored payload carries.
export const PILLAR_KEYS = ['cs', 'pa', 'es', 'sm', 'cp', 'bg'];

export const OVERALL_METHOD_VERSION = 'rvp-overall-mean-v1';

export const NO_SCORE_SENTENCE =
  'This report does not carry an overall score, because one or more of the six '
  + 'pillars could not be measured. The pillar scores below stand on their own.';

// ── THE BANDS ───────────────────────────────────────────────────────────────
//
// THERE WERE NO BANDS TO RECOVER. The prompt names four verdicts and gives
// numbers only for pillar STATUS, so no numeric band table has ever existed in
// this code. And the model's own labels do not separate: Excellent and Good
// both occur at a typed 82, so the verdict is not a threshold function of the
// score and no table could reproduce it. Re-deriving bands therefore means
// CHOOSING cutoffs and being able to say why, which is what this is.
//
// WHAT THE MODEL PRODUCED, on 103 reports:  Good 95 (92.2%), Fair 6 (5.8%),
// Excellent 2 (1.9%), Needs Attention 0. A verdict that says "Good" to
// nine customers in ten is not carrying information.
//
// CHOSEN: the prompt's own pillar cutoffs. The overall is now the mean of the
// pillars, so it lives on the pillar scale, and that scale already has
// published numbers the product uses to colour every pillar tile: good >= 65,
// warn 45 to 64, bad < 45. Excellent at 80. Nothing is invented, and the
// report can state where the numbers come from. It is also the only candidate
// that keeps the overall consistent with the tiles beside it: under any other
// table a report can show four amber pillars and a green total.
//
// WHAT IT COSTS, measured, and this is the reason Part 5 stops for review:
//
//     BEFORE (the model's words)   Good 95   Fair 6    Excellent 2   NA 0
//     AFTER  (computed, this table) Good 46  Fair 56   Excellent 1   NA 0
//     movement: 52 unchanged, 51 told something WORSE, 0 better
//
// THE TWO CANDIDATES NOT CHOSEN, kept so the decision can be revisited without
// redoing the measurement:
//
//   B  [50, 60, 75]  shifted down by the measured inflation. Puts almost
//      everyone in the same words as today (99 unchanged, 2 worse, 2 better)
//      while the NUMBER becomes honest. REJECTED as the default because its
//      cutoffs are reverse engineered from the inflated distribution, so it
//      preserves the inflation one level up, and because it would let a
//      60 overall sit above four amber pillars.
//   C  [58, 65, 72]  quartiles of the computed distribution. Discriminates
//      best and is a grading curve rather than a measurement: a restaurant's
//      verdict would depend on who else had bought a report.
//
// Switching is one line. The measurement behind all three is in
// overnight/rvp-score-measure.js and does not need rerunning to change this.
export const VERDICT_BANDS = [
  { min: 80, name: 'Excellent' },
  { min: 65, name: 'Good' },
  { min: 45, name: 'Fair' },
  { min: 0,  name: 'Needs Attention' },
];

// Half UP. Written out rather than using Math.round, which is
// half-away-from-zero and happens to agree only because every score here is
// positive. Someone later handling a negative should find the intent stated.
function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

// Returns { ok, score, mean, sum, values, reason }.
//
// score is null whenever ok is false, and the caller must print
// NO_SCORE_SENTENCE rather than substituting anything.
export function computeOverall(pillars, _reportIgnoredOnPurpose) {
  const fail = (reason) => ({ ok: false, score: null, mean: null, sum: null, values: [], reason });

  if (!pillars || typeof pillars !== 'object' || Array.isArray(pillars)) {
    return fail('no-pillars-object');
  }

  const values = [];
  for (const key of PILLAR_KEYS) {
    const p = pillars[key];
    if (!p || typeof p !== 'object' || Array.isArray(p)) return fail('pillar-missing:' + key);
    const v = p.score;
    // Number('') is 0 and Number(null) is 0, so the type is checked before the
    // value. A blank pillar must not average in as a zero.
    if (typeof v !== 'number' || !Number.isFinite(v)) return fail('pillar-not-a-number:' + key);
    if (v < 0 || v > 100) return fail('pillar-out-of-range:' + key);
    values.push(v);
  }

  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / PILLAR_KEYS.length;
  return { ok: true, score: roundHalfUp(mean), mean, sum, values, reason: 'computed' };
}

// The arithmetic, written out so a reader can redo it. Empty string when there
// is no score: a formula for a number that is not shown is worse than none.
export function overallFormula(result) {
  const r = (result && typeof result === 'object') ? result : null;
  if (!r || r.ok !== true || !Array.isArray(r.values) || r.values.length !== PILLAR_KEYS.length) {
    return '';
  }
  const meanText = Number.isInteger(r.mean) ? String(r.mean) : r.mean.toFixed(1);
  return r.values.join(' + ') + ' = ' + r.sum
    + ', divided by ' + PILLAR_KEYS.length + ' = ' + meanText
    + ', rounded to ' + r.score;
}

// NO SCORE MEANS NO VERDICT. A verdict invented for a missing score is a claim
// about a measurement that was never made.
export function verdictFor(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  for (const band of VERDICT_BANDS) {
    if (score >= band.min) return band.name;
  }
  return null;
}
