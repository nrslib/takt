import assert from 'node:assert/strict';
import test from 'node:test';
import { exportReport } from '../src/export-report.js';

test('exports every item in input order', () => {
  const items = [
    { category: 'beta', label: 'second' },
    { category: 'alpha', label: 'first' },
  ];

  assert.equal(exportReport(items), 'beta: second\nalpha: first');
});
