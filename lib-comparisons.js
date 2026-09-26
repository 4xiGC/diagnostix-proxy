// ════════════════════════════════════════════════════════════════════════════
// COMPARISONS THAT CONTRADICT THEIR OWN NUMBERS (2026-09-29, recommendation 4).
//
// Delivered prose read on 2026-09-28 (B2) called 648 against 784 "significantly
// higher review volume" (Orchid), and put "#2 in Santiago dining" beside "#62 of
// 3,523 restaurants" in one sentence (Bocanáriz). The first number an owner
// checks decides whether the rest is believed.
//
// Two defences, both here:
//   COMPARISON_RULE   a prompt rule for the prose calls (diagnose-p2 and the
//                     executive summary, server.js).
//   findContradictions(report)  a render-time CHECK. It flags and never
//                     rewrites: which of two numbers a sentence meant is not
//                     something a pattern can know, so a flagged sentence is
//                     reported (log line, returned list) and left as written.
//
// THE CHECK IS NARROW ON PURPOSE. It reads only two shapes:
//   direction   a number "vs" (or "versus", "against") a number, with the
//               nearest comparison word before it in the same sentence
//               ("higher", "more", ... or "lower", "fewer", ...); flagged when
//               the word's direction disagrees with the two numbers
//   two-ranks   two DIFFERENT "#N" ranks in one sentence, unless it says
//               it is a range or a movement ("#443-#900", "from #5 to #2")
// A sentence it cannot read is not flagged. Pure; never throws; never edits.
// ════════════════════════════════════════════════════════════════════════════

export const COMPARISON_RULE = [
  'COMPARISONS, HARD RULE: when a sentence compares two numbers, its words must agree with the numbers.',
  'Use "higher", "more", "larger", "ahead" or "stronger" only for the LARGER number, and "lower", "fewer",',
  '"smaller", "behind" or "weaker" only for the SMALLER one. 648 reviews against 784 is FEWER reviews, never',
  '"higher review volume". Never put two different rankings in one sentence unless it says they are two',
  'different lists: "#2 in Santiago dining" beside "#62 of 3,523 restaurants" reads as a contradiction.',
  'Name each ranking\'s list, or use one ranking. If you are not sure which number is larger, state both',
  'numbers and no comparison word.',
].join(' ');

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)%?';
const PAIR = new RegExp(NUM + '\\s*(?:vs\\.?|versus|against)\\s*' + NUM, 'gi');
const UP = /\b(higher|more|greater|larger|bigger|ahead|exceeds?|outpaces?|stronger|above)\b/gi;
const DOWN = /\b(lower|fewer|less|smaller|behind|trails?|below|weaker)\b/gi;
const toNum = (s) => Number(String(s).replace(/,/g, ''));

function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+(?=[A-Z"(#])/).filter((s) => s.trim());
}

function nearestWord(prefix) {
  let best = null;
  for (const [re, dir] of [[UP, 'up'], [DOWN, 'down']]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(prefix))) if (!best || m.index > best.at) best = { at: m.index, word: m[1], dir };
  }
  return best;
}

