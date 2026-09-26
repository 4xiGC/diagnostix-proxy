// ════════════════════════════════════════════════════════════════════════════
// "HOW THIS REPORT WAS BUILT" (2026-10-01, recommendation 10, C1).
//
// SUBJECT_INTEGRITY_STANDARD.md 6.2: seven sections, the same headings in the
// same order in all three products. EVERY VALUE IS READ FROM WHAT THE RUN
// STORED on the payload (subject, evidence, coverage, provenance, _debug,
// summaryGate, meta) or from the revision notes the page already prints. A value
// the run did not store reads NOT_RECORDED and is never estimated.
//
// The one value that is not stored is labelled as such: the scoring method the
// page applies when it is shown (the cover computes the overall from the stored
// pillars at read time, v8.11.50).
//
// Across the 112 stored reports on 2026-10-01 most rows read "not recorded":
// the subject and coverage blocks exist on 4, the evidence counts on 20, and the
// 2026-09-30 provenance on none yet (overnight _1001_rvp.md, A4). That is the
// honest page until new runs arrive. COPY FOR SIMON'S APPROVAL: every label,
// the intro and the state words below.
// Pure; never throws.
// ════════════════════════════════════════════════════════════════════════════
import { formatCount, splitReviewVolumes } from './lib-evidence.js';
import { rvpConfidence } from './lib-provenance.js';
import { OVERALL_METHOD_VERSION } from './lib-score.js';

export const NOT_RECORDED = 'not recorded for this report';
export const PROOF_HEADINGS = ['What was assessed', 'What we read', 'Coverage', 'How it was scored',
  'What was checked before you saw it', 'Confidence', 'Revision notes'];
export const PROOF_INTRO = 'Every value on this page is one the assessment stored when it ran, except the scoring method, '
  + 'which is applied each time the page is shown. Where the run did not store something, the page says so rather than estimating it.';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? formatCount(v) : null);
const or = (v) => (v === null || v === undefined || v === '' ? NOT_RECORDED : String(v));

const COVERAGE_WORDS = { pass: 'Enough public signal to assess it (pass)', limited: 'Assessed, with limited public signal (limited)' };
function summaryGateWords(reason) {
  const r = str(reason);
  if (!r) return null;
  const m = r.match(/^accepted-attempt-(\d+)$/);
  if (m) return 'Checked and accepted' + (m[1] === '1' ? ' on the first attempt' : ' on attempt ' + m[1]);
  if (r === 'gate-failed-twice') return 'Failed the check twice, so no model-written summary was printed';
  if (r === 'no-band') return 'Not run: there was no computed score to check against';
  return r;
}
function seconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 120 ? s + ' seconds' : Math.floor(s / 60) + ' minutes ' + (s % 60) + ' seconds';
}

