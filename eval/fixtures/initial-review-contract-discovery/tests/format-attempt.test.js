import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAttempt } from '../src/format-attempt.js';

test('formats an attempt number for display', () => {
  assert.equal(formatAttempt(3), 'attempt:3');
});
