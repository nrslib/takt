import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClient, readSetting } from '../src/cli-entry.js';

test('uses the configured value when one is provided', () => {
  assert.equal(readSetting('configured'), 'configured');
});

test('uses a stable fallback when no value is provided', () => {
  assert.equal(readSetting(undefined), 'default');
});

test('passes the resolved setting through the CLI to adapter boundary', () => {
  const calls = [];
  const client = buildClient('configured', request => {
    calls.push(request);
    return 'ok';
  });

  assert.equal(client.request('payload'), 'ok');
  assert.deepEqual(calls, [{ context: { setting: 'configured' }, input: 'payload' }]);
});
