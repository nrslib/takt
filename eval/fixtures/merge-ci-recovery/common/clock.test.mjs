import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from './clock.mjs';
test('retains entries before TTL and expires at TTL', async () => {
  const cache = createCache();
  cache.put('key', 'value');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cache.get('key'), 'value');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cache.get('key'), undefined);
});
