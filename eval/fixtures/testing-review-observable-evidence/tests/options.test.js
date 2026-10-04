import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOptions } from '../src/options.js';

test('resolves optional execution settings', () => {
  assert.deepEqual(resolveOptions({ traceLabel: '  release  ', timeoutMs: 2500 }), {
    traceLabel: 'release',
    timeoutMs: 2500,
  });
});
