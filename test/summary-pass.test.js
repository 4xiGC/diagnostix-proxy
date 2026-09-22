// ════════════════════════════════════════════════════════════════════════════
// PASS 2: THE SUMMARY IS WRITTEN AGAINST THE COMPUTED BAND, AND GATED.
//
// A model asked for a score and a summary in one object writes the summary to
// agree with the score it just wrote. That is how 66 of the 105 stored
// summaries came to name a band other than the computed one, skewed 4.2 to 1
// toward the higher one. The band has to exist BEFORE the sentence is written.
//
// The gate blocks delivery with ONE retry and then gives up. Band words are
// ordinary English and 92 of 103 stored summaries contain one, so a gate that
// retried until clean would never deliver. LOSING THREE SENTENCES IS BETTER
// THAN LOSING THE REPORT, and far better than shipping a cover that says Fair
// above a paragraph that says strong.
//
// The model call is replaced through the seam, so this costs nothing.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '39371';
process.env.RVP_IMPORT_ONLY = '1';
process.env.SUPABASE_URL = 'https://db.invalid';
process.env.SUPABASE_KEY = 'not-a-key';

const { __test__ } = await import('../server.js');
const { writeExecutiveSummary, setClaude } = __test__;

// Records every prompt and answers with whatever the test queued.
function model(answers) {
  const prompts = [];
  const queue = answers.slice();
  const fn = async (prompt) => {
    prompts.push(String(prompt));
    const next = queue.length ? queue.shift() : '';
    if (next instanceof Error) throw next;
    return { executiveSummary: next };
  };
  return { fn, prompts, calls: () => prompts.length };
}

async function withModel(m, fn) {
  const restore = setClaude(m.fn);
  try { return await fn(); } finally { restore(); }
}

const REPORT = {
  pillars: {
    cs: { score: 66, label: 'Customer Sentiment' }, pa: { score: 70, label: 'Pricing' },
    es: { score: 42, label: 'Employee' }, sm: { score: 48, label: 'Social' },
    cp: { score: 58, label: 'Competitive' }, bg: { score: 72, label: 'Brand' },
  },
  strengths: ['Strong kitchen', 'Loyal regulars'],
  risks: ['Thin staffing', 'Weak social presence'],
};
const ARGS = (over) => ({ name: 'Teclados', location: 'Santiago',
  report: REPORT, score: 59, band: 'Fair', ...over });

// ── The prompt ────────────────────────────────────────────────────────────

test('THE PROMPT CARRIES THE COMPUTED SCORE AND THE BAND', async () => {
  const m = model(['A clean summary naming nothing in particular.']);
  await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.match(m.prompts[0], /59/);
  assert.match(m.prompts[0], /"Fair"/);
  assert.match(m.prompts[0], /mean of the six pillar scores/i);
});

test('and it carries the six pillar scores', async () => {
  const m = model(['Clean.']);
  await withModel(m, () => writeExecutiveSummary(ARGS()));
  for (const n of [66, 70, 42, 48, 58, 72]) {
    assert.ok(m.prompts[0].includes(String(n)), 'the pillar ' + n + ' is not in the prompt');
  }
});

test('IT IS NOT GIVEN THE CORPUS', async () => {
  // Pass 1 read the corpus. Handing it back here invites the model to
  // re-derive a view of the business and argue with the numbers.
  const m = model(['Clean.']);
  await withModel(m, () => writeExecutiveSummary({
    ...ARGS(), report: { ...REPORT, webData: 'A VERY LONG CORPUS STRING' } }));
  assert.doesNotMatch(m.prompts[0], /A VERY LONG CORPUS STRING/);
});

test('it carries the strengths and risks pass 1 found', async () => {
  const m = model(['Clean.']);
  await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.match(m.prompts[0], /Strong kitchen/);
  assert.match(m.prompts[0], /Thin staffing/);
});

test('and it carries the house-style rule', async () => {
  const m = model(['Clean.']);
  await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.match(m.prompts[0], /never use an em-dash/i);
});

// ── The gate ──────────────────────────────────────────────────────────────

test('A CLEAN SUMMARY IS ACCEPTED ON THE FIRST CALL', async () => {
  const m = model(['The kitchen is consistent and the regulars are loyal, but staffing is thin.']);
  const out = await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.equal(m.calls(), 1, 'it retried a clean summary');
  assert.match(out.reason, /accepted-attempt-1/);
  assert.ok(out.text.length > 10);
});

test('A CONTRADICTING SUMMARY TRIGGERS EXACTLY ONE RETRY', async () => {
  const m = model([
    'This is a strong operation with an excellent kitchen.',   // contradicts Fair
    'The kitchen is consistent; staffing is thin.',            // clean
  ]);
  const out = await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.equal(m.calls(), 2, 'it made ' + m.calls() + ' calls');
  assert.match(out.reason, /accepted-attempt-2/);
});

test('and the retry QUOTES THE OFFENDING WORDS back to the model', async () => {
  const m = model(['A strong operation.', 'Clean.']);
  await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.match(m.prompts[1], /"strong"/);
  assert.match(m.prompts[1], /Fair/);
});

test('A SECOND CONTRADICTION OMITS THE SUMMARY RATHER THAN SHIPPING IT', async () => {
  const m = model(['A strong operation.', 'Still an excellent one.']);
  const out = await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.equal(m.calls(), 2, 'it kept retrying');
  assert.equal(out.text, '', 'it shipped a contradiction');
  assert.equal(out.reason, 'gate-failed-twice');
});

test('a model that throws does not take the report down', async () => {
  const m = model([new Error('upstream 529')]);
  const out = await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.equal(out.text, '');
  assert.ok(out.reason);
});

test('NO BAND MEANS NO CALL AT ALL', async () => {
  // An incomplete payload has no computed score, so there is no band to write
  // against and nothing to contradict. Spending a call would be inventing one.
  const m = model(['Should never be used.']);
  const out = await withModel(m, () => writeExecutiveSummary({ ...ARGS(), score: null, band: null }));
  assert.equal(m.calls(), 0, 'it called the model with no band');
  assert.equal(out.reason, 'no-band');
});

// ── Controls ──────────────────────────────────────────────────────────────

test('CONTROL: the fake model is really being called', async () => {
  const m = model(['Clean.']);
  await withModel(m, () => writeExecutiveSummary(ARGS()));
  assert.equal(m.calls(), 1);
  assert.ok(m.prompts[0].length > 200);
});

test('CONTROL: and is restored afterwards', async () => {
  const m = model(['Clean.']);
  await withModel(m, () => writeExecutiveSummary(ARGS()));
  const before = m.calls();
  // Outside withModel the fake must not be reached. The real claude will throw
  // on a missing key, which is the point: it is not the fake.
  await writeExecutiveSummary(ARGS()).catch(() => {});
  assert.equal(m.calls(), before, 'the fake model is still installed');
});

test('CONTROL: the gate can return BOTH answers on the same band', async () => {
  const clean = model(['The kitchen is consistent.']);
  const dirty = model(['An excellent kitchen.', 'An excellent kitchen.']);
  const a = await withModel(clean, () => writeExecutiveSummary(ARGS()));
  const b = await withModel(dirty, () => writeExecutiveSummary(ARGS()));
  assert.notEqual(a.reason, b.reason);
  assert.ok(a.text);
  assert.equal(b.text, '');
});
