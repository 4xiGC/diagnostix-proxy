// ── The aligned RVP report, PROTOTYPE ONLY (v8.11.27) [RVP-B] ───────────────
//
// NOTHING IN server.js IMPORTS THIS FILE. The live renderer and the live email
// are untouched. This exists so the proposed format can be reviewed against
// real data before anyone decides to adopt it.
//
// WHAT IT CHANGES: structure, spacing, type scale, color tokens, card
// treatment, section rhythm and print rules.
// WHAT IT DOES NOT CHANGE: a single number, sentence or link. The tests in
// test/aligned-report.test.js pin that, and they compare against the stored
// report DATA rather than against the live renderer's HTML, which is the
// stronger check: scraping the live output would only prove this file copied
// it, while comparing to the data proves nothing was lost.
//
// ── THE TOKEN SET ───────────────────────────────────────────────────────────
//
// SVP and EVP already share ten tokens byte for byte: the five-step gray ramp,
// --ink, --paper, and the semantic --green, --red, --red-soft. RVP shares none
// of them today. It has its own --green (#00A651 against #27AE60) and its own
// --red (#ED1C24 against #C0392B), so the same score band is a different color
// depending on which product a reader is looking at.
//
// The spine below is those ten, unchanged, so adopting it moves RVP toward the
// other two rather than inventing a third scheme.
//
// RVP keeps its own identity through the brand pair, and the family link is
// already in the code: RVP's --navy #1B1464 is EXACTLY EVP's --navy-2. The
// only drift is the spelling, --navy2 here against --navy-2 there, which is
// the kind of thing a shared token file removes.
//
// MEASURED CONTRAST, from overnight/contrast.js:
//   white on --navy #1B1464        15.78:1  AAA
//   white on --navy-2 #2E3192      10.66:1  AAA
//   --accent #0072BC on white       5.08:1  AA   (AAA as large text)
//   --ink on --paper               18.99:1  AAA
//   --gray-700 on --paper          10.05:1  AAA
//
// RVP's accent is the most accessible of the three brands: SVP's copper is
// 3.22:1 and EVP's gold is 1.85:1, both of which fail AA as body text.
//
// KNOWN DEFECT, CARRIED FORWARD DELIBERATELY AND FLAGGED RATHER THAN COPIED:
// --gray-400 on --paper is 3.09:1 and FAILS AA. It is used for small label
// text in SVP and EVP today. This prototype uses --gray-700 for labels
// instead, which is 10.05:1. That is a format change, not a content change.
//
// ALSO NOT COPIED, on purpose:
//   - SVP's .verbatim-grid auto-fit layout, the best current explanation for
//     the print loss of Gap-closing path and Discovery questions. Every grid
//     here is break-inside:avoid with a fixed column count at print width.
//   - SVP's two false Methodology sentences, already deleted in v0.19.15.
//   - Any constant "hit count" presented as a measurement.

export function alignedTokens() {
  return {
    // The spine SVP and EVP already share, byte for byte.
    '--gray-50':  '#F7F8FA',
    '--gray-100': '#EDEFF4',
    '--gray-200': '#D7DCE5',
    '--gray-400': '#8A93A6',
    '--gray-700': '#3A4255',
    '--ink':      '#0B0F22',
    '--paper':    '#FFFFFF',
    '--green':    '#27AE60',
    '--red':      '#C0392B',
    '--red-soft': '#E74C3C',
    // RVP's own brand pair, from its existing navy and blue.
    '--navy':     '#1B1464',
    '--navy-2':   '#2E3192',
    '--accent':   '#0072BC',
    // Score bands: the same three meanings in all three products.
    '--band-strong':  '#27AE60',
    '--band-caution': '#C97E36',
    '--band-risk':    '#C0392B',
  };
}

