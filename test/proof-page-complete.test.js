// ════════════════════════════════════════════════════════════════════════════
// THE PROOF PAGE IS COMPLETE ON NEW RUNS (2026-10-02, Simon Q7).
//
// 8.11.61 left two rows off "How this report was built" because no writer
// stored them: "The rule applied" and "Removed before scoring". This release
// stores, with each run:
//   - coverage.rule: the review gate's thresholds the run used;
//   - removedBeforeScoring: every competitor or peer dropped before scoring,
//     with the reason (an area name, the quality filter, a duplicate place id);
//   - provenance.checks: what the comparison check flagged at delivery, and the
//     summary gate's outcome (the one fallback RVP's writer has: a report that
//     ships without a summary).
// and the page shows them. An old payload still omits both rows. The closing
// sentence's date is ONE constant, COMPLETE_FROM, set at the push to the day
// the release goes live.
// Nothing leaves the machine and nothing is spent. Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39814';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.SERPER_API_KEY = 'test-not-a-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-key';
process.env.RESEND_API_KEY = 'test-not-a-key';
process.env.RVP_IDENTITY_SECRET = 'test-identity-secret';
process.env.RVP_WEBHOOK_SECRET = 'a-test-webhook-secret';
process.env.ANALYTICS_URL = 'https://analytics.invalid';
process.env.ANALYTICS_TEAM_PASSWORD = 'not-a-password';

const { __test__ } = await import('../server.js');
const { signPlaceToken } = await import('../lib-place-token.js');
const PP = await import('../lib-proof-page.js');
const { PROOF_HEADINGS, PROOF_CLOSING } = PP;

const P = (s, label) => ({ score: s, label, status: 'good' });
const PILLARS6 = { cs: P(70, 'Customer Sentiment'), pa: P(66, 'Pricing & Accessibility'), es: P(60, 'Employee Sentiment'), sm: P(58, 'Social Media Impact'), cp: P(72, 'Competitive Positioning'), bg: P(68, 'Brand Experience & Growth') };
const render = (r) => __test__.renderReportHtml({ subscriber: { restaurant_name: 'Orchid Restaurant', location: 'Harrogate', email: 'x@example.org' }, report: r, reportLabel: 'Full Report' });
const proofOf = (html) => { const at = html.indexOf('class="proof-page"'); assert.ok(at > 0, 'the proof page is not on the report'); return html.slice(at, html.indexOf('</section>', at) + 10); };
const headingsOf = (proof) => [...proof.matchAll(/<span class="proof-h">([^<]*)<\/span>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
const textOf = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

test('COMPLETE_FROM is one constant, and the closing sentence is built from it (set at the push to the go-live day)', () => {
  assert.equal(PP.COMPLETE_FROM, '27 September 2026', 'PROVISIONAL: the push step sets this to the day the release goes live');
  assert.equal(PROOF_CLOSING, 'Reports issued from ' + PP.COMPLETE_FROM + ' record every value on this page.');
});

// The current writer, through the real /diagnose route. p2 names one area, not a
// restaurant ("Marin Dining District"), which the non-restaurant filter drops.
const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };
const envelope = (obj) => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } });
async function currentWriterPayload() {
  const fake = async (url, init) => {
    if (String(url).includes('api.anthropic.com')) {
      const p = JSON.parse(init.body).messages[0].content;
      const out = p.includes('Translate any non-English')
        ? { strengths: ['a'], risks: ['b'], competitors: [{ name: 'Marin Dining District', rating: 4.2, reviewCount: 300, note: 'An area.' }],
            actions: [{ priority: 'urgent', title: 'Fix pacing', desc: 'Reviews mention long waits.' }] }
        : p.startsWith('IMPORTANT: Write ALL text values in English only')
          ? { cuisineDetected: 'italian', priceDetected: '$$', pillars: PILLARS }
          : { executiveSummary: 'A clean summary that names no band.' };
      const body = envelope(out);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(body), text: async () => body };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
  };
  const restoreFetch = __test__.setFetch(fake); const realGlobal = globalThis.fetch; globalThis.fetch = fake;
  const server = __test__.app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const token = signPlaceToken({ place: { placeId: 'ChIJ-x', name: 'Casa Teclados SpA', address: 'Av. Italia 1234', rating: 4.4, reviewCount: 900, lat: -33.4, lng: -70.6 },
      secret: 'test-identity-secret', issuedAt: Date.now() });
    const res = await realGlobal('http://127.0.0.1:' + server.address().port + '/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Teclados', location: 'Santiago, Chile', placeToken: token }) });
    assert.equal(res.status, 200);
    return await res.json();
  } finally { server.close(); globalThis.fetch = realGlobal; restoreFetch(); }
}

