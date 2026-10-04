import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderName, validateModelName } from '../src/core/validate.js';

test('a plain provider name is accepted', () => {
  assert.deepEqual(validateProviderName('alpha'), { ok: true });
});

test('a non-string provider is rejected', () => {
  assert.equal(validateProviderName(42).ok, false);
});

test('an empty model string is rejected', () => {
  assert.equal(validateModelName('').ok, false);
});

test('an absent model is accepted', () => {
  assert.deepEqual(validateModelName(undefined), { ok: true });
});
