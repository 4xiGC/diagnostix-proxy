// ════════════════════════════════════════════════════════════════════════════
// A PEER COMPARISON THAT ASSESSED NOBODY IS NOT A COMPARISON (Simon, 2026-11-18).
//
// 8.11.53 added the zero_assessed refusal in fetchPeerComparison after the
// 2026-09-23 paid report read "against 0 comparable businesses". Nothing tested
// it: on 2026-11-18 a copy of server.js with the check deleted accepted the
// zero-peer fragment, and no suite would have turned red. This file pins it.
// Analytics 0.5.11 also refuses such a run itself (ok:false); both answers must
// come back unavailable, so the report carries PEER_COMPARISON_ABSENT and the
// internal alert fires.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39488';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANALYTICS_URL = 'https://analytics.invalid';
process.env.ANALYTICS_TEAM_PASSWORD = 'not-a-password';

const { __test__ } = await import('../server.js');
const { fetchPeerComparison, setFetch } = __test__;

async function ask(answer) {
  let calls = 0;
  const restore = setFetch(async (url) => {
    calls++;
    assert.match(String(url), /^https:\/\/analytics\.invalid\/peer-comparison$/);
    return { ok: true, status: 200, text: async () => JSON.stringify(answer), json: async () => answer };
  });
  try {
    const r = await fetchPeerComparison({ subjectName: 'Teclados', subjectLocation: 'Santiago, Chile',
      subjectPillars: { cs: 70 }, subjectMethod: 'rvp-overall-mean-v3', peerNames: ['Peer One', 'Peer Two'] });
    return { r, calls };
  } finally { restore(); }
}

test('ZERO ASSESSED with ok:true and a fragment (Analytics before 0.5.11): refused as zero_assessed, the fragment never kept', async () => {
  const { r, calls } = await ask({ ok: true, html: '<section>against 0 comparable businesses</section>', runId: 'run-1',
    stats: { named: 2, resolved: 2, assessed: 0, excluded: 0 } });
  assert.equal(calls, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'zero_assessed');
  assert.equal(r.html, undefined, 'the zero-peer fragment was handed back');
  assert.equal(r.detail, 'named=2 resolved=2');
});

test('ZERO ASSESSED with ok:false (Analytics 0.5.11): refused, no fragment', async () => {
  const { r } = await ask({ ok: false, error: 'no peer could be assessed', runId: 'run-1',
    stats: { named: 2, resolved: 2, assessed: 0, excluded: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'refused');
  assert.equal(r.html, undefined);
});

test('CONTROL: one peer assessed is a comparison, and the fragment is kept', async () => {
  const { r } = await ask({ ok: true, html: '<section>against 1 comparable business</section>', runId: 'run-1',
    stats: { named: 2, resolved: 2, assessed: 1, excluded: 0 } });
  assert.equal(r.ok, true);
  assert.match(r.html, /against 1 comparable business/);
});
