import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCliOverride } from '../src/app/override.js';

const config = { provider: 'alpha', model: 'alpha-large' };

test('no override passes the config through', () => {
  assert.deepEqual(applyCliOverride(config, {}), { provider: 'alpha', model: 'alpha-large' });
});

test('switching provider discards the configured model', () => {
  assert.deepEqual(applyCliOverride(config, { provider: 'beta' }), { provider: 'beta', model: undefined });
});

test('model-only override keeps the configured provider', () => {
  assert.deepEqual(applyCliOverride(config, { model: 'alpha-mini' }), { provider: 'alpha', model: 'alpha-mini' });
});

test('blank flag values count as absent', () => {
  assert.deepEqual(applyCliOverride(config, { provider: '  ' }), { provider: 'alpha', model: 'alpha-large' });
});
