import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceName as previousName } from '../src/path-name.previous.mjs';
import { workspaceName as currentName } from '../src/path-name.mjs';

test('current change breaks a previously supported Windows path', () => {
  const input = String.raw`C:\projects\workspace`;
  assert.equal(previousName(input), 'workspace');
  assert.notEqual(currentName(input), 'workspace');
});
