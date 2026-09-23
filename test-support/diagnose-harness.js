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
        body: JSON.stringify({ name: 'Teclados', location: 'Santiago, Chile' }),
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
