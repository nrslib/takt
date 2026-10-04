import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/core/queue.js';

test('push and shift preserve FIFO order within capacity', () => {
  const queue = createQueue(2);
  queue.push('a');
  queue.push('b');
  assert.equal(queue.shift(), 'a');
  assert.equal(queue.shift(), 'b');
});

test('push beyond capacity throws', () => {
  const queue = createQueue(1);
  queue.push('a');
  assert.throws(() => queue.push('b'));
});

test('non-positive capacity is rejected', () => {
  assert.throws(() => createQueue(0));
});
