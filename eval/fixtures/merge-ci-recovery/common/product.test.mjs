import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTag } from './product.mjs';
test('normalizes tags and accepts missing optional tags', () => {
  assert.equal(normalizeTag(' TAG '), 'tag');
  assert.equal(normalizeTag(null), '');
});