// ── 2026-10-02, THE REWRITE ROUTE'S SECOND PASS (Simon, 2026-09-26) ──────────
//
// (1) A rank "on" or "in" a NAMED list ("#2 in Santiago dining", "#62 of 3,523
//     on the Tripadvisor Santiago list") says which list it is on. Two ranks on
//     two DIFFERENT named lists in one sentence are not a contradiction. A rank
//     with no list name ("#62 of 3,523 restaurants") still counts as unnamed.
// (2) A rating comparison word ("higher-rated", "lower-rated") against the
//     ratings it refers to, when the SUBJECT'S OWN RATING is given. No stored
//     report carries it (checked 2026-10-02 on the three flagged rows), so the
//     render-time check never runs this part; the rewrite route passes it.
// (3) A rank on a list of known size reads as a percentile.
// Still pure, never throws, never edits.
const LIST_NAME = /^\s*(?:of\s+[\d,]+\s+)?(?:on|in)\s+(?:the\s+)?([A-Z][\w'&.-]*(?:\s+[\w'&.-]+){0,4})/;
function rankListName(s, at, len) {
  const m = s.slice(at + len).match(LIST_NAME);
  if (!m) return null;
  // The name ends at a conjunction or at punctuation: "on Tripadvisor and #5 ..." is "tripadvisor".
  const name = m[1].split(/\s+(?:and|or|but|while|with|where|whereas)\b/i)[0].replace(/[.,;:!?)]+$/, '');
  return name.toLowerCase().replace(/\s+(?:list|ranking|rankings|guide)$/, '').trim() || null;
}
const RATED_WORD = /\b(higher|better|more highly|lower|worse)[- ]rated\b/gi;
const RATING_NUM = /(?<![\d.,#])([0-5]\.\d)(?:\s*\/\s*5)?(?![\d%])/g;
function ratingScope(s, at, end) {
  const open = s.lastIndexOf('(', at), close = s.lastIndexOf(')', at);
  if (open > close) { const c = s.indexOf(')', at); return s.slice(open, c < 0 ? s.length : c); }
  const next = s.indexOf('(', end);
  if (next >= 0 && next - end <= 60) { const c = s.indexOf(')', next); return s.slice(next, c < 0 ? s.length : c); }
  const comma = s.indexOf(',', end);
  return s.slice(end, comma < 0 ? s.length : comma);
}
function ratingFlags(s, subjectRating) {
  const out = [];
  if (!(typeof subjectRating === 'number' && Number.isFinite(subjectRating))) return out;
  RATED_WORD.lastIndex = 0;
  let m;
  while ((m = RATED_WORD.exec(s))) {
    const up = /^(higher|better|more highly)$/i.test(m[1]);
    const ratings = [...ratingScope(s, m.index, m.index + m[0].length).matchAll(RATING_NUM)].map((x) => Number(x[1]));
    if (!ratings.length) continue;
    // EVERY rating the word refers to must agree: "higher-rated (DOMO 4.8, Bettys 4.6)" against 4.7 is
    // still false for Bettys (the 2026-10-02 dry run padded the list exactly this way).
    const wrong = up ? ratings.some((r) => r <= subjectRating) : ratings.some((r) => r >= subjectRating);
    if (wrong) out.push({ kind: 'rating', detail: '"' + m[0] + '" beside ' + ratings.join(', ') + ' against the subject\'s ' + subjectRating, sentence: s.trim() });
  }
  return out;
}

export function rankPercentile(n, m) {
  const r = Number(n), size = Number(String(m).replace(/,/g, ''));
  if (!(Number.isInteger(r) && Number.isInteger(size)) || size < 2 || r < 1 || r > size) return null;
  const frac = r / size;
  if (frac <= 0.5) { const pct = Math.max(1, Math.ceil(100 * frac)); return { side: 'top', pct, words: 'the top ' + pct + ' percent' }; }
  const pct = Math.max(1, Math.ceil(100 * (size - r) / size));
  return { side: 'bottom', pct, words: 'the bottom ' + pct + ' percent' };
}
export function rankFacts(text) {
  return [...String(text || '').matchAll(/#(\d+)\s+(?:of|out of)\s+(\d[\d,]*)/g)]
    .map((x) => ({ rank: x[0], n: Number(x[1]), size: Number(x[2].replace(/,/g, '')), ...(rankPercentile(x[1], x[2]) || {}) }))
    .filter((f) => f.words);
}

// The two prompt lines of the second pass. NOT part of COMPARISON_RULE: the
// delivery prompts (diagnose-p2, the summary) are unchanged. Only the offline
// rewrite route sends them, and only with --second-pass.
export const RATING_RULE = 'RATINGS, HARD RULE: call a competitor "higher-rated" or "better-rated" only when its rating is above the '
  + 'restaurant\'s own rating given below; for an equal rating say "equally rated", for a lower one "lower-rated", '
  + 'or state both ratings with no comparison word. When one word would cover a list whose ratings are not all on the '
  + 'same side (some lower and some equal, or some higher and some equal), use no comparison word and state the ratings.';
export const RANK_RULE = 'RANKINGS, HARD RULE: never compare two rankings from lists of different sizes, and never put two rankings in '
  + 'one sentence unless each names its own list. Where a ranking gives its list size, restate it as the percentile given '
  + 'below; otherwise keep one ranking and drop the other. Add no list name the passage does not contain.';

export function findContradictionsInText(text, opts = {}) {
  const out = [];
  if (typeof text !== 'string' || !text.trim()) return out;
  for (const s of sentences(text)) {
    for (const f of ratingFlags(s, opts && opts.subjectRating)) out.push(f);
    PAIR.lastIndex = 0;
    let m;
    while ((m = PAIR.exec(s))) {
      const a = toNum(m[1]), b = toNum(m[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
      const prefix = s.slice(Math.max(0, m.index - 80), m.index);
      const w = nearestWord(prefix);
      if (!w) continue;
      if ((w.dir === 'up' && a < b) || (w.dir === 'down' && a > b)) {
        out.push({ kind: 'direction', detail: '"' + w.word + '" beside ' + m[1] + ' vs ' + m[2], sentence: s.trim() });
      }
    }
    // A range ("#443-#900", "#2462 to #2501") is ONE ranking: its two ends are
    // removed before counting (measured 2026-09-29, 2 of 5 stored flags).
    const unranged = s.replace(/#\d+\s*(?:[-–—]|to)\s*#\d+/gi, ' ');
    const rankHits = [...unranged.matchAll(/#(\d+)\b/g)];
    const ranks = rankHits.map((x) => x[1]);
    // (1) Every distinct rank on its own NAMED list, and the names all differ: accepted.
    const names = rankHits.map((x) => rankListName(unranged, x.index, x[0].length));
    const namedApart = names.every(Boolean) && new Set(names).size === names.length;
    if (new Set(ranks).size >= 2 && !namedApart) {
      out.push({ kind: 'two-ranks', detail: 'ranks ' + [...new Set(ranks)].map((r) => '#' + r).join(' and ') + ' in one sentence', sentence: s.trim() });
    }
  }
  return out;
}

const SKIP = new Set(['_debug', 'meta', 'evidence', 'pillars', 'coverage', 'subject']);

export function findContradictions(report, opts = {}) {
  const out = [];
  try {
    (function walk(o, p) {
      if (typeof o === 'string') { for (const f of findContradictionsInText(o, opts)) out.push({ path: p, ...f }); return; }
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, p + '[' + i + ']')); return; }
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (!p && (SKIP.has(k) || k.startsWith('_'))) continue;
        walk(v, p ? p + '.' + k : k);
      }
    })(report, '');
  } catch (_) { /* a check never breaks a render */ }
  return out;
}
