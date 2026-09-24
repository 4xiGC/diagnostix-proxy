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

// The standard's skeleton (1.2), in RVP terms: CHANNEL_WORD "sources",
// SUBJECT_NOUN "business". Line 2 states the count and the rule, because RVP's
// rule is a count, not a share.
export function refusalCopy({ subject, gate, channel }) {
  const s = String(subject || 'this business');
  const g = gate || {};
  const min = (g.thresholds && g.thresholds.MIN_SUBJECT_REVIEWS) || REVIEW_GATE.MIN_SUBJECT_REVIEWS;
  const happened = g.subjectReviewCount === null || g.subjectReviewCount === undefined
    ? `Google lists no review count for ${s}. The rule requires at least ${fmt(min)} reviews on Google.`
    : `Google lists ${fmt(g.subjectReviewCount)} reviews for ${s}. The rule requires at least ${fmt(min)}.`;
  return {
    heading: `We cannot assess ${s} yet`,
    body: [
      happened,
      'The most common cause is a name that public sources do not use, or a business whose public presence '
        + 'is mostly in a language or on platforms this scan does not reach. Neither is a judgment about the business.',
      'A consultant-led assessment reads sources this scan cannot, including material behind logins, in other '
        + 'languages, and supplied by you.',
      'You have not been charged for this assessment.',
    ],
    closing: channel === 'email'
      ? 'If you would like a consultant-led assessment, reply to this email and we will arrange it.'
      : `If you would like a consultant-led assessment, email ${CONTACT_ADDRESS} and we will arrange it.`,
  };
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
