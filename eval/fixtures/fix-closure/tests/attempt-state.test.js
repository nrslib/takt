import test from 'node:test';
import assert from 'node:assert/strict';
import { finishAttempt } from '../src/attempt-state.js';

test('successful completion clears the pending attempt', () => {
  const state = {
    pending: { provider: 'secondary', stepIteration: 3 },
    attempts: ['primary', 'secondary'],
  };

  assert.deepEqual(finishAttempt(state, { status: 'success' }), {
    pending: undefined,
    attempts: ['primary', 'secondary'],
  });
});
