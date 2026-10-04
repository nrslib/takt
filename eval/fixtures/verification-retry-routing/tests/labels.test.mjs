import assert from 'node:assert/strict';
import test from 'node:test';
import { labelsForDisplay } from '../src/labels.mjs';

test('trims and sorts labels', () => {
  assert.deepEqual(labelsForDisplay([' blue ', 'amber']), ['amber', 'blue']);
});
