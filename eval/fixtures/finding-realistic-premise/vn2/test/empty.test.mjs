import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from '../src/summary.mjs';
test('empty data has zero count and total', () => {
  assert.deepEqual(summarize([]), { count: 0, total: 0 });
});
