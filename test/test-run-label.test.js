// ════════════════════════════════════════════════════════════════════════════
// AN EMAIL SENT WHILE THE TEST-RUN MARKER IS SET SAYS "[TEST RUN]" IN ITS
// SUBJECT (Simon, 2026-09-24).
//
// Three real "summary-gate-failed" alerts reached the inbox from test runs
// under production credentials on 2026-09-24, and one was read the next
// evening as a customer incident. scripts/guard-test-env.cjs starts every
// suite with DIAGNOSTIX_TEST_RUN=1; sendEmailViaResend, the only function in
// this service that calls Resend, prefixes the subject while it is set.
//
// Driven through the real sender with the module's fetch capturing the call.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39383';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.RESEND_API_KEY = 'test-key-not-real';

const { __test__ } = await import('../server.js');
const { setFetch, sendEmailViaResend } = __test__;

async function subjectSent(marker) {
  const was = process.env.DIAGNOSTIX_TEST_RUN;
  if (marker == null) delete process.env.DIAGNOSTIX_TEST_RUN; else process.env.DIAGNOSTIX_TEST_RUN = marker;
  let subject = null;
  const restore = setFetch(async (url, init) => {
    subject = JSON.parse(init.body).subject;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'x' }) };
  });
  try { await sendEmailViaResend({ to: 'someone@example.invalid', subject: 'summary-gate-failed', html: '<p>x</p>' }); }
  finally { restore(); if (was == null) delete process.env.DIAGNOSTIX_TEST_RUN; else process.env.DIAGNOSTIX_TEST_RUN = was; }
  return subject;
}

test('WITH THE MARKER SET, THE SUBJECT BEGINS "[TEST RUN] "', async () => {
  assert.equal(await subjectSent('1'), '[TEST RUN] summary-gate-failed');
});

test('CONTROL: without the marker (production), the subject is unchanged', async () => {
  assert.equal(await subjectSent(null), 'summary-gate-failed');
  assert.equal(await subjectSent('0'), 'summary-gate-failed', 'only "1" is the marker');
});
