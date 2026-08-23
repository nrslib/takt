import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMode } from '../src/mode.js';

test('normalizes supported mode values', () => {
  assert.equal(normalizeMode('LOCAL'), 'local');
  assert.equal(normalizeMode(' cloud '), 'cloud');
});

test('rejects unsupported mode values', () => {
  assert.throws(() => normalizeMode('remote'), /Unsupported mode/);
  assert.throws(() => normalizeMode(''), /Unsupported mode/);
});
