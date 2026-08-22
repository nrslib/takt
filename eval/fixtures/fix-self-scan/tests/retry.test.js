import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRetries } from '../src/core/retry.js';

test('plans linear backoff delays', () => {
  assert.deepEqual(planRetries(3, 100), [100, 200, 300]);
});

test('zero attempts yields an empty plan', () => {
  assert.deepEqual(planRetries(0, 100), []);
});

test('negative attempts are rejected', () => {
  assert.throws(() => planRetries(-1, 100));
});
