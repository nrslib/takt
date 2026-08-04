import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceLabel } from '../src/core/resolve.js';

test('env and cli origins are labeled override', () => {
  assert.equal(sourceLabel('env', 'unknown'), 'override');
  assert.equal(sourceLabel('cli', 'unknown'), 'override');
});

test('local origin is labeled project', () => {
  assert.equal(sourceLabel('local', 'unknown'), 'project');
});

test('global origin is labeled global', () => {
  assert.equal(sourceLabel('global', 'unknown'), 'global');
});

test('an origin outside the known set throws', () => {
  assert.throws(() => sourceLabel('mystery', 'unknown'));
});
