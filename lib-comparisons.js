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
//               "from #A to #B" (a movement, which is two ranks by design)
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

export function findContradictionsInText(text) {
  const out = [];
  if (typeof text !== 'string' || !text.trim()) return out;
  for (const s of sentences(text)) {
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
    const ranks = [...s.matchAll(/#(\d+)\b/g)].map((x) => x[1]);
    if (new Set(ranks).size >= 2 && !/from\s+#\d+\s+to\s+#\d+/i.test(s)) {
      out.push({ kind: 'two-ranks', detail: 'ranks ' + [...new Set(ranks)].map((r) => '#' + r).join(' and ') + ' in one sentence', sentence: s.trim() });
    }
  }
  return out;
}

const SKIP = new Set(['_debug', 'meta', 'evidence', 'pillars', 'coverage', 'subject']);

export function findContradictions(report) {
  const out = [];
  try {
    (function walk(o, p) {
      if (typeof o === 'string') { for (const f of findContradictionsInText(o)) out.push({ path: p, ...f }); return; }
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