let PAYLOAD;
test('(b) THE CURRENT WRITER STORES the rule applied, what was removed before scoring, and the checks', async () => {
  PAYLOAD = await currentWriterPayload();
  assert.ok(PAYLOAD.provenance && PAYLOAD.provenance.passes && PAYLOAD.provenance.passes.length >= 2, 'the stub bypassed claude(); this proves nothing');
  assert.deepEqual(PAYLOAD.coverage && PAYLOAD.coverage.rule, { minSubjectReviews: 50, limitedBelowReviews: 300, maxDaysSinceNewestReview: 180 });
  assert.ok(Array.isArray(PAYLOAD.removedBeforeScoring), 'removedBeforeScoring is not stored');
  assert.ok(PAYLOAD.removedBeforeScoring.some((x) => x.name === 'Marin Dining District' && /area/i.test(x.reason)),
    'the area name dropped by the filter is not recorded: ' + JSON.stringify(PAYLOAD.removedBeforeScoring));
  const ch = PAYLOAD.provenance.checks;
  assert.ok(ch && Array.isArray(ch.comparisonFlags), 'the comparison check\'s flags are not stored');
  assert.equal(ch.summaryGate, PAYLOAD.summaryGate);
});

test('(b) THE PAGE: all seven sections, both returned rows, the checks row, nothing "not recorded", the closing sentence last', async () => {
  const payload = PAYLOAD || await currentWriterPayload();
  const proof = proofOf(render(payload));
  const text = textOf(proof);
  assert.deepEqual(headingsOf(proof), PROOF_HEADINGS);
  assert.match(text, /The rule applied At least 50 Google reviews/);
  assert.match(text, /Removed before scoring Marin Dining District \(an area name, not a restaurant\)/);
  assert.match(text, /Comparisons checked against their own numbers/);
  assert.doesNotMatch(proof, /not recorded/i);
  assert.ok(text.endsWith(PROOF_CLOSING), text.slice(-160));
});

test('(b, control) a run that removed nothing stores an empty list, and the page says "None", not a gap', () => {
  const proof = proofOf(render({ pillars: PILLARS6, executiveSummary: 'A summary.', removedBeforeScoring: [],
    coverage: { state: 'pass', subjectReviewCount: 900, rule: { minSubjectReviews: 50, limitedBelowReviews: 300, maxDaysSinceNewestReview: 180 } } }));
  assert.match(textOf(proof), /Removed before scoring None/);
});

test('(a) AN OLD PAYLOAD still leaves both rows out (no rule, no removals stored)', () => {
  const OLD = { pillars: PILLARS6, executiveSummary: 'A summary.', coverage: { state: 'pass', subjectReviewCount: 900 },
    evidence: { searchesRun: 9, resultsReturned: 87, resultsRead: 72, distinctSites: 29 }, _debug: { version: '8.11.55', totalMs: 41000 } };
  const text = textOf(proofOf(render(OLD)));
  assert.doesNotMatch(text, /The rule applied/);
  assert.doesNotMatch(text, /Removed before scoring/);
  assert.doesNotMatch(text, /Comparisons checked against their own numbers/);
  assert.doesNotMatch(text, /not recorded/i);
});
