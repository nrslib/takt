import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';

test('retains values explicitly set in the configuration file', () => {
  assert.deepEqual(loadConfig('{"timeoutMs":8000,"retries":0}'), {
    timeoutMs: 8000, retries: 0, region: 'ap-northeast-1',
  });
});

test('supplies defaults for omitted settings', () => {
  assert.deepEqual(loadConfig('{}'), { timeoutMs: 3000, retries: 2, region: 'ap-northeast-1' });
});

test('rejects malformed configuration files', () => {
  assert.throws(() => loadConfig('{'));
});
