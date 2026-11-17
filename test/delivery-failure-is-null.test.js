// ════════════════════════════════════════════════════════════════════════════
// A DELIVERY WHOSE ORDER ROW DID NOT SAVE IS NOT A DELIVERY (Simon, 2026-11-16).
//
// deliverPaidReport returned { delivered: false, rowFailed: true, ... } when the
// order row did not save. That object is truthy, so both callers read it as a
// delivery: the webhook stored rvp_outcomes.delivered = true and did not release
// the survey claim, and the recovery page took its success path. It now returns
// null on that failure, so a truthiness test cannot pass.
//
// Driven through the real deliverPaidReport with every outbound request
// replaced; the database refuses the subscribers insert.
// CONTROL: the same delivery with the insert accepted returns the delivery.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.PORT = '39471';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.ANALYTICS_URL = 'https://analytics.invalid';
process.env.ANALYTICS_TEAM_PASSWORD = 'not-a-password';
process.env.RESEND_API_KEY = 'test-not-a-key';
const { __test__ } = await import('../server.js');
const { deliverPaidReport, setFetch } = __test__;

const REPORT = () => ({
  pillars: {
    cs: { score: 88, label: 'Customer Sentiment' }, pa: { score: 72, label: 'Pricing & Accessibility' },
    es: { score: 62, label: 'Employee Sentiment' }, sm: { score: 58, label: 'Social Media Impact' },
    cp: { score: 81, label: 'Competitive Positioning' }, bg: { score: 84, label: 'Brand Experience & Growth' },
  },
  executiveSummary: 'A clean summary.',
  competitors: [],
});

async function deliver({ insertOk }) {
  const sent = [];
  const fake = async (url, init) => {
    const u = String(url); const i = init || {};
    const method = String(i.method || 'GET').toUpperCase();
    let body = null; try { body = i.body ? JSON.parse(i.body) : null; } catch (_) { body = null; }
    if (u.startsWith('https://api.resend.com')) sent.push(body || {});
    if (u.startsWith('https://db.invalid/rest/v1/subscribers') && method === 'POST' && !insertOk) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ message: 'refused' }), text: async () => '{"message":"refused"}' };
    }
    const answer = u.startsWith('https://db.invalid/rest/v1/subscribers')
      ? (method === 'GET' ? [] : [{ id: 'row-1', report_token: (body && body.report_token) || 'tok' }])
      // 2026-11-17: Resend answers a send with an id. The old fake answered {}, which
      // sendEmailViaResend reads as a failure; that went unseen while the result was ignored.
      : u.startsWith('https://api.resend.com') ? { id: 'em_' + sent.length }
      : u.startsWith('https://analytics.invalid') ? { ok: false } : {};
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  const restore = setFetch(fake);
  const realGlobal = globalThis.fetch; globalThis.fetch = fake;
  const logs = []; const realLog = console.log; const realWarn = console.warn; const realErr = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log;
  try {
    const result = await deliverPaidReport({ destEmail: 'owner@example.test', firstName: 'Ana',
      restaurant: 'Test Kitchen', location: 'London, UK', report: REPORT(),
      survey: { location: 'London, UK', website: '' }, product: 'full', planType: 'one_off',
      amountPaid: 24.99, source: 'test', swapUrl: null });
    return { result, logs, sent };
  } finally { globalThis.fetch = realGlobal; restore(); console.log = realLog; console.warn = realWarn; console.error = realErr; }
}

test('THE ORDER ROW DID NOT SAVE: deliverPaidReport returns null, so no caller can read it as delivered', async () => {
  const r = await deliver({ insertOk: false });
  assert.equal(r.result, null, 'the failure must be falsy: got ' + JSON.stringify(r.result));
  assert.ok(r.logs.some((l) => /\[deliver\] REFUSED: the order row did not save/.test(l)), 'the refusal is logged');
  // Ruling 8 (2026-11-16): exactly one email, the internal alert; none to the customer.
  assert.equal(r.sent.length, 1, 'expected one email, the alert: got ' + r.sent.length);
  assert.deepEqual([].concat(r.sent[0].to), ['hello@4xiconsulting.com']);
  assert.match(r.sent[0].subject, /^(\[TEST RUN\] )?DELIVERY FAILED: a paid report was not sent$/, 'the suite runner prefixes [TEST RUN]');
  assert.match(r.sent[0].html, /Test Kitchen/);
  assert.match(r.sent[0].html, /why the row did not save: insert-http=500/);
  assert.doesNotMatch(JSON.stringify(r.sent), /owner@example\.test/, 'the full paying address is never in the alert');
  assert.ok(r.logs.some((l) => /^DELIVERY_FAILED \[deliver\] alert source=test reason=insert-http=500/.test(l)));
});

test('CONTROL: the row saved, so the delivery is returned and is truthy', async () => {
  const r = await deliver({ insertOk: true });
  assert.ok(r.result && r.result.subscriber, 'a real delivery returns its subscriber');
  assert.ok(!r.sent.some((m) => /DELIVERY FAILED/.test(String(m.subject || ''))), 'no failure alert on a delivery that worked');
});

