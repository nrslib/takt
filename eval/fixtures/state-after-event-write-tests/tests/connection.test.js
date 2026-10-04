import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from '../src/connection.js';

test('reports the initial connection status', () => {
  const connection = createConnection('offline');
  assert.equal(connection.readStatus(), 'offline');
});
