// Drives the REAL POST /diagnose route over a socket, with the model and every
// outbound fetch replaced, so nothing leaves the machine and nothing is spent.
//
// Lives outside test/ on purpose: node --test runs every .js file under a
// directory named test, and this file has no tests of its own.
//
// The caller sets the environment and imports server.js itself, then passes
// the __test__ seam in, because the environment must be in place before the
// module is first imported.

const emptyFetch = async () => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({}), text: async () => '{}',
});

function fakeModel(pillars) {
  return async (prompt, opts) => {
    const label = (opts && opts.label) || '';
    if (label === 'diagnose-p1') return { cuisineDetected: 'italian', priceDetected: '$$', pillars };
    if (label === 'diagnose-p2') return { strengths: ['a'], risks: ['b'], competitors: [], actions: [] };
    if (label === 'diagnose-summary') return { executiveSummary: 'A clean summary that names no band.' };
    return {};
  };
}

export function diagnoseHarness(seam) {
  const { app, setFetch, setClaude } = seam;
  return async function postDiagnose(pillars) {
    const restoreFetch = setFetch(emptyFetch);
    const realGlobal = globalThis.fetch;
    globalThis.fetch = emptyFetch;
    const restoreClaude = setClaude(fakeModel(pillars));
    const server = app.listen(0);
    try {
      await new Promise((r) => server.once('listening', r));
      const res = await realGlobal('http://127.0.0.1:' + server.address().port + '/diagnose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // placeId, as Analytics sends it. The contract this harness serves is
        // the Analytics one, and since the review gate (2026-09-26) a request
        // with no placeId is the SURVEY path, which is gated on the subject's
        // Google review count; with every fetch empty that count is unknown
        // and the survey path refuses. The survey path's own states are
        // driven in test/review-gate-route.test.js.
        body: JSON.stringify({ name: 'Teclados', location: 'Santiago, Chile', placeId: 'ChIJ-harness' }),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
      globalThis.fetch = realGlobal;
      restoreClaude();
      restoreFetch();
    }
  };
}
