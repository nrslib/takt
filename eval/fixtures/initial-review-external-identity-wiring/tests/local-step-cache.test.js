import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalStepCache } from '../src/local-step-cache.js';

test('uses a bare step name inside one workflow-local cache', () => {
  const cache = createLocalStepCache();
  const step = { name: 'execute' };

  cache.put(step, 'cached result');

  assert.equal(cache.get(step), 'cached result');
});
