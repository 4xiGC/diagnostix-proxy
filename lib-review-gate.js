// ════════════════════════════════════════════════════════════════════════════
// THE REVIEW-COUNT AND RECENCY GATE (RVP_SAFEGUARDS_SPEC.md section 3; the
// states and copy of SUBJECT_INTEGRITY_STANDARD.md 1.1 and 1.2). Pure: no I/O,
// no env, no clock unless one is passed.
//
// THE QUANTITY. The subject's own Google Places review count, user_ratings_total
// on the focal findplacefromtext candidate. The standard's 3.2 wrote the rule
// over evidence.reviewsTotal and sourcesCounted; read in the code, those are a
// SUM over the subject and every peer with a place id, and a count of
// BUSINESSES, not review platforms (lib-places-peers.js peerReviewVolumes). A
// thin restaurant on a busy street would pass on its neighbors' reviews. So
// this gate reads the subject's count alone.
//
// MIN_SOURCES IS PRESENT AND OFF (null). RVP counts no review platforms
// anywhere, so there is nothing for it to read; turning it on needs a platform
// count first.
//
// RECENCY UNKNOWN DOES NOT DOWNGRADE. RVP makes no Place Details call, so no
// review date is read today and recency is "unknown" on every run. Marking
// every report limited for a date nobody read would be a claim about the
// business made from an absence in our own data.
// ════════════════════════════════════════════════════════════════════════════

export const REVIEW_GATE = Object.freeze({
  MIN_SUBJECT_REVIEWS: 50,           // below: refused-coverage
  LIMITED_BELOW_REVIEWS: 300,        // below: limited
  MAX_DAYS_SINCE_NEWEST_REVIEW: 180, // older: limited (only when a date is known)
  MIN_SOURCES: null,                 // off: RVP counts no review platforms
});

export const CONTACT_ADDRESS = 'hello@4xiconsulting.com';

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

export function reviewGate(input, overrides, now) {
  const p = Object.assign({}, REVIEW_GATE, overrides || {});
  const i = (input && typeof input === 'object') ? input : {};
  const n = count(i.subjectReviewCount);
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const newest = i.newestReviewAt ? Date.parse(i.newestReviewAt) : NaN;
  const ageDays = Number.isFinite(newest) ? Math.floor((t - newest) / 86400000) : null;
  const recency = ageDays === null ? 'unknown' : (ageDays > p.MAX_DAYS_SINCE_NEWEST_REVIEW ? 'old' : 'recent');
  const base = { subjectReviewCount: n, newestReviewAt: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
    ageDays, recency, thresholds: p };

  if (n === null) return { ...base, state: 'refused-coverage', reason: 'subject-reviews-unknown' };
  if (n < p.MIN_SUBJECT_REVIEWS) return { ...base, state: 'refused-coverage', reason: 'subject-reviews-below-minimum' };
  if (n < p.LIMITED_BELOW_REVIEWS) return { ...base, state: 'limited', reason: 'subject-reviews-thin' };
  if (recency === 'old') return { ...base, state: 'limited', reason: 'newest-review-old' };
  return { ...base, state: 'pass', reason: 'enough-reviews' };
}

const fmt = (n) => Number(n).toLocaleString('en-US');

// ── THE REFUSAL LAYOUT (Simon, 2026-09-28; the same in SVP and EVP) ─────────
//
// Five parts, in this order: heading, the plain reason, what happens next, the
// consultant route, and ONE closing line chosen by medium. `body` keeps the
// flattened reason, next and consultant, so a reader written before the layout
// still gets every sentence.
const CONSULTANT_READS_MORE = 'A consultant-led assessment reads sources this scan cannot, including material '
  + 'behind logins, in other languages, and supplied by you.';
function closingFor(channel) {
  return channel === 'email'
    ? 'If you would like one, reply to this email and we will arrange it.'
    : `If you would like one, email ${CONTACT_ADDRESS} and we will arrange it.`;
}
function layout({ heading, reason, next, consultant, channel }) {
  return { heading, reason, next, consultant, closing: closingFor(channel), body: [...reason, ...next, consultant] };
}

// The coverage refusal, in RVP terms. The reason states the count and the
// rule, because RVP's rule is a count, not a share. ITS CAUSE IS ITS OWN
// (standard, section 5 row 14): an RVP refusal is a thin Google review count
// on a place the requester CONFIRMED, so the SVP and EVP cause, "a name that
// public sources do not use", does not apply.
export function refusalCopy({ subject, gate, channel }) {
  const s = String(subject || 'this business');
  const g = gate || {};
  const min = (g.thresholds && g.thresholds.MIN_SUBJECT_REVIEWS) || REVIEW_GATE.MIN_SUBJECT_REVIEWS;
  const happened = g.subjectReviewCount === null || g.subjectReviewCount === undefined
    ? `Google lists no review count for ${s}. The rule requires at least ${fmt(min)} reviews on Google.`
    : `Google lists ${fmt(g.subjectReviewCount)} reviews for ${s}. The rule requires at least ${fmt(min)}.`;
  return layout({
    heading: `We cannot assess ${s} yet`,
    reason: [
      happened + ' The rule is fixed in advance and is the same for every business.',
      `Reviews are the public record this assessment reads, and fewer than ${fmt(min)} is not enough to assess `
        + 'a business fairly. This is not a judgment about the business.',
    ],
    next: [
      'You have not been charged, and no assessment was produced.',
      `When ${s} has at least ${fmt(min)} reviews on Google, you can run the assessment again.`,
    ],
    consultant: CONSULTANT_READS_MORE,
    channel,
  });
}

// The identity refusal: Google returned no business for the name typed.
export function noMatchCopy(name, channel) {
  const s = String(name || 'this restaurant');
  return layout({
    heading: `We could not find ${s} on Google`,
    reason: ['We searched Google for the name and location you entered and found no matching business, so there is '
      + 'nothing to assess yet.'],
    next: ['You have not been charged.', 'Check the spelling of the name and add the city and country, then try again.'],
    consultant: 'A consultant-led assessment does not depend on a Google listing.',
    channel,
  });
}

// The limited coverage note, printed with the assessment. Null on a pass.
export function limitedNote({ subject, gate }) {
  const s = String(subject || 'this business');
  const g = gate || {};
  if (g.state !== 'limited') return null;
  const p = g.thresholds || REVIEW_GATE;
  if (g.reason === 'newest-review-old') {
    return `The newest public review of ${s} we could read is more than ${p.MAX_DAYS_SINCE_NEWEST_REVIEW} days old. `
      + 'The assessment is produced, and it describes the business as its reviewers saw it then.';
  }
  return `Google lists ${fmt(g.subjectReviewCount)} reviews for ${s}, fewer than ${fmt(p.LIMITED_BELOW_REVIEWS)}. `
    + 'The assessment is produced, and the thinner the public signal, the more it rests on a small number of reviews.';
}

// The limited note as the delivered report prints it. Empty unless the stored
// report says limited and carries a note, so a report from before the gate
// renders exactly as it did.
export function coverageNoteHtml(report) {
  const c = report && report.coverage;
  if (!c || c.state !== 'limited' || typeof c.note !== 'string' || !c.note.trim()) return '';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `
      <div class="cov-note"><span class="cov-k">Limited coverage.</span> ${esc(c.note)}</div>`;
}
