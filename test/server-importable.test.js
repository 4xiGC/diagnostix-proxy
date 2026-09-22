// ════════════════════════════════════════════════════════════════════════════
// THE SUBSCRIBER WRITES ARE REACHABLE FROM A TEST.
//
// WHY THIS FILE EXISTS. Every subscriber write in this service lives in a
// function inside server.js, and until now no test could call any of them,
// because importing server.js bound a port and served. So
// test/one-sale-one-row.test.js was written against a RE-IMPLEMENTATION of the
// rule: it posts to a fake and asserts the fake counted the post. That test
// cannot fail on the real code being wrong, which is the whole point of
// having it.
//
// This file does not test any rule. It tests that the seam exists, so the
// files that do test rules can be wired to the real functions.
//
// THE COST OF NOT HAVING IT, twice over: the 2026-09-20 double delivery was in
// findOrderRow, which no test had ever called, and an overnight run left a
// stray listener on port 3000 for eleven hours because the only way to reach
// this module was to start it.
//
// HOW "IT DID NOT LISTEN" IS CHECKED. By asking the port for a reply, not by
// trying to bind it. The first version of this file tried to bind, and on
// Windows binding 127.0.0.1:3000 SUCCEEDS while Express holds :::3000, so the
// check reported "free" against a server.js with no guard at all and passed
// twice. Measured 2026-09-22: bind 127.0.0.1 -> bound, bind 0.0.0.0 -> bound,
// bind :: -> EADDRINUSE, GET / -> HTTP 404. Only the request saw the truth.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A port of this file's own, so a real RVP running on 3000 on Simon's machine
// cannot make this test fail and cannot make it pass either.
const PORT = 39211;

// Both set BEFORE the import: they are read at module evaluation.
process.env.PORT = String(PORT);
process.env.RVP_IMPORT_ONLY = '1';

// An unroutable project. Nothing here reaches a real Supabase, and the module
// must not need these to be valid simply to load.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://db.invalid';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'not-a-key';

const mod = await import('../server.js');

// Resolves to an HTTP status when something answers, or null when the
// connection is refused. app.listen binds asynchronously, so a refusal is
// retried to a deadline rather than believed the first time.
function askOnce(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function servingWithin(port, ms) {
  const deadline = Date.now() + ms;
  do {
    const status = await askOnce(port);
    if (status !== null) return status;
    await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < deadline);
  return null;
}

// ── It loads, and it does not serve ───────────────────────────────────────

test('importing server.js does not serve', async () => {
  const status = await servingWithin(PORT, 1500);
  assert.equal(status, null,
    'something answered on port ' + PORT + ' with HTTP ' + status
    + '. RVP_IMPORT_ONLY did not take effect and this run has left a server up.');
});

test('the seam is exported', () => {
  assert.ok(mod.__test__, 'server.js exports no __test__ seam');
});

test('every function the subscriber rules need is on the seam', () => {
  const needed = ['createCustomer', 'findOrderRow', 'recordSwapOnOrderRow',
    'supersedePlaceholderRow', 'deleteDuplicateSubscriberRow', 'writeSubscribers'];
  for (const name of needed) {
    assert.equal(typeof mod.__test__[name], 'function', name + ' is not on the seam');
  }
});

test('the seam carries the version, so a test can say what it measured', () => {
  assert.match(String(mod.__test__.VERSION), /^\d+\.\d+\.\d+$/);
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the check can see a server that IS serving', async () => {
  // Without this, "nothing answered" would also be the reading for a check
  // that can never see anything, which is how the bind version passed.
  const port = 39212;
  const srv = http.createServer((_, res) => { res.statusCode = 404; res.end(); });
  await new Promise((r) => srv.listen(port, r));
  const status = await servingWithin(port, 1500);
  await new Promise((r) => srv.close(r));
  assert.equal(status, 404, 'the check cannot see a live server, so it proves nothing');
});

test('CONTROL: the check reports nothing on a port with no server', async () => {
  assert.equal(await servingWithin(39213, 200), null);
});

test('CONTROL: the seam check can fail on a name that is not there', () => {
  assert.equal(typeof mod.__test__.noSuchFunction, 'undefined');
});
