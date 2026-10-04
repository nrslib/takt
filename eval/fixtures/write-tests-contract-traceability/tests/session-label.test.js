import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSessionLabel } from '../src/session-label.js';

test('preserves a label without surrounding whitespace', () => {
  assert.equal(normalizeSessionLabel('ready'), 'ready');
});
