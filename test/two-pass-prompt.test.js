// ════════════════════════════════════════════════════════════════════════════
// THE MODEL IS NOT ASKED FOR THE SCORE, THE VERDICT OR THE SUMMARY.
//
// diagnose-p1 returned healthCheckScore, scoreVerdict, executiveSummary AND
// the six pillars in ONE JSON object. The summary was therefore written to
// agree with a number the application now computes and discards, which is why
// 66 of 105 stored summaries name a band other than the computed one.
//
// PASS 1 produces pillars and supporting narrative. The score and the band are
// computed in process, by lib-score.js, with no model involved. PASS 2 writes
// the summary WITH THE COMPUTED BAND IN ITS INPUT.
//
// This file pins the PROMPT, which is a string in server.js, by reading the
// file. That is a weaker test than driving the model and is the only kind
// available without spending: what the model DOES with the prompt is answered
// by the live test, not here.
//
// Run with: npm test
// ════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'server.js'), 'utf8');

// The p1 prompt only. Scoped so a hit in p2 or in a comment cannot pass for a
// hit in the schema being pinned.
const P1 = (() => {
  const end = SRC.indexOf("label: 'diagnose-p1'");
  const start = SRC.lastIndexOf('claude(`', end);
  return SRC.slice(start, end);
})();

test('CONTROL: the p1 prompt was found and is a prompt', () => {
  assert.ok(P1.length > 2000, 'the slice is ' + P1.length + ' chars, too short to be the prompt');
  assert.match(P1, /"pillars"/);
  assert.match(P1, /Customer Sentiment/);
});

test('P1 DOES NOT ASK FOR healthCheckScore', () => {
  assert.doesNotMatch(P1, /"healthCheckScore"/);
});

test('P1 DOES NOT ASK FOR scoreVerdict', () => {
  assert.doesNotMatch(P1, /"scoreVerdict"/);
  assert.doesNotMatch(P1, /scoreVerdict=Excellent/);
});

test('P1 DOES NOT ASK FOR executiveSummary', () => {
  assert.doesNotMatch(P1, /"executiveSummary"/);
});

test('and it says plainly that the overall is computed elsewhere', () => {
  assert.match(P1, /COMPUTED from the six pillar scores/i);
  assert.match(P1, /DO NOT return an overall score/i);
});

test('P1 STILL ASKS FOR ALL SIX PILLARS', () => {
  // The change must not have removed what pass 1 is for.
  for (const k of ['"cs"', '"pa"', '"es"', '"sm"', '"cp"', '"bg"']) {
    assert.ok(P1.includes(k), 'the pillar ' + k + ' is no longer requested');
  }
});

test('and it still asks for the fields pass 2 needs as input', () => {
  assert.match(P1, /ownerSentimentSummary/);
  assert.match(P1, /onlinePresence/);
});

test('the dash rule no longer enumerates a field that is gone', () => {
  assert.doesNotMatch(P1, /the executive summary, pillar labels/);
  assert.match(P1, /never use an em-dash/);
});

test('CONTROL: the three removed names are still findable ELSEWHERE in the file', () => {
  // If they had vanished from server.js entirely the assertions above would
  // pass because the renderer had been broken, not because the prompt changed.
  assert.ok(SRC.includes('healthCheckScore'), 'healthCheckScore is gone from the whole file');
  assert.ok(SRC.includes('executiveSummary'), 'executiveSummary is gone from the whole file');
});

test('CONTROL: the p1 slice really excludes p2', () => {
  assert.ok(!P1.includes('commercialActions'), 'the slice has swallowed the p2 prompt');
});
