import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLabel } from '../src/label.js';

test('label trims surrounding whitespace and preserves inner text', () => {
  assert.equal(formatLabel('  Alpha  Beta \n'), 'Alpha  Beta');
  assert.equal(formatLabel('  '), '');
  assert.throws(() => formatLabel(null), TypeError);
});
