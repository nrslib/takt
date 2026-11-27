import assert from 'node:assert/strict';
import test from 'node:test';
import { canReserve } from '../src/inventory.mjs';
import { markTestExecution } from '../test-execution.mjs';

markTestExecution();

test('available stock includes the exact boundary', () => {
  assert.equal(canReserve(3, 3), true);
  assert.equal(canReserve(2, 3), false);
});
