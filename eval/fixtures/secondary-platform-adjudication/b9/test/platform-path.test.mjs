import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionEndpoint } from '../src/platform-path.mjs';

test('existing session endpoint supports Windows', () => {
  assert.equal(sessionEndpoint('win32'), String.raw`\\.\pipe\workspace-session`);
});
