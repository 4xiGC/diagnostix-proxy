// ════════════════════════════════════════════════════════════════════════════
// THE PROOF PAGE SHOWS ONLY WHAT WAS STORED (2026-09-26, Simon's change to C1).
//
// "How this report was built" leaves out any section, and any row, with no
// stored value, and ends with "Reports issued from 26 September 2026 record
// every value on this page." That sentence must be TRUE, so:
//   (a) a stored pre-provenance payload: the empty sections are absent, no row
//       reads "not recorded", and the closing sentence ends the page;
//   (b) a payload from the CURRENT writer, made by the real /diagnose route with
//       the Anthropic API and every other fetch replaced at the network level
//       (so claude() runs and records its passes): all seven sections appear,
//       and nothing on the page reads "not recorded".
// 26 September 2026 is the day 8.11.60 went live (00:11Z), the release that
// stores provenance; the other fields the page reads were stored earlier.
// Nothing leaves the machine and nothing is spent.
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39812';
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
const { PROOF_HEADINGS, PROOF_CLOSING } = await import('../lib-proof-page.js');

const CLOSING = 'Reports issued from 26 September 2026 record every value on this page.';
const P = (s, label) => ({ score: s, label, status: 'good' });
const PILLARS6 = { cs: P(70, 'Customer Sentiment'), pa: P(66, 'Pricing & Accessibility'), es: P(60, 'Employee Sentiment'), sm: P(58, 'Social Media Impact'), cp: P(72, 'Competitive Positioning'), bg: P(68, 'Brand Experience & Growth') };

const render = (r) => __test__.renderReportHtml({ subscriber: { restaurant_name: 'Orchid Restaurant', location: 'Harrogate', email: 'x@example.org' }, report: r, reportLabel: 'Full Report' });
const proofOf = (html) => {
  const at = html.indexOf('class="proof-page"');
  assert.ok(at > 0, 'the proof page is not on the report');
  return html.slice(at, html.indexOf('</section>', at) + 10);
};
const headingsOf = (proof) => [...proof.matchAll(/<span class="proof-h">([^<]*)<\/span>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
const textOf = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('the closing sentence is the one Simon approved, with the provenance release date', () => {
  assert.equal(PROOF_CLOSING, CLOSING);
});

test('(a) A STORED PRE-PROVENANCE PAYLOAD: empty sections are left out, nothing reads "not recorded", the sentence ends the page', () => {
  // The shape of a report stored before 8.11.50: pillars, evidence counts, a
  // service version and the nearby count, and no subject, coverage or provenance.
  const OLD = {
    pillars: PILLARS6, executiveSummary: 'A summary.',
    actions: [{ priority: 'urgent', title: 'Fix pacing', desc: 'Reviews mention long waits.' }],
    evidence: { searchesRun: 9, resultsReturned: 87, resultsRead: 72, distinctSites: 29, reviewsTotal: 10461 },
    _debug: { version: '8.11.40', totalMs: 41000, googlePlaces: { count: 12 } },
  };
  const proof = proofOf(render(OLD));
  const shown = headingsOf(proof);
  assert.ok(!shown.includes('Coverage'), 'Coverage has no stored value and must be left out');
  assert.ok(!shown.includes('Confidence'), 'Confidence has no stored value (no coverage state, no provenance) and must be left out');
  for (const h of ['What was assessed', 'What we read', 'How it was scored', 'Revision notes']) assert.ok(shown.includes(h), h + ' has a stored value and must stay');
  assert.deepEqual(shown, PROOF_HEADINGS.filter((h) => shown.includes(h)), 'the sections shown keep the standard\'s order');
  assert.doesNotMatch(proof, /not recorded/i, 'a row with no stored value is left out, not printed as "not recorded"');
  assert.ok(textOf(proof).endsWith(CLOSING), 'the page does not end with the closing sentence: ' + textOf(proof).slice(-160));
});

test('(a, control) an empty payload keeps only what is not read from the payload, and still ends with the sentence', () => {
  const proof = proofOf(render({ pillars: PILLARS6, executiveSummary: 'A summary.' }));
  assert.deepEqual(headingsOf(proof), ['What was assessed', 'How it was scored', 'Revision notes']);
  assert.doesNotMatch(proof, /not recorded/i);
  assert.ok(textOf(proof).endsWith(CLOSING));
});

// (b) THE CURRENT WRITER, through the real /diagnose route.
const PILLARS = { cs: { score: 66 }, pa: { score: 70 }, es: { score: 42 }, sm: { score: 48 }, cp: { score: 58 }, bg: { score: 72 } };
const envelope = (obj) => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } });
async function currentWriterPayload() {
  const fake = async (url, init) => {
    if (String(url).includes('api.anthropic.com')) {
      const p = JSON.parse(init.body).messages[0].content;
      const out = p.includes('Translate any non-English')
        ? { strengths: ['a'], risks: ['b'], competitors: [], actions: [{ priority: 'urgent', title: 'Fix pacing', desc: 'Reviews mention long waits.' }] }
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

test('(b) THE CURRENT WRITER: all seven sections appear, and nothing reads "not recorded"', async () => {
  const payload = await currentWriterPayload();
  assert.ok(payload.provenance && Array.isArray(payload.provenance.passes) && payload.provenance.passes.length >= 2,
    'the stub bypassed claude(), so the run recorded no passes and this proves nothing');
  const proof = proofOf(render(payload));
  assert.deepEqual(headingsOf(proof), PROOF_HEADINGS);
  assert.doesNotMatch(proof, /not recorded/i, 'a current run left a row unstored, so the closing sentence would be false');
  assert.ok(textOf(proof).endsWith(CLOSING));
});
