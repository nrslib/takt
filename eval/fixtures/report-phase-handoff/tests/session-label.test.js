import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSessionLabel } from '../src/session-label.js';

test('surrounding whitespace is removed', () => {
  const input = '  Ready Now  ';
  const actual = normalizeSessionLabel(input);
  assert.equal(actual, 'Ready Now');
  console.log(JSON.stringify({ test: 'surrounding whitespace', input, actual }));
});

test('letter case and internal whitespace are preserved', () => {
  const input = 'Ready  Now';
  const actual = normalizeSessionLabel(input);
  assert.equal(actual, 'Ready  Now');
  console.log(JSON.stringify({ test: 'case and internal whitespace', input, actual }));
});
