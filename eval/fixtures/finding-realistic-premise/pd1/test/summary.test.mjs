import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from '../src/summary.mjs';
test('total includes every amount', () => {
  assert.deepEqual(summarize([{ amount: 10 }, { amount: 20 }]), { count: 2, total: 30 });
});