export function proofPageModel(report, opts = {}) {
  const r = obj(report);
  const subject = obj(r.subject), ev = obj(r.evidence), cov = obj(r.coverage), prov = obj(r.provenance);
  const dbg = obj(r._debug), gp = obj(dbg.googlePlaces);
  const split = (() => { try { return splitReviewVolumes(r); } catch { return null; } })();

  const assessed = [
    { label: 'Name on this report', value: or(str(opts.restaurantName)) },
    { label: 'Confirmed name', value: or(str(subject.name)) },
    { label: 'How it was confirmed', value: str(subject.placeId) ? 'Matched to one Google Business listing, whose place id is stored with the report' : NOT_RECORDED },
    { label: 'Name as typed', value: or(str(subject.typedName)) },
  ];
  const read = [
    { label: 'Searches run', value: or(count(ev.searchesRun)) },
    { label: 'Results returned', value: or(count(ev.resultsReturned)) },
    { label: 'Results read', value: or(count(ev.resultsRead)) },
    { label: 'Distinct sites read', value: or(count(ev.distinctSites)) },
    { label: 'Google reviews of this restaurant', value: or(split ? formatCount(split.subjectReviews) : null) },
    { label: 'Reviews of the comparable restaurants read alongside it', value: or(split && split.peersCounted > 0
      ? formatCount(split.peerReviews) + ' across ' + split.peersCounted + ' restaurant' + (split.peersCounted === 1 ? '' : 's') : null) },
    { label: 'Reviews published by all the sources read, together', value: or(count(ev.reviewsTotal)) },
  ];
  const th = obj(cov.thresholds);
  const coverage = [
    { label: 'Coverage state', value: or(str(cov.state) ? (COVERAGE_WORDS[cov.state] || cov.state) : null) },
    { label: 'What was measured', value: or(count(cov.subjectReviewCount) ? count(cov.subjectReviewCount) + ' Google reviews of this restaurant' : null) },
    { label: 'The rule applied', value: or(count(th.MIN_SUBJECT_REVIEWS) && count(th.LIMITED_BELOW_REVIEWS)
      ? 'Under ' + count(th.MIN_SUBJECT_REVIEWS) + ' reviews: not assessed. Under ' + count(th.LIMITED_BELOW_REVIEWS) + ': assessed as limited.' : null) },
    { label: 'Removed before scoring', value: NOT_RECORDED },
  ];
  const passes = Array.isArray(prov.passes) ? prov.passes.filter((p) => p && typeof p === 'object') : [];
  const models = passes.length ? passes.map((p) => (str(p.label) || 'model') + ': ' + (str(p.model) || NOT_RECORDED)
    + ', prompt ' + (str(p.promptVersion) || NOT_RECORDED)).join('; ') : null;
  const scored = [
    { label: 'Method recorded when the report was produced', value: or(str(prov.methodVersion)) },
    { label: 'Method used for the score on this page', value: opts.hasScore === false
      ? 'No overall score is shown on this report: not all six pillar scores are stored'
      : OVERALL_METHOD_VERSION + ' (applied to the stored pillar scores when the page is shown)' },
    { label: 'Service version', value: or(str(dbg.version)) },
    { label: 'Models and prompt versions', value: or(models) },
    { label: 'Time to produce', value: or(seconds(typeof prov.durationMs === 'number' ? prov.durationMs : dbg.totalMs)) },
  ];
  const checked = [
    { label: 'Executive summary checked against the computed score', value: or(summaryGateWords(r.summaryGate)) },
    { label: 'Nearby restaurants found through Google', value: or(count(gp.count)) },
    { label: 'Comparable restaurants read without a matching Google record', value: or(count(gp.peersUnresolved)) },
  ];
  const conf = obj(prov.confidence);
  let level = str(conf.level), basis = str(conf.basis);
  if (!level && str(cov.state)) {
    const d = rvpConfidence(cov);
    level = d.level; basis = d.basis + ' (derived from the coverage state stored with this report)';
  }
  const confidence = [
    { label: 'Confidence level', value: or(level) },
    { label: 'What it rests on', value: or(basis) },
  ];
  const notes = (Array.isArray(opts.revisionNotes) ? opts.revisionNotes : []).map(str).filter(Boolean);
  const revisions = notes.length ? notes.map((t, i) => ({ label: 'Change ' + (i + 1), value: t }))
    : [{ label: 'Changes after delivery', value: 'None recorded: no change to this report after delivery is stored' }];
  return {
    title: 'How this report was built', intro: PROOF_INTRO,
    sections: [assessed, read, coverage, scored, checked, confidence, revisions].map((rows, i) => ({ heading: PROOF_HEADINGS[i], rows })),
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The page's CSS. The report inlines it in its own stylesheet; the standalone
// route puts it in the head of a page of its own.
export const PROOF_CSS = '.proof-page{page-break-before:always;break-before:page;margin-top:28px}'
  + '.proof-intro{font-size:13px;line-height:1.6;color:#555;margin:0 0 14px}'
  + '.proof-h-wrap{font-size:14px;font-weight:800;color:#1a2b4a;margin:18px 0 6px;letter-spacing:.2px}'
  + '.proof-t{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px;page-break-inside:avoid;break-inside:avoid}'
  + '.proof-t th{width:40%;text-align:left;font-weight:600;color:#444;padding:6px 10px 6px 0;vertical-align:top;border-top:1px solid #eee}'
  + '.proof-t td{padding:6px 0;vertical-align:top;border-top:1px solid #eee;overflow-wrap:anywhere;word-break:break-word}'
  + '.proof-t td.proof-nr{color:#888;font-style:italic}'
  + '@media (max-width:600px){.proof-t th,.proof-t td{display:block;width:auto;border-top:0;padding:2px 0}.proof-t tr{display:block;border-top:1px solid #eee;padding:6px 0}}';

export function proofPageHtml(model) {
  const m = model && typeof model === 'object' ? model : proofPageModel({}, {});
  return '<section class="proof-page">'
    + '<h2 class="rpt-h">' + esc(m.title) + '</h2>'
    + '<p class="proof-intro">' + esc(m.intro) + '</p>'
    + m.sections.map((s, i) => '<h3 class="proof-h-wrap"><span class="proof-n">' + (i + 1) + '. </span><span class="proof-h">' + esc(s.heading) + '</span></h3>'
      + '<table class="proof-t"><tbody>' + s.rows.map((r) => '<tr><th scope="row">' + esc(r.label) + '</th><td'
        + (r.value === NOT_RECORDED ? ' class="proof-nr"' : '') + '>' + esc(r.value) + '</td></tr>').join('') + '</tbody></table>').join('')
    + '</section>';
}
