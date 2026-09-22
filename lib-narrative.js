// ════════════════════════════════════════════════════════════════════════════
// THE NARRATIVE GATE (v8.11.52)
//
// The overall score is computed from the six pillars. The prose was written by
// a model that had been told the score was about seven points higher, and the
// prose was never regenerated. So a report can print "Fair" on the cover above
// a summary saying the restaurant "delivers a strong farm to table California
// dining experience".
//
// MEASURED TWICE, BY TWO DETECTORS, AND BOTH NUMBERS ARE GIVEN BECAUSE THEY
// ARE NOT THE SAME MEASUREMENT.
//
// 2026-09-22, overnight/rvp-narrative-gate.js in real Chrome, reading the
// rendered page, with a NARROWER vocabulary than this file ships:
//
//     summaries containing a band word    92 of 103
//     CONTRADICTIONS                     109
//     PAGES CARRYING AT LEAST ONE         47 of 103
//     higher 91, lower 18
//
// THIS MODULE, over the stored executiveSummary field, 105 reports checked:
//
//     CONTRADICTIONS                     119
//     PAGES CARRYING AT LEAST ONE         66 of 105
//     higher 96, lower 23
//     clean                               39
//
// THE DIFFERENCE IS THE VOCABULARY, NOT DRIFT AND NOT THE CORPUS. This file
// carries five words the harness did not: world class, robust, uneven,
// inconsistent and lagging, brought over from the SVP version of the same
// gate. They find nineteen more pages. Whether that is a better detector or a
// noisier one is NOT SETTLED: the wider words were never checked against the
// aspect-claim problem the way the narrow ones were.
//
// THE FIRST FIGURES WERE WRITTEN INTO THIS HEADER AS THOUGH THEY DESCRIBED
// THIS CODE. They described the harness. overnight/narrative-module-check.js
// re-derives the second set with the shipped module and is the one to rerun
// after any change to the lists below.
//
// THE SKEW SURVIVES BOTH: 5 to 1 on the harness, 4.2 to 1 here. A word list
// catching positive adjectives at random would miss both ways. The same
// detector over SVP's 49 stored payloads split 27 to 27, dead even, and every
// one of its twelve worst cases turned out to be an aspect claim rather than a
// verdict. Two corpora, opposite answers, which is what says the RVP finding
// is real.
//
// ── WHAT THIS IS SCOPED TO, AND WHY IT MATTERS MORE THAN THE WORD LIST ─────
//
// THE EXECUTIVE SUMMARY ONLY. The first version of the harness read the whole
// rendered page and reported 725 contradictions across 103 reports. It was
// flagging "Excellent service quality" in a STRENGTHS list, "the quality of
// the food is very good" in a CUSTOMER REVIEW QUOTE, and "Zero organic reviews
// is critical failure" in a RISK.
//
// NONE OF THOSE CONTRADICTS A FAIR OVERALL. A Fair report is supposed to
// contain some excellent things and several critical ones; that is what puts
// the average in the middle. Flagging them makes this a word counter.
//
// Customer quotes are excluded on a second ground as well: they are somebody
// else's words and the report does not assert them.
//
// ── THE LIMIT, STATED ──────────────────────────────────────────────────────
//
// This has no syntax. It cannot tell "sustainability signal is weak" from "the
// restaurant is weak", and on SVP's corpus that distinction was the whole
// answer. It is a word list with a phrase exclusion list, and it is used here
// as a DELIVERY GATE with one retry rather than as a measurement, so a false
// positive costs one extra model call and a false negative costs what the
// situation costs today.
// ════════════════════════════════════════════════════════════════════════════

// The four bands and the words that name them. Same four names as
// lib-score.js VERDICT_BANDS, deliberately: a gate whose vocabulary drifted
// from the band table would pass sentences the cover contradicts.
export const BAND_WORDS = {
  'Excellent':       ['excellent', 'exceptional', 'outstanding', 'superb', 'world class', 'world-class'],
  'Good':            ['good', 'strong', 'solid', 'healthy', 'robust'],
  'Fair':            ['fair', 'mixed', 'middling', 'average', 'adequate', 'uneven', 'inconsistent'],
  'Needs Attention': ['poor', 'weak', 'critical', 'failing', 'struggling', 'lagging'],
};

const RANK = { 'Needs Attention': 0, 'Fair': 1, 'Good': 2, 'Excellent': 3 };

// Phrases in which a band word is NOT a verdict on the subject. Every one of
// these was observed in the live corpus, and they are listed rather than
// inferred so a reader can disagree with a specific one.
//
// THEY ARE PHRASE SCOPED, NOT WORD SCOPED. Excluding the word "good" because
// "good value" exists would empty the vocabulary.
export const NOT_A_VERDICT = [
  'good value', 'good news', 'good sign', 'good practice', 'goodwill',
  'good will', 'for good', 'good faith', 'as good as', 'good deal',
  'good luck', 'good measure', 'looks good', 'sounds good',
  'strongly', 'strong suit', 'strong smell', 'strong flavour', 'strong flavor',
  'fair trade', 'fair price', 'fairly', 'county fair', 'fair share',
  'average check', 'average spend', 'on average', 'average rating', 'average of',
  'critical gaps', 'critical to', 'critically', 'critical path', 'critical mass',
  'poorly', 'poor weather',
  'weakness', 'weaknesses', 'weakly',
  'mixed use', 'mixed-use', 'mixed methods',
  'healthcheck', 'health check', 'healthy margin',
  'solidly', 'leading to', 'leading edge',
];

// Every band word used as a verdict, with the band it names and enough
// context to quote back to the model on a retry.
export function bandWordsIn(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const lower = s.toLowerCase();
  const found = [];
  for (const band of Object.keys(BAND_WORDS)) {
    for (const w of BAND_WORDS[band]) {
      const pattern = w.replace(/[-\s]/g, '[- ]');
      const re = new RegExp('\\b' + pattern + '\\b', 'g');
      let m;
      while ((m = re.exec(lower)) !== null) {
        const around = lower.slice(Math.max(0, m.index - 24), m.index + w.length + 24);
        if (NOT_A_VERDICT.some((p) => around.includes(p))) continue;
        found.push({
          band, word: w,
          context: s.slice(Math.max(0, m.index - 40), m.index + w.length + 40).replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return found;
}

// Does this text name a band other than the one the report gives?
//
// NO BAND MEANS NO GATE. When there is no computed score there is no band, and
// nothing to contradict; refusing prose in that case would be inventing a rule
// out of an absence.
export function contradictsBand(text, band) {
  const target = RANK[band] === undefined ? null : band;
  if (!target) return { contradicts: false, hits: [], band: null };
  const hits = bandWordsIn(text)
    .filter((h) => h.band !== target)
    .map((h) => ({ ...h, direction: RANK[h.band] > RANK[target] ? 'higher' : 'lower' }));
  return { contradicts: hits.length > 0, hits, band: target };
}

// The sentence handed back to the model on a retry. It quotes the offending
// words rather than restating the rule, because the rule was in the prompt the
// first time and did not land.
export function retryInstruction(result) {
  const r = (result && typeof result === 'object') ? result : { hits: [] };
  const words = [...new Set((r.hits || []).map((h) => h.word))];
  if (!words.length) return '';
  return 'The previous attempt described this business as '
    + words.map((w) => '"' + w + '"') .join(', ')
    + ', which names a different band from the computed one (' + r.band + '). '
    + 'Write the summary again. Describe specific strengths and weaknesses by '
    + 'name, and do not characterise the business overall in a word that names '
    + 'a band other than ' + r.band + '.';
}
