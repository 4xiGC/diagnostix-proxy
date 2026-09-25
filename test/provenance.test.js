// ════════════════════════════════════════════════════════════════════════════
// EVERY RUN SHOWS ITS WORKING (2026-09-30, B5; Simon Q27).
//
// A5 (RVP) found each run stores the product version, the elapsed time
// (_debug.totalMs) and, on the benchmark row, the overall method, and nothing
// about which models wrote it, with which prompt, at what cost, or how sure
// the product is. Now every /diagnose report carries `provenance`:
//   methodVersion     rvp-overall-mean-v2
//   passes[]          one per model pass: label, model, prompt version,
//                     input and output tokens (as the API returns them), ms
//   promptVersions    { 'diagnose-p1': ..., 'diagnose-p2': ..., 'diagnose-summary': ... }
//   confidence        { level, basis } from the coverage state (RVP has no
//                     model-rated confidence; the definition is Simon's to approve)
//   durationMs        the request's own wait
//   writtenAt         when the provenance was built
// The benchmark row carries the same object in a nullable `provenance` column;
// a database without the column is logged and written without it, so the push
// and the migration can happen in either order.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildProvenance, rvpConfidence, PROMPT_VERSIONS, missingProvenance } from '../lib-provenance.js';

const PASSES = [
  { label: 'diagnose-p1', model: 'claude-sonnet-4-5-20250929', input: 3100, output: 920, ms: 20700 },
  { label: 'diagnose-p2', model: 'claude-haiku-4-5-20251001', input: 4500, output: 1932, ms: 18000 },
  { label: 'diagnose-summary', model: 'claude-sonnet-4-5-20250929', input: 900, output: 122, ms: 4000 },
];

test('THE PROVENANCE NAMES THE METHOD, EVERY PASS WITH ITS MODEL, PROMPT AND TOKENS, THE CONFIDENCE AND THE WAIT', () => {
  const p = buildProvenance({ passes: PASSES, coverage: { state: 'pass', subjectReviewCount: 648 }, durationMs: 39000, now: () => '2026-09-30T00:00:00.000Z' });
  assert.equal(p.methodVersion, 'rvp-overall-mean-v2');
  assert.equal(p.passes.length, 3);
  assert.deepEqual(p.passes[0], { label: 'diagnose-p1', model: 'claude-sonnet-4-5-20250929', promptVersion: PROMPT_VERSIONS['diagnose-p1'], inputTokens: 3100, outputTokens: 920, ms: 20700 });
  assert.deepEqual(Object.keys(p.promptVersions).sort(), ['diagnose-p1', 'diagnose-p2', 'diagnose-summary']);
  assert.deepEqual(p.confidence, { level: 'standard', basis: 'coverage pass: 648 Google reviews, the rule met' });
  assert.equal(p.durationMs, 39000);
  assert.equal(p.writtenAt, '2026-09-30T00:00:00.000Z');
  assert.deepEqual(missingProvenance(p), []);
});

test('two calls under one label (a parse retry) are summed, and counted', () => {
  const p = buildProvenance({ passes: [PASSES[0], { ...PASSES[0], input: 3200, output: 400, ms: 9000 }], coverage: null, durationMs: 1 });
  assert.equal(p.passes.length, 1);
  assert.equal(p.passes[0].inputTokens, 6300);
  assert.equal(p.passes[0].outputTokens, 1320);
  assert.equal(p.passes[0].calls, 2);
});

test('CONFIDENCE comes from the coverage state, and says so', () => {
  assert.deepEqual(rvpConfidence({ state: 'limited', subjectReviewCount: 120 }), { level: 'limited', basis: 'coverage limited: 120 Google reviews, below the rule for a full reading' });
  assert.deepEqual(rvpConfidence(null), { level: 'not assessed', basis: 'no coverage reading (an Analytics peer run, or no confirmed place)' });
});

test('token counts the API did not return are null, never zero', () => {
  const p = buildProvenance({ passes: [{ label: 'diagnose-p1', model: 'm', ms: 5 }], coverage: null, durationMs: 5 });
  assert.equal(p.passes[0].inputTokens, null);
  assert.ok(missingProvenance(p).includes('tokens:diagnose-p1'));
});

// The missing-column tolerance is server.js insertTolerant (BENCHMARK_UNMIGRATED_KEYS),
// tested through the real /diagnose route in provenance-route.test.js.

// PROMPT VERSIONS ARE DATED IDS, PINNED TO THE PROMPT TEXT. A change to a
// prompt without a new id fails here: the hash of the prompt's source text is
// pinned beside its id.
const SRC = readFileSync(new URL('../server.js', import.meta.url), 'utf8').split('\r\n').join('\n');
function promptSource(label) {
  const i = SRC.indexOf("{ label: '" + label + "'");
  assert.ok(i > 0, 'the ' + label + ' call was not found');
  const start = SRC.lastIndexOf('claude(`', i);
  return SRC.slice(start, i);
}
const PINNED = {
  'diagnose-p1': PROMPT_VERSIONS['diagnose-p1'],
  'diagnose-p2': PROMPT_VERSIONS['diagnose-p2'],
};
test('THE PROMPT VERSION CHANGES WHEN THE PROMPT DOES (p1, p2)', () => {
  for (const label of Object.keys(PINNED)) {
    const h = createHash('sha256').update(promptSource(label)).digest('hex').slice(0, 12);
    assert.ok(PINNED[label].endsWith(h), label + ': the prompt text changed (hash ' + h + ') but PROMPT_VERSIONS still says ' + PINNED[label]);
  }
});

test('CONTROL: the prompt hash moves when one character of the prompt moves', () => {
  const a = createHash('sha256').update(promptSource('diagnose-p1')).digest('hex').slice(0, 12);
  const b = createHash('sha256').update(promptSource('diagnose-p1') + ' ').digest('hex').slice(0, 12);
  assert.notEqual(a, b);
});

// Simon, 2026-09-30: pass is standard, limited is limited, refused is not
// assessed. PINS EXISTING BEHAVIOUR (rvpConfidence, 7ed6a31), so it was green
// on its first run. The state names are the ones lib-review-gate.js writes.
test('SIMON\'S CONFIDENCE MAPPING, on the state names the review gate writes', async () => {
  const { reviewGate } = await import('../lib-review-gate.js');
  // The gate's own output, fed straight to the mapping: a refused count.
  const refused = reviewGate({ subjectReviewCount: 10 });
  assert.equal(refused.state, 'refused-coverage', 'the review gate no longer writes refused-coverage');
  assert.equal(rvpConfidence(refused).level, 'not assessed');
  assert.equal(rvpConfidence({ state: 'pass', subjectReviewCount: 900 }).level, 'standard');
  assert.equal(rvpConfidence({ state: 'limited', subjectReviewCount: 120 }).level, 'limited');
  assert.equal(rvpConfidence({ state: 'refused-coverage', subjectReviewCount: 10 }).level, 'not assessed');
  assert.match(rvpConfidence({ state: 'refused-coverage', subjectReviewCount: 10 }).basis, /refused-coverage/);
});
