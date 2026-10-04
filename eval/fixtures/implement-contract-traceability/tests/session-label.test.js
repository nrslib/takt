import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSessionLabel } from '../src/session-label.js';

test('normalizes whitespace-only input to an empty string', () => {
  assert.equal(normalizeSessionLabel(' \t '), '');
});

test('trims surrounding whitespace', () => {
  assert.equal(normalizeSessionLabel('  Ready Now  '), 'Ready Now');
});

test('preserves letter case and internal whitespace', () => {
  assert.equal(normalizeSessionLabel('Ready  Now'), 'Ready  Now');
});

test('rejects non-string input with a TypeError', () => {
  assert.throws(() => normalizeSessionLabel(null), TypeError);
});