// The shared skeleton. `optional` sections render only when the data has them,
// which is how a product-specific slot behaves without leaving a hole.
export const ALIGNED_SECTIONS = [
  { key: 'summary',     heading: 'Executive summary',        optional: false, present: () => true },
  { key: 'evidence',    heading: 'Evidence base',            optional: true,  present: r => !!(r && r.evidence) },
  { key: 'pillars',     heading: 'Pillar performance',       optional: true,  present: r => !!(r && r.pillars && Object.keys(r.pillars).length) },
  { key: 'perception',  heading: 'Reviewer perception vs reality', optional: true, present: r => !!(r && (r.ownerSentimentSummary || r.perceptionGap)) },
  { key: 'metrics',     heading: 'Financial and operational reality', optional: true, present: r => !!(r && r.businessRealityAnalysis) },
  { key: 'strengths',   heading: 'Strengths and risks',      optional: true,  present: r => !!(r && ((r.strengths || []).length || (r.risks || []).length)) },
  { key: 'themes',      heading: 'Themes',                   optional: true,  present: r => !!(r && (r.themes || []).length) },
  { key: 'competitors', heading: 'Competitive landscape',    optional: true,  present: r => !!(r && (r.competitors || []).length) },
  { key: 'sentiment',   heading: 'Sentiment signals',        optional: true,  present: r => !!(r && (r.employeeSentiment || r.sentimentGap)) },
  { key: 'actions',     heading: 'Recommended actions',      optional: true,  present: r => !!(r && ((r.actions || []).length || (r.commercialActions || []).length)) },
  { key: 'method',      heading: 'Methodology',              optional: false, present: () => true },
  { key: 'notin',       heading: 'What is not in this assessment', optional: false, present: () => true },
];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const num = (n) => (typeof n === 'number' && Number.isFinite(n)) ? String(n) : null;
const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0)
  ? n.toLocaleString('en-US') : null;

function bandFor(score) {
  if (typeof score !== 'number') return 'caution';
  if (score >= 70) return 'strong';
  if (score >= 55) return 'caution';
  return 'risk';
}

function css() {
  const t = alignedTokens();
  const vars = Object.entries(t).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `
:root{
${vars}
  --w: 880px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--gray-50);color:var(--ink);
  font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:var(--w);margin:0 auto;padding:0 24px}

/* Header band: the same shape SVP and EVP use, in RVP's navy. */
.band{background:linear-gradient(135deg,var(--navy) 0%,var(--navy-2) 100%);
  color:var(--paper);padding:38px 0 30px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.band h1{font-family:'League Spartan','Inter',sans-serif;font-weight:800;
  font-size:2.1rem;line-height:1.15;margin:0 0 6px;letter-spacing:-0.01em}
.band .sub{font-size:0.95rem;opacity:0.85;margin:0}

/* Score block */
.score-row{display:flex;gap:22px;align-items:center;margin-top:24px;flex-wrap:wrap}
.score-dial{background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.22);
  border-radius:12px;padding:16px 22px;text-align:center;min-width:132px}
.score-dial .n{font-family:'League Spartan','Inter',sans-serif;font-size:2.6rem;
  font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.score-dial .l{font-size:0.66rem;letter-spacing:0.1em;text-transform:uppercase;opacity:0.8;margin-top:6px}

/* Sections: one rhythm for all of them. */
.card{background:var(--paper);border:1px solid var(--gray-200);border-radius:10px;
  padding:26px 28px;margin:20px 0}
.sec-h{font-family:'League Spartan','Inter',sans-serif;font-size:1.22rem;font-weight:700;
  color:var(--navy);margin:0 0 4px;letter-spacing:-0.005em}
.sec-rule{height:2px;width:48px;background:var(--accent);border-radius:2px;margin:0 0 16px}
.prose{margin:0 0 12px;color:var(--gray-700)}
.prose:last-child{margin-bottom:0}

/* Labels use gray-700, NOT gray-400: gray-400 on paper is 3.09:1 and fails
   AA. SVP and EVP both use it for small labels today. */
.lab{font-size:0.66rem;letter-spacing:0.09em;text-transform:uppercase;color:var(--gray-700)}

/* Pillars */
.pillar{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(--gray-100)}
.pillar:last-child{border-bottom:0}
.pillar .nm{flex:1;font-weight:600;font-size:0.94rem}
.pillar .bar{flex:0 0 160px;height:8px;background:var(--gray-100);border-radius:4px;overflow:hidden}
.pillar .fill{height:100%;border-radius:4px}
.pillar .sc{flex:0 0 46px;text-align:right;font-weight:800;font-variant-numeric:tabular-nums}
.b-strong{background:var(--band-strong)}
.b-caution{background:var(--band-caution)}
.b-risk{background:var(--band-risk)}

/* Fixed two-column grids, never auto-fit. auto-fit reflows at print width and
   is the best current explanation for SVP losing whole sections in its PDF. */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.tile{border:1px solid var(--gray-200);border-radius:8px;padding:14px 16px;background:var(--gray-50);
  break-inside:avoid;page-break-inside:avoid}
.tile h4{margin:0 0 6px;font-size:0.9rem;color:var(--navy)}
.tile p{margin:0;font-size:0.88rem;color:var(--gray-700)}

/* Peer cards */
.peer{display:flex;justify-content:space-between;gap:14px;padding:12px 0;
  border-bottom:1px solid var(--gray-100);break-inside:avoid}
.peer:last-child{border-bottom:0}
.peer .nm{font-weight:600}
.peer .meta{font-size:0.84rem;color:var(--gray-700);text-align:right;white-space:nowrap}
.peer .note{font-size:0.86rem;color:var(--gray-700);margin-top:3px}
.no-count{color:var(--gray-700);font-style:italic;font-size:0.8rem}

/* Evidence base */
.ev-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.ev-cell{text-align:center;border:1px solid var(--gray-200);border-radius:8px;padding:12px 8px;background:var(--gray-50)}
.ev-n{font-size:1.5rem;font-weight:800;color:var(--navy);font-variant-numeric:tabular-nums;line-height:1.1}
.ev-s{margin:14px 0 0;font-size:0.84rem;color:var(--gray-700);border-top:1px solid var(--gray-100);padding-top:12px}

ul.clean{margin:0;padding-left:18px}
ul.clean li{margin:0 0 7px;color:var(--gray-700)}
a{color:var(--accent)}

@page{ size:A4; margin:14mm 12mm; }
@media print{
  body{background:var(--paper);font-size:10.5pt}
  .wrap{max-width:none;padding:0}
  .card{border-color:var(--gray-200);margin:12px 0;padding:16px 18px;
    break-inside:avoid;page-break-inside:avoid}
  /* Every section heading stays. Nothing here sets display:none on a heading,
     and the test asserts that, because a print rule that hides a heading is
     how a section disappears from a PDF without anyone noticing. */
  .sec-h{break-after:avoid;page-break-after:avoid}
  .grid2{grid-template-columns:1fr 1fr}
  .ev-grid{grid-template-columns:repeat(4,1fr)}
  .band{padding:22px 0 18px}
  a{color:var(--ink);text-decoration:none}
}`;
}

