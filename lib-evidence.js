// ── The evidence base panel (v8.11.24) [ALL-1] ──────────────────────────────
//
// WHAT THIS REPLACES. Reports used to quote a number of "feedback reference
// points". It was removed because the numbers were not true: SVP's 170 is the
// pipeline cap, identical on every report whatever was actually found. A
// constant dressed as a measurement is worse than no measurement, because a
// reader who checks it once stops believing everything next to it.
//
// THE RULE FOR EVERY FIGURE HERE. It is counted from what the pipeline
// actually did on THIS assessment, or it does not appear. Nothing is
// estimated, nothing is defaulted, and a figure that could not be computed is
// omitted rather than printed as a zero, because "0 reviews" reads as a
// finding about the subject when it is really an absence of instrumentation.
//
// WHY RVP'S VERSION IS THE STRONGEST OF THE THREE. Its review volumes are
// Google Places user_ratings_total values for the focal restaurant and each
// peer: exact integers, already fetched, already tied to a place_id. There is
// no name matching, so there is no subject test to get wrong. SVP and EVP must
// read volumes out of result text and then prove the row is about the subject,
// which is a much weaker position and is handled separately in those repos.

export function newLedger() {
  return {
    searchesRun: 0,
    resultsReturned: 0,
    resultsRead: 0,
    sites: new Set(),
  };
}

// A search counts as run even when it returns nothing. "We ran 14 searches and
// read 9 results" is true and useful; counting only the fruitful ones would
// flatter the report in exactly the place where it is weakest.
export function noteSearch(ledger, _info) {
  if (!ledger || typeof ledger !== 'object') return;
  ledger.searchesRun += 1;
}

// `read` is how many of the returned results actually entered the corpus,
// after the slice and the budget. It is clamped to what came back, so the
// panel can never report a cap again.
export function noteResults(ledger, info) {
  if (!ledger || typeof ledger !== 'object') return;
  const organic = (info && Array.isArray(info.organic)) ? info.organic : [];
  ledger.resultsReturned += organic.length;

  const wanted = (info && Number.isFinite(Number(info.read))) ? Number(info.read) : 0;
  const read = Math.max(0, Math.min(organic.length, Math.floor(wanted)));
  ledger.resultsRead += read;

  // Only the results actually READ contribute a site. Claiming the host of a
  // result that was sliced away would be a false claim in the panel's own
  // words: it says "sites read".
  for (let i = 0; i < read; i++) {
    const row = organic[i];
    const h = hostOf(row && typeof row === 'object' ? row.link : null);
    if (h) ledger.sites.add(h);
  }
}

export function hostOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return null;
  }
}

export function summarizeEvidence(ledger) {
  const l = (ledger && typeof ledger === 'object') ? ledger : newLedger();
  const sites = (l.sites instanceof Set) ? [...l.sites] : [];
  return {
    searchesRun: l.searchesRun || 0,
    resultsReturned: l.resultsReturned || 0,
    resultsRead: l.resultsRead || 0,
    distinctSites: sites.length,
    sites: sites.sort(),
  };
}

export function formatCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n.toLocaleString('en-US');
}

// The agreed wording, and the zero case.
//
// Returns null whenever there is nothing honest to say. A caller that renders
// null renders nothing, which is the intended behaviour: the panel shrinks
// rather than reaching for a number it does not have.
//
// The second sentence is not decoration. Without it the first reads as a claim
// to have processed 3,412 reviews, which is false: the pipeline reads each
// source's public summary, and the volume is context for how much opinion
// stands behind that summary.
export function renderEvidenceSentence(args) {
  // Not a destructuring default: `= {}` does not apply when null is passed
  // explicitly, and a caller with nothing to report will pass exactly that.
  const { reviewsTotal, sourcesCounted } = (args && typeof args === 'object') ? args : {};
  if (typeof reviewsTotal !== 'number' || !Number.isFinite(reviewsTotal)
      || !Number.isInteger(reviewsTotal) || reviewsTotal <= 0) {
    return null;
  }
  // AT LEAST TWO SOURCES. Found while rehearsing SVP's Edinburgh corpus, which
  // produced exactly one source and therefore "The sources read for this
  // assessment publish 1 review and rating between them." Plural "sources" and
  // "between them" are both false about a single item. Wording integrity, not
  // a flattering threshold: the counts above the sentence still render, so a
  // thin assessment still looks thin.
  if (typeof sourcesCounted !== 'number' || !Number.isFinite(sourcesCounted) || sourcesCounted < 2) {
    return null;
  }
  const n = formatCount(reviewsTotal);
  if (n === null) return null;
  const noun = reviewsTotal === 1 ? 'review and rating' : 'reviews and ratings';
  return `The sources read for this assessment publish ${n} ${noun} between them. `
    + 'DiagnostiX reads the public summary of each source, not every individual review.';
}

// ── ALL-1: the evidence base panel ──────────────────────────────────────────
//
// Renders NOTHING when there is nothing honest to render. An assessment from
// before this release has no report.evidence at all, and one where the counts
// could not be taken has nulls, and both cases produce an empty string rather
// than a panel full of zeros. Every stored report keeps rendering exactly as
// it does today, which is the property that lets this ship without touching
// anyone's existing link.
//
// Four counts and one sentence. The counts are what the pipeline did; the
// sentence is what the sources it read publish between them. The second half
// of the sentence is load bearing: without it the first reads as a claim to
// have processed every one of those reviews, which is false.
export function evidencePanelHtml(report) {
  const e = report && report.evidence;
  if (!e || typeof e !== 'object') return '';

  // Its own escape: renderReportHtml's `esc` is a local const inside that
  // function and is not in scope here.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const rows = [];
  const add = (label, v) => {
    const n = formatCount(typeof v === 'number' ? v : NaN);
    if (n !== null) rows.push({ label, n });
  };
  add('Searches run', e.searchesRun);
  add('Results returned', e.resultsReturned);
  add('Results read', e.resultsRead);
  add('Distinct sites read', e.distinctSites);
  if (!rows.length && !e.reviewsSentence) return '';

  // No empty grid element when there are no counts: a stored report has only
  // the sentence, and an empty div renders as a stray gap above it.
  const grid = rows.length
    ? `<div class="ev-grid">` + rows.map(r =>
        `<div class="ev-cell"><div class="ev-n">${esc(r.n)}</div><div class="ev-l">${esc(r.label)}</div></div>`
      ).join('') + `</div>`
    : '';

  const sentence = e.reviewsSentence
    ? `<p class="ev-s">${esc(e.reviewsSentence)}</p>` : '';

  return `
      <h2 class="rpt-h">Evidence base</h2>
      <div class="ev-panel">
        ${grid}
        ${sentence}
      </div>`;
}
