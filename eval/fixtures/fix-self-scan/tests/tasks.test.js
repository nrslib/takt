import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueTasks } from '../src/app/tasks.js';

test('valid specs are queued in order', () => {
  const queue = enqueueTasks([{ title: 'one' }, { title: 'two', piece: 'default' }]);
  assert.equal(queue.size(), 2);
  assert.deepEqual(queue.shift(), { title: 'one' });
});

test('a malformed spec is rejected', () => {
  assert.throws(() => enqueueTasks([{ notTitle: true }]));
});
