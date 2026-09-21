// ════════════════════════════════════════════════════════════════════════════
// A COUNTING STAND-IN FOR THE DATABASE (v8.11.47)
//
// WHY THIS EXISTS. Before it, RVP had NO SEAM THROUGH WHICH A WRITE COULD BE
// OBSERVED. Every test in this repo is a pure function test; not one injects a
// fetch, so no test had ever seen a row written. That is why "one sale, one
// row" could be stated in a report and never asserted anywhere.
//
// It speaks enough PostgREST to count: it reads the table out of the URL, the
// verb out of the options, and records what was sent. It answers the way the
// real endpoint answers, including `Prefer: return=representation`.
//
// IT IS NOT A DATABASE. It does not enforce a unique index, a foreign key, a
// check constraint or RLS. A test that needs any of those is testing the
// database, and this cannot stand in for it. It answers exactly one question
// honestly: HOW MANY WRITES OF WHAT SHAPE DID THIS CODE PATH MAKE.
//
// Nothing here runs in production. It is imported by tests only.
// ════════════════════════════════════════════════════════════════════════════

function tableOf(url) {
  const m = String(url).match(/\/rest\/v1\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function parseBody(opts) {
  if (!opts || opts.body === undefined || opts.body === null) return null;
  if (typeof opts.body !== 'string') return opts.body;
  try { return JSON.parse(opts.body); } catch (_) { return opts.body; }
}

export function countingSupabase(options) {
  const o = options || {};
  const state = {};          // table -> { inserts, patches, deletes, selects, rows }
  const calls = [];

  const bucket = (t) => {
    if (!state[t]) state[t] = { inserts: 0, patches: 0, deletes: 0, selects: 0, rows: [] };
    return state[t];
  };

  async function fetchImpl(url, opts) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const table = tableOf(url);
    const body = parseBody(opts);
    calls.push({ url: String(url), method, table, body });

    if (!table) {
      return { ok: false, status: 404, text: async () => 'no table in url', json: async () => ({}) };
    }
    const b = bucket(table);

    // A failure the caller asked for, so an error path can be exercised.
    const forced = o.failOn && o.failOn(table, method, body);
    if (forced) {
      return { ok: false, status: forced.status || 500,
        text: async () => forced.body || 'forced failure',
        json: async () => { try { return JSON.parse(forced.body); } catch (_) { return {}; } } };
    }

    if (method === 'POST') {
      b.inserts += 1;
      const added = Array.isArray(body) ? body : [body];
      for (const r of added) b.rows.push(r);
      const prefer = String((opts && opts.headers && (opts.headers.Prefer || opts.headers.prefer)) || '');
      const payload = prefer.includes('return=representation') ? added : [];
      return { ok: true, status: 201,
        text: async () => JSON.stringify(payload), json: async () => payload };
    }
    if (method === 'PATCH') {
      b.patches += 1;
      return { ok: true, status: 204, text: async () => '[]', json: async () => [] };
    }
    if (method === 'DELETE') {
      b.deletes += 1;
      return { ok: true, status: 204, text: async () => '', json: async () => [] };
    }
    b.selects += 1;
    const rows = o.select ? (o.select(table, String(url)) || []) : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows };
  }

  return {
    fetch: fetchImpl,
    calls,
    inserts: (t) => (state[t] ? state[t].inserts : 0),
    patches: (t) => (state[t] ? state[t].patches : 0),
    deletes: (t) => (state[t] ? state[t].deletes : 0),
    selects: (t) => (state[t] ? state[t].selects : 0),
    rows: (t) => (state[t] ? state[t].rows.slice() : []),
    tables: () => Object.keys(state),
  };
}
