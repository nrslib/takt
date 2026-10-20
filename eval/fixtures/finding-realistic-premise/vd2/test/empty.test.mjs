import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from '../src/summary.mjs';
test('empty catalog has no labels', () => {
  assert.deepEqual(summarize([]), { count: 0, labels: [] });
});
