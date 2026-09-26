// ════════════════════════════════════════════════════════════════════════════
// "SINCE YOUR LAST REPORT" (2026-10-01, C2; the rules are 2026-09-28 D2).
//
// Shown only when an EARLIER run of the same subject exists (same
// benchmarks.subject_key, which is the Google place id). Then:
//   - both runs record the SAME non-null scoring method (benchmarks.method_version,
//     or this run's provenance): pillar by pillar, then and now, the change, and the
//     band each score sits in (the page's own verdict bands, lib-score.js). A change
//     is movement only when it is LARGER than the measured same-method noise, RVP
//     pillar p90 10 (OVERNIGHT_REPORT_2026-09-28 D2); a change of 10 or less reads
//     "within run-to-run range";
//   - otherwise (different methods, or either unrecorded) ONE sentence says the
//     methods differ, with no numbers at all.
// COPY FOR SIMON'S APPROVAL: the heading, both intro sentences, the column heads
// and the three readings. Pure; never throws.
// ════════════════════════════════════════════════════════════════════════════
import { verdictFor } from './lib-score.js';

export const RVP_PILLAR_NOISE = 10;
const ORDER = ['cs', 'pa', 'es', 'sm', 'cp', 'bg'];
const LABELS = { cs: 'Customer Sentiment', pa: 'Pricing & Accessibility', es: 'Employee Sentiment', sm: 'Social Media Impact', cp: 'Competitive Positioning', bg: 'Brand Experience & Growth' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// The earlier run's month and year, for the comparable intro only.
const dayWords = (iso) => { const t = Date.parse(iso); if (Number.isNaN(t)) return null; const d = new Date(t); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };

export function sinceLastModel({ current, previous, noise = RVP_PILLAR_NOISE } = {}) {
  if (!previous || typeof previous !== 'object') return null;
  const cur = current && typeof current === 'object' ? current : {};
  const when = dayWords(previous.created_at);
  const mNow = str(cur.methodVersion), mThen = str(previous.method_version);
  if (!mNow || !mThen || mNow !== mThen) {
    return { comparable: false, when,
      // No date either: a year is a number, and this sentence carries none.
      sentence: 'This restaurant was also assessed earlier, but that assessment was scored under a different method'
        + (!mNow || !mThen ? ', or its method was not recorded' : '') + ', so its scores are not compared with these.' };
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
const READING = { up: 'Up, beyond run-to-run range', down: 'Down, beyond run-to-run range', 'within run-to-run range': 'Within run-to-run range' };

export const SINCE_CSS = '.since-t{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 6px;page-break-inside:avoid;break-inside:avoid}'
  + '.since-t th,.since-t td{padding:6px 6px;border-top:1px solid #eee;text-align:left;vertical-align:top}'
  + '.since-t th{font-weight:700;color:#444}.since-t td.n{text-align:right;white-space:nowrap}'
  + '.since-up{color:#00753a;font-weight:700}.since-down{color:#b3261e;font-weight:700}.since-in{color:#666}'
  + '@media (max-width:600px){.since-t .band{display:none}}';

export function sinceLastHtml(model) {
  if (!model) return '';
  if (!model.comparable) return '<h2 class="rpt-h">Since your last report</h2><p class="body-p since-note">' + esc(model.sentence) + '</p>';
  return '<h2 class="rpt-h">Since your last report</h2>'
    + '<p class="body-p since-note">Compared with the assessment of this restaurant' + (model.when ? ' in ' + esc(model.when) : '')
    + ', scored under the same method (' + esc(model.method) + '). A change counts as movement only when it is larger than '
    + model.noise + ' points: in 9 of 10 repeat runs of the same restaurant under the same method, a pillar moved by '
    + model.noise + ' points or less with nothing changing.</p>'
    + '<table class="since-t"><thead><tr><th>Pillar</th><th class="n">Then</th><th class="n">Now</th><th class="n">Change</th><th class="band">Band</th><th>Reading</th></tr></thead><tbody>'
    + model.rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td class="n">' + r.then + '</td><td class="n">' + r.now + '</td><td class="n">'
      + (r.delta > 0 ? '+' : '') + r.delta + '</td><td class="band">' + esc(r.bandThen === r.bandNow ? (r.bandNow || '') : (r.bandThen || '') + ' to ' + (r.bandNow || '')) + '</td>'
      + '<td class="' + (r.reading === 'up' ? 'since-up' : r.reading === 'down' ? 'since-down' : 'since-in') + '">' + READING[r.reading] + '</td></tr>').join('')
    + '</tbody></table>';
}
