// ════════════════════════════════════════════════════════════════════════════
// EXTERNAL CALLS: A TIMEOUT, ONE RETRY, A LOGGED REASON, AN ALERT (2026-09-30, B2)
//
// C4 (2026-09-28) found every Places and Serper call in RVP without a timeout:
// a hung socket held the buyer on the thinking screen, and a failure became an
// empty result nobody was told about ("EXHAUSTED", built on 'no data').
//
// fetchExternal: at most TWO attempts. An attempt that times out (15 s by
// default), fails on the network, or answers 5xx is retried ONCE; a 4xx or a
// 2xx is returned as it is (the caller's existing no-match or thin path reads
// it). After the second failure it throws an Error whose `reason` is timeout,
// network or http-5xx, and the caller takes its existing empty path with that
// reason logged.
//
// createFailureAlerter: one internal alert per service per window (10 min), so
// an outage that fails nine searches in one run sends one email, not nine,
// and a failure is never silent. Pure apart from the injected fetch and send.
// ════════════════════════════════════════════════════════════════════════════

export const EXTERNAL_TIMEOUT_MS_DEFAULT = 15000;

function timeoutMs() {
  const v = Number(process.env.RVP_EXTERNAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : EXTERNAL_TIMEOUT_MS_DEFAULT;
}

async function attempt(url, init, fetchFn, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchFn(url, Object.assign({}, init || {}, { signal: ctl.signal }));
    if (res && res.status >= 500) { const e = new Error('http ' + res.status); e.reason = 'http-' + res.status; e.retryable = true; throw e; }
    return res;
  } catch (e) {
    if (e && e.reason) throw e;
    const err = new Error(ctl.signal.aborted ? 'timed out after ' + ms + ' ms' : 'network: ' + (e && e.message));
    err.reason = ctl.signal.aborted ? 'timeout' : 'network';
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchExternal(url, init, opts) {
  const { fetchFn, service = 'external', label = service } = opts || {};
  const ms = timeoutMs();
  let last = null;
  for (let n = 1; n <= 2; n++) {
    try {
      return await attempt(url, init, fetchFn, ms);
    } catch (e) {
      last = e;
      console.log('[' + service + '] ' + label + ' attempt ' + n + ' failed: ' + e.reason + (n === 1 ? ', retrying once' : ', giving up'));
    }
  }
  const err = new Error(service + ' ' + label + ' failed twice: ' + last.reason);
  err.reason = last.reason;
  err.service = service;
  throw err;
}

export function createFailureAlerter({ send, windowMs = 10 * 60 * 1000, now = () => Date.now() }) {
  const lastSent = new Map();
  return async function alertFailure({ service, label, reason }) {
    console.log('EXTERNAL_FAILED [' + service + '] ' + label + ' reason=' + reason);
    const t = now();
    const was = lastSent.get(service);
    if (was !== undefined && t - was < windowMs) return false;
    lastSent.set(service, t);
    try { await send({ service, label, reason }); } catch (e) { console.log('[' + service + '] failure alert not sent: ' + (e && e.message)); }
    return true;
  };
}
