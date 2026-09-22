// ════════════════════════════════════════════════════════════════════════════
// THE NARRATIVE GATE (v8.11.52)
//
// The overall score is computed from the six pillars. The prose was written by
// a model that had been told the score was about seven points higher, and the
// prose was never regenerated. So a report can print "Fair" on the cover above
// a summary saying the restaurant "delivers a strong farm to table California
// dining experience".
//
// MEASURED, AND RECONCILED WITH THE HARNESS THAT FIRST MEASURED IT.
//
// 2026-09-22, overnight/rvp-narrative-gate.js in real Chrome:
//
//     CONTRADICTIONS                     109
//     PAGES CARRYING AT LEAST ONE         47 of 103
//     higher 91, lower 18
//
// THIS MODULE, over the stored executiveSummary field, 105 reports:
//
//     CONTRADICTIONS, blocking words     114
//     rows carrying at least one          66 of 105
//     DISTINCT (name, score) pairs        49   <- the comparable number
//     higher 95, lower 19
//     warning-only word instances          5   (never block)
//
// I EXPLAINED THE GAP WRONG TWICE BEFORE GETTING IT RIGHT, and the wrong
// explanations are worth more than the right one.
//
//   FIRST I SAID the difference was the vocabulary, because this module had
//   carried five extra words over from the SVP gate. Removing them moved the
//   count by FIVE WORD INSTANCES and by ZERO PAGES. The attribution was
//   confident and unmeasured.
//
//   THEN, measuring, THE REAL CAUSE: the harness deduplicated by name and
//   score, and this corpus repeats restaurants heavily. 66 rows collapse to
//   49 subjects. 47 against 49 is the corpus having grown by two reports
//   since, which is the whole remaining difference.
//
// SO 66 AND 47 WERE NEVER THE SAME QUANTITY. One counts delivered reports,
// the other counts distinct subject-and-score pairs. Both are right about
// what they count, and quoting either without saying which is the error.
//
// THE SKEW SURVIVES EVERY CUT: 5.1 to 1 on the harness, 5.0 to 1 here. A word
// list catching positive adjectives at random would miss both ways. The same
// detector over SVP's 49 stored payloads split 27 to 27, dead even, and every
// one of its twelve worst cases was an aspect claim rather than a verdict.
// Two corpora, opposite answers, which is what says the RVP finding is real.
//
// overnight/narrative-module-check.js re-derives all of this and is the script
// to rerun after any change to the lists below.
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
// ── TWO LISTS, AND ONLY ONE OF THEM BLOCKS ─────────────────────────────────
//
// BLOCKING. The four band names and their direct synonyms. This is exactly the
// list the 2026-09-22 measurement used, so the figures quoted above are the
// figures this list produces, not a different list's.
export const BAND_WORDS = {
  'Excellent':       ['excellent', 'exceptional', 'outstanding', 'superb'],
  'Good':            ['good', 'strong', 'solid', 'healthy'],
  'Fair':            ['fair', 'mixed', 'middling', 'average', 'adequate'],
  'Needs Attention': ['poor', 'weak', 'critical', 'failing', 'struggling'],
};

// WARNING ONLY, NEVER BLOCKING. Five words carried over from the SVP version
// of this gate. They find nineteen more pages, and whether that is a better
// detector or a noisier one was never settled: they were not checked against
// the aspect-claim problem the way the blocking words were, and that problem
// is what made SVP's corpus read 27 to 27 while RVP's read 91 to 18.
//
// A WORD THAT HAS NOT BEEN SHOWN TO DISCRIMINATE MUST NOT REFUSE A DELIVERY.
// They are reported so the question stays visible and can be settled from
// production rather than from argument.
export const WARN_WORDS = {
  'Excellent':       ['world class', 'world-class'],
  'Good':            ['robust'],
  'Fair':            ['uneven', 'inconsistent'],
  'Needs Attention': ['lagging'],
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
  // 'critical acclaim' MEANS THE OPPOSITE OF THE BAND WORD. It is praise from
  // critics. Found on Casa las Cuja, 2026-09-23: "Despite premium positioning
  // and critical acclaim, operational consistency ... appear to be lagging."
  // The gate blocked that summary and the block was wrong.
  'critical acclaim', 'critical praise', 'critical reception', 'critical darling',
  'poorly', 'poor weather',
  'weakness', 'weaknesses', 'weakly',
  'mixed use', 'mixed-use', 'mixed methods',
  'healthcheck', 'health check', 'healthy margin',
  'solidly', 'leading to', 'leading edge',
];

// Every band word used as a verdict, with the band it names and enough
// context to quote back to the model on a retry.
export function bandWordsIn(text, vocabulary) {
  const vocab = vocabulary || BAND_WORDS;
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const lower = s.toLowerCase();
  const found = [];
  for (const band of Object.keys(vocab)) {
    for (const w of vocab[band]) {
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
  if (!target) return { contradicts: false, hits: [], warnings: [], band: null };
  const off = (vocab) => bandWordsIn(text, vocab)
    .filter((h) => h.band !== target)
    .map((h) => ({ ...h, direction: RANK[h.band] > RANK[target] ? 'higher' : 'lower' }));
  const hits = off(BAND_WORDS);
  // WARNINGS ARE RETURNED AND NEVER GATE. contradicts is computed from hits
  // alone, so adding a warning word can never refuse a delivery.
  const warnings = off(WARN_WORDS);
  return { contradicts: hits.length > 0, hits, warnings, band: target };
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
