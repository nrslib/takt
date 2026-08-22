import assert from 'node:assert/strict';
import test from 'node:test';
import { hasFinalDecision } from './final-readiness-decision.mjs';

test('accepts the existing Markdown heading format', () => {
  assert.equal(hasFinalDecision('## Final Decision: APPROVE', 'APPROVE'), true);
});

test('accepts a headingless English decision', () => {
  assert.equal(hasFinalDecision('Final Decision is BLOCKED', 'BLOCKED'), true);
});

test('accepts a headingless Japanese decision', () => {
  assert.equal(hasFinalDecision('最終判定は REJECT', 'REJECT'), true);
});

test('accepts a Markdown table decision', () => {
  assert.equal(hasFinalDecision('| Final Decision | **BLOCKED** |', 'BLOCKED'), true);
});

test('does not treat a prose mention as the final decision', () => {
  assert.equal(hasFinalDecision('The final decision is BLOCKED only if approval remains pending.', 'BLOCKED'), false);
});

test('does not accept a bare decision without a decision label', () => {
  assert.equal(hasFinalDecision('BLOCKED', 'BLOCKED'), false);
});
