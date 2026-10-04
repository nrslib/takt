import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeProvider } from '../src/provider.js';

test('uses the requested timeout', () => {
  assert.equal(invokeProvider({ timeoutMs: 2500 }).timeoutMs, 2500);
});

test('keeps the default timeout when none is requested', () => {
  assert.equal(invokeProvider({}).timeoutMs, 1000);
});
