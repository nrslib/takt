import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from '../src/summary.mjs';
test('labels are sorted and counted', () => {
  assert.deepEqual(summarize([{ label: 'z' }, { label: 'a' }]), { count: 2, labels: ['a', 'z'] });
});