test('BOTH CALLERS test the result for truthiness before reading it (source)', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const callers = [...src.matchAll(/const delivered = await deliverPaidReport\(/g)].map((m) => m.index);
  assert.equal(callers.length, 2, 'two callers');
  for (const at of callers) {
    const after = src.slice(at, at + 6000);
    const guard = after.search(/if \(!delivered[\s)&]/);
    const firstRead = after.search(/delivered\.subscriber/);
    assert.ok(guard > 0 && (firstRead < 0 || guard < firstRead), 'a caller reads delivered.subscriber before its guard');
  }
  assert.doesNotMatch(src, /return \{ delivered: false/, 'the truthy failure object is gone');
});

// ════════════════════════════════════════════════════════════════════════════
// THE EMAIL THAT DID NOT SEND IS NOT A DELIVERY EITHER (Simon, 2026-11-17).
// The row saved, but the send to the paying address failed (sendEmailViaResend
// returns { ok:false } and never throws). Until 8.11.65 the result was thrown
// away, so this returned the delivery: the recovery page said "Sent. Your
// report is on its way" and rvp_outcomes recorded delivered:true.
// ════════════════════════════════════════════════════════════════════════════
async function deliverWithResend({ failTo = [], alsoTo = null } = {}) {
  const sent = [];
  const fake = async (url, init) => {
    const u = String(url); const i = init || {};
    const method = String(i.method || 'GET').toUpperCase();
    let body = null; try { body = i.body ? JSON.parse(i.body) : null; } catch (_) { body = null; }
    if (u.startsWith('https://api.resend.com')) {
      const to = [].concat((body && body.to) || []);
      if (to.some((t) => failTo.includes(t))) {
        return { ok: false, status: 422, headers: { get: () => null }, json: async () => ({ message: 'refused by Resend' }), text: async () => '{"message":"refused by Resend"}' };
      }
      sent.push(body || {});
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'em_' + sent.length }), text: async () => '{"id":"em"}' };
    }
    const answer = u.startsWith('https://db.invalid/rest/v1/subscribers')
      ? (method === 'GET' ? [] : [{ id: 'row-1', report_token: (body && body.report_token) || 'tok' }])
      : u.startsWith('https://analytics.invalid') ? { ok: false } : {};
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  const restore = setFetch(fake);
  const realGlobal = globalThis.fetch; globalThis.fetch = fake;
  const logs = []; const realLog = console.log; const realWarn = console.warn; const realErr = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log;
  try {
    const result = await deliverPaidReport({ destEmail: 'owner@example.test', firstName: 'Ana',
      restaurant: 'Test Kitchen', location: 'London, UK', report: REPORT(),
      survey: { location: 'London, UK', website: '' }, product: 'full', planType: 'one_off',
      amountPaid: 24.99, source: 'test', swapUrl: null, alsoTo });
    await new Promise((r) => setTimeout(r, 700)); // the internal summary fires after 600 ms
    return { result, logs, sent };
  } finally { globalThis.fetch = realGlobal; restore(); console.log = realLog; console.warn = realWarn; console.error = realErr; }
}

test('THE EMAIL TO THE PAYING ADDRESS DID NOT SEND: null, and one unthrottled alert that says the row saved', async () => {
  const r = await deliverWithResend({ failTo: ['owner@example.test'] });
  assert.equal(r.result, null, 'a delivery whose email did not send must be falsy: got ' + JSON.stringify(r.result && Object.keys(r.result)));
  assert.ok(r.logs.some((l) => /^DELIVERY_FAILED \[deliver\] email not sent to .*: refused by Resend/.test(l)), 'the failed send is logged');
  const alerts = r.sent.filter((m) => /DELIVERY FAILED/.test(String(m.subject || '')));
  assert.equal(alerts.length, 1, 'one alert');
  assert.deepEqual([].concat(alerts[0].to), ['hello@4xiconsulting.com']);
  assert.match(alerts[0].html, /The order row saved, but the email with the report did not send/);
  assert.match(alerts[0].html, /why the email did not send: refused by Resend/);
  assert.match(alerts[0].html, /\/report\?token=/, 'the alert carries the report link so it can be sent by hand');
  assert.doesNotMatch(JSON.stringify(alerts), /owner@example\.test/, 'the full paying address is never in the alert');
});

test('THE SECOND COPY DID NOT SEND: the order is delivered, the second copy is alerted, and nothing says "both"', async () => {
  const r = await deliverWithResend({ alsoTo: 'survey@example.test', failTo: ['survey@example.test'] });
  assert.ok(r.result && r.result.subscriber, 'the paying address has it: delivered');
  assert.equal(r.result.alsoToSent, false);
  const alerts = r.sent.filter((m) => /DELIVERY PARTLY FAILED: a second copy was not sent/.test(String(m.subject || '')));
  assert.equal(alerts.length, 1, 'one alert for the second copy');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal((src.match(/is on its way to both addresses/g) || []).length, 0, 'no fixed "both addresses" claim remains');
  assert.match(src, /if \(delivered && delivered\.alsoToSent === true\) return ' to both addresses';/, '"both" only when the second copy went');
});

test('CONTROL: both sends work, the delivery says both, and no alert', async () => {
  const r = await deliverWithResend({ alsoTo: 'survey@example.test' });
  assert.ok(r.result && r.result.subscriber);
  assert.equal(r.result.alsoToSent, true);
  assert.ok(!r.sent.some((m) => /DELIVERY (PARTLY )?FAILED/.test(String(m.subject || ''))));
});
