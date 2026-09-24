// ════════════════════════════════════════════════════════════════════════════
// THE SUBJECT'S OWN GOOGLE REVIEW DATA IS STORED AT INTAKE (overnight
// 2026-09-26, Item 3).
//
// RVP already reads the subject's user_ratings_total from its focal
// findplacefromtext call (fetchPlacesNearby) and, until now, wrote it only into
// report._debug, which a later read of the benchmark row cannot see. It goes on
// the benchmark row as subject_review_count. subject_newest_review_at is the
// second column; RVP fetches no review dates today (no Place Details call), so
// it is written only when a date is present and is null on every run now.
//
// NEVER A KNOWLEDGE-GRAPH COUNT. The Serper knowledge graph reported 4,552
// reviews for Zulu where Places reported 625 (2026-09-19). Only the Places
// figure is stored; with no Places figure the column is null.
//
// THE MIGRATION IS PRINTED, NOT RUN. Until it is applied the columns do not
// exist, and PostgREST rejects an insert naming an unknown column (PGRST204).
// That would lose every benchmark row, which Analytics verifies by id. So the
// writers retry ONCE without the new keys when, and only when, the rejection
// names one of them. Any other failure is not retried.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39467';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';
process.env.BENCHMARK_WRITE_ENABLED = 'true';

const { __test__ } = await import('../server.js');
const { buildBenchmarkRow, writeBenchmarkRow, writeOutcome, setFetch } = __test__;

const pillars = { cs: { score: 60 }, pa: { score: 60 }, es: { score: 60 }, sm: { score: 60 }, cp: { score: 60 }, bg: { score: 60 } };
const build = (extra) => buildBenchmarkRow(Object.assign({
  report: { pillars }, name: 'Teclados', location: 'Santiago, Chile', country: 'Chile', region: 'LATAM',
  focalContext: { reviewCount: 4552 }, focalGeo: null, focalPlaceId: 'ChIJ-test',
}, extra));

test('the row carries the subject\'s own Places review count', () => {
  const row = build({ focalReviewCount: 765 });
  assert.equal(row.subject_review_count, 765);
  assert.equal(row.subject_newest_review_at, null);
});

test('no Places count means null, never the knowledge-graph count', () => {
  for (const v of [null, undefined, '765', NaN, -1]) {
    assert.equal(build({ focalReviewCount: v }).subject_review_count, null, String(v));
  }
});

test('a newest review date is written only when one is present', () => {
  assert.equal(build({ focalReviewCount: 10, newestReviewAt: '2026-09-01T00:00:00Z' }).subject_newest_review_at, '2026-09-01T00:00:00.000Z');
  assert.equal(build({ focalReviewCount: 10, newestReviewAt: 'yesterday' }).subject_newest_review_at, null);
});

function scripted(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body || {}), json: async () => r.body || {} };
  };
  return { fn, calls };
}
const MISSING = (col, table) => ({ status: 400, body: { code: 'PGRST204', message: `Could not find the '${col}' column of '${table}' in the schema cache` } });

test('BEFORE THE MIGRATION: a benchmark insert rejected for a new column is retried once without the new keys', async () => {
  const s = scripted([MISSING('subject_review_count', 'benchmarks'), { status: 201 }]);
  const restore = setFetch(s.fn);
  try {
    const ok = await writeBenchmarkRow(build({ focalReviewCount: 765 }));
    assert.equal(ok, true);
    assert.equal(s.calls.length, 2);
    assert.ok('subject_review_count' in s.calls[0].body);
    assert.ok(!('subject_review_count' in s.calls[1].body) && !('subject_newest_review_at' in s.calls[1].body));
    assert.equal(s.calls[1].body.id, s.calls[0].body.id, 'the same id, so Analytics can still verify it');
  } finally { restore(); }
});

test('CONTROL: any other rejection is not retried', async () => {
  const s = scripted([{ status: 400, body: { code: '23502', message: 'null value in column "overall_score"' } }, { status: 201 }]);
  const restore = setFetch(s.fn);
  try {
    assert.equal(await writeBenchmarkRow(build({ focalReviewCount: 765 })), false);
    assert.equal(s.calls.length, 1);
  } finally { restore(); }
});

test('AFTER THE MIGRATION: one insert, the new keys kept', async () => {
  const s = scripted([{ status: 201 }]);
  const restore = setFetch(s.fn);
  try {
    assert.equal(await writeBenchmarkRow(build({ focalReviewCount: 765 })), true);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].body.subject_review_count, 765);
  } finally { restore(); }
});

test('the outcome writer tolerates the missing gate columns the same way', async () => {
  const s = scripted([MISSING('coverage_verdict', 'rvp_outcomes'), { status: 201 }]);
  const restore = setFetch(s.fn);
  try {
    const ok = await writeOutcome({ kind: 'coverage', decision: 'refused', reason: 'subject-reviews-below-minimum 12 < 50',
      coverage_verdict: 'refused-coverage', place_id: 'ChIJ-test', place_confirmed: true,
      subject_review_count: 12, subject_newest_review_at: null });
    assert.equal(ok, true);
    assert.equal(s.calls.length, 2);
    assert.deepEqual(Object.keys(s.calls[1].body).sort(), ['decision', 'kind', 'reason']);
  } finally { restore(); }
});
