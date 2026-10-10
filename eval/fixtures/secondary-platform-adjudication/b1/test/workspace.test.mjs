import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWorkspace } from '../src/workspace.mjs';

test('existing Windows connection does not enter the new secret-file path', () => {
  let endpoint;
  const connection = { connected: true };
  const result = openWorkspace('demo', {
    platform: 'win32',
    connect: (value) => {
      endpoint = value;
      return connection;
    },
  });
  assert.equal(endpoint, String.raw`\\.\pipe\workspace-session`);
  assert.equal(result, connection);
});
