import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReport } from '../src/report.mjs';
test('report formats entries', () => {
  assert.equal(formatReport([{ id: 'a', name: 'One' }]), 'One');
});
