import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../src/application.js';

test('forwards a normalized trace label', () => {
  assert.equal(execute({ traceLabel: '  release  ' }).traceLabel, 'release');
});

test('keeps the trace label absent when none is requested', () => {
  assert.equal(execute({}).traceLabel, null);
});
