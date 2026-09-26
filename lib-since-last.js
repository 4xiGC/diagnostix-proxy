// ════════════════════════════════════════════════════════════════════════════
// "SINCE YOUR LAST REPORT" (2026-10-01, C2; the rules are 2026-09-28 D2).
//
// Shown only when an EARLIER run of the same subject exists (same
// benchmarks.subject_key, which is the Google place id). Then:
//   - both runs record the SAME non-null scoring method (benchmarks.method_version,
//     or this run's provenance): pillar by pillar, then and now, the change, and a
//     reading. A change is movement only when it is MORE than the measured
//     same-method noise, RVP pillar p90 10 (OVERNIGHT_REPORT_2026-09-28 D2); a
//     change of 10 or less reads "Within run-to-run range";
//   - otherwise (different methods, or either unrecorded) ONE sentence says the
//     methods differ, with no numbers at all.
// 2026-09-26 (Simon Q41): ONE placement (immediately after the pillar scores) and
// ONE wording in RVP, SVP and EVP; the band column and the method id are gone.
// The model still carries bandThen and bandNow; the page does not print them.
// Pure; never throws.
// ════════════════════════════════════════════════════════════════════════════
import { verdictFor } from './lib-score.js';

export const RVP_PILLAR_NOISE = 10;
const ORDER = ['cs', 'pa', 'es', 'sm', 'cp', 'bg'];
const LABELS = { cs: 'Customer Sentiment', pa: 'Pricing & Accessibility', es: 'Employee Sentiment', sm: 'Social Media Impact', cp: 'Competitive Positioning', bg: 'Brand Experience & Growth' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// The earlier run's date in the report's customer style ("1 June 2026", as "Revised 25 September
// 2026"), for the comparable intro only.
const dayWords = (iso) => { const t = Date.parse(iso); if (Number.isNaN(t)) return null; const d = new Date(t); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };

// 2026-09-26 (Simon Q41): ONE placement (straight after the pillar scores) and ONE wording in RVP,
// SVP and EVP. Only the subject noun and the noise floor differ by product. The methods-differ
// sentence carries no digit, not even a date.
export const SINCE_DIFFERS = 'This restaurant was also assessed earlier, under a different scoring method or one that was not recorded, so the scores are not compared.';
const sinceSame = (when, n) => 'Compared with the last assessment of this restaurant, on ' + when + ', scored under the same method. '
  + 'A change counts as movement only when it is more than ' + n + ' points: in 9 of 10 repeat runs of the same restaurant under the same method, '
  + 'a pillar moved by ' + n + ' points or less with nothing changing.';

export function sinceLastModel({ current, previous, noise = RVP_PILLAR_NOISE } = {}) {
  if (!previous || typeof previous !== 'object') return null;
  const cur = current && typeof current === 'object' ? current : {};
  const when = dayWords(previous.created_at);
  const mNow = str(cur.methodVersion), mThen = str(previous.method_version);
  if (!mNow || !mThen || mNow !== mThen) {
    // No date either: a year is a number, and this sentence carries none.
    return { comparable: false, when, sentence: SINCE_DIFFERS };
  }
  const then = previous.pillar_scores && typeof previous.pillar_scores === 'object' ? previous.pillar_scores : {};
  const nowP = cur.pillars && typeof cur.pillars === 'object' ? cur.pillars : {};
  const rows = [];
  for (const k of ORDER) {
    const a = num(then[k]), b = num(nowP[k] && typeof nowP[k] === 'object' ? nowP[k].score : nowP[k]);
    if (a === null || b === null) continue;
    const delta = b - a;
    rows.push({ key: k, label: (nowP[k] && str(nowP[k].label)) || LABELS[k], then: a, now: b, delta,
      bandThen: verdictFor(a), bandNow: verdictFor(b),
      reading: Math.abs(delta) > noise ? (delta > 0 ? 'up' : 'down') : 'within run-to-run range' });
  }
  if (!rows.length) return null;
  return { comparable: true, when, method: mNow, noise, rows };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const READING = { up: 'Moved up', down: 'Moved down', 'within run-to-run range': 'Within run-to-run range' };

export const SINCE_CSS = '.since-t{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 6px;page-break-inside:avoid;break-inside:avoid}'
  + '.since-t th,.since-t td{padding:6px 6px;border-top:1px solid #eee;text-align:left;vertical-align:top}'
  + '.since-t th{font-weight:700;color:#444}.since-t td.n{text-align:right;white-space:nowrap}'
  + '.since-up{color:#00753a;font-weight:700}.since-down{color:#b3261e;font-weight:700}.since-in{color:#666}';

export function sinceLastHtml(model) {
  if (!model) return '';
  if (!model.comparable) return '<h2 class="rpt-h">Since your last report</h2><p class="body-p since-note">' + esc(model.sentence) + '</p>';
  // Q41: no band column (it was RVP's alone), and the method id is not printed.
  return '<h2 class="rpt-h">Since your last report</h2>'
    + '<p class="body-p since-note">' + esc(sinceSame(model.when || 'an earlier date', model.noise)) + '</p>'
    + '<table class="since-t"><thead><tr><th>Pillar</th><th class="n">Then</th><th class="n">Now</th><th class="n">Change</th><th>Reading</th></tr></thead><tbody>'
    + model.rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td class="n">' + r.then + '</td><td class="n">' + r.now + '</td><td class="n">'
      + (r.delta > 0 ? '+' : '') + r.delta + '</td>'
      + '<td class="' + (r.reading === 'up' ? 'since-up' : r.reading === 'down' ? 'since-down' : 'since-in') + '">' + READING[r.reading] + '</td></tr>').join('')
    + '</tbody></table>';
}