function sectionCard(heading, inner) {
  if (!inner || !String(inner).trim()) return '';
  return `<section class="card">
  <h2 class="sec-h">${esc(heading)}</h2>
  <div class="sec-rule"></div>
  ${inner}
</section>`;
}

function proseBlock(...parts) {
  return parts.filter(p => typeof p === 'string' && p.trim())
    .map(p => `<p class="prose">${esc(p)}</p>`).join('\n  ');
}

function listBlock(items) {
  const a = (Array.isArray(items) ? items : []).filter(x => typeof x === 'string' && x.trim());
  if (!a.length) return '';
  return `<ul class="clean">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

export function renderAlignedReportHtml({ subscriber, report }) {
  const sub = (subscriber && typeof subscriber === 'object') ? subscriber : {};
  const r = (report && typeof report === 'object') ? report : {};
  const name = sub.restaurant_name || (r._debug && r._debug.subject) || 'Your restaurant';
  const loc = sub.location || '';
  const score = typeof r.healthCheckScore === 'number' ? r.healthCheckScore : null;

  const pillars = (r.pillars && typeof r.pillars === 'object') ? r.pillars : {};
  const pillarRows = Object.entries(pillars).map(([k, v]) => {
    const s = v && typeof v.score === 'number' ? v.score : null;
    const band = bandFor(s);
    const label = (v && v.label) || k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
    return `<div class="pillar">
      <span class="nm">${esc(label)}</span>
      <span class="bar"><span class="fill b-${band}" style="width:${s === null ? 0 : Math.max(0, Math.min(100, s))}%"></span></span>
      <span class="sc">${s === null ? '&mdash;'.replace('&mdash;', '-') : esc(num(s))}</span>
    </div>`;
  }).join('\n');

  const comps = Array.isArray(r.competitors) ? r.competitors : [];
  const peerRows = comps.map(c => {
    if (!c || typeof c !== 'object') return '';
    // A rating and a review count are shown ONLY when they came from Places.
    // This is the RVP-A rule carried into the format, so the prototype cannot
    // reintroduce an unprovenanced number. A report stored BEFORE v8.11.26 has
    // no provenance fields at all, and those legacy numbers are shown as they
    // were rather than silently blanked: this is a format change, not a
    // content change, and blanking them would lose content.
    const legacy = c.reviewCountSource === undefined && c.ratingSource === undefined;
    const showRating = legacy ? num(c.rating) : (c.ratingSource === 'places' ? num(c.rating) : null);
    const showCount = legacy ? fmt(c.reviewCount) : (c.reviewCountSource === 'places' ? fmt(c.reviewCount) : null);
    const parts = [
      showRating ? esc(showRating) + ' rating' : null,
      showCount ? esc(showCount) + ' reviews' : null,
    ].filter(Boolean);
    const meta = parts.length
      ? parts.join('<br>')
      : `<span class="no-count">${esc(c.noDataReason || 'No Google listing matched.')}</span>`;
    return `<div class="peer">
      <div><div class="nm">${esc(c.name || '(unnamed)')}</div>${
        c.note ? `<div class="note">${esc(c.note)}</div>` : ''}</div>
      <div class="meta">${meta}</div>
    </div>`;
  }).join('\n');

  const ev = r.evidence && typeof r.evidence === 'object' ? r.evidence : null;
  let evidenceInner = '';
  if (ev) {
    const cells = [
      ['Searches run', ev.searchesRun], ['Results returned', ev.resultsReturned],
      ['Results read', ev.resultsRead], ['Distinct sites read', ev.distinctSites],
    ].map(([l, v]) => {
      const n = fmt(v);
      return n === null ? '' : `<div class="ev-cell"><div class="ev-n">${esc(n)}</div><div class="lab">${esc(l)}</div></div>`;
    }).filter(Boolean).join('');
    evidenceInner = (cells ? `<div class="ev-grid">${cells}</div>` : '')
      + (ev.reviewsSentence ? `<p class="ev-s">${esc(ev.reviewsSentence)}</p>` : '');
  }

  const actions = []
    .concat(Array.isArray(r.actions) ? r.actions : [])
    .concat(Array.isArray(r.commercialActions) ? r.commercialActions : []);
  const actionTiles = actions.map(a => {
    if (!a || typeof a !== 'object') return '';
    return `<div class="tile"><h4>${esc(a.title || '')}</h4>
      ${a.desc ? `<p>${esc(a.desc)}</p>` : ''}
      ${a.evidence ? `<p class="lab" style="margin-top:8px">${esc(a.evidence)}</p>` : ''}</div>`;
  }).filter(Boolean).join('');

  const body = [
    sectionCard('Executive summary', proseBlock(r.executiveSummary) || '<p class="prose">No summary was produced for this assessment.</p>'),
    sectionCard('Evidence base', evidenceInner),
    sectionCard('Pillar performance', pillarRows),
    sectionCard('Reviewer perception vs reality', proseBlock(r.ownerSentimentSummary, r.perceptionGap, r.sentimentGap)),
    sectionCard('Financial and operational reality', proseBlock(r.businessRealityAnalysis)),
    sectionCard('Strengths and risks',
      (listBlock(r.strengths) ? `<p class="lab">Strengths</p>${listBlock(r.strengths)}` : '')
      + (listBlock(r.risks) ? `<p class="lab" style="margin-top:14px">Risks</p>${listBlock(r.risks)}` : '')),
    sectionCard('Themes', listBlock(r.themes)),
    sectionCard('Competitive landscape',
      peerRows + (r.competitorSourceNote ? `<p class="ev-s">${esc(r.competitorSourceNote)}</p>` : '')),
    sectionCard('Sentiment signals', proseBlock(r.employeeSentiment, r.competitiveInsight)),
    sectionCard('Recommended actions', actionTiles ? `<div class="grid2">${actionTiles}</div>` : ''),
    sectionCard('Methodology',
      `<p class="prose">This assessment reads public sources about ${esc(name)} and the restaurants Google Places lists nearby. `
      + `Scores are analytical estimates from public signal, not statistically validated research.</p>`),
    sectionCard('What is not in this assessment',
      `<ul class="clean">
        <li>No private review data, and no access to any booking, till or payroll system.</li>
        <li>No individual review is read in full. Each source is read as its public summary.</li>
        <li>A peer with no Google Places match carries no review count here.</li>
      </ul>`),
  ].filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} · DiagnostiX</title>
<style>${css()}</style>
</head><body>
<div class="band"><div class="wrap">
  <h1>${esc(name)}</h1>
  <p class="sub">${esc(loc || 'Restaurant Value Proposition assessment')}</p>
  <div class="score-row">
    ${score === null ? '' : `<div class="score-dial"><div class="n">${esc(num(score))}</div><div class="l">Health check</div></div>`}
    ${(sub.plan_type) ? `<div class="score-dial"><div class="n" style="font-size:1.3rem">${esc(sub.plan_type === 'annual' ? 'Annual' : 'One off')}</div><div class="l">Plan</div></div>` : ''}
  </div>
</div></div>
<div class="wrap">
${body}
</div>
</body></html>`;
}
