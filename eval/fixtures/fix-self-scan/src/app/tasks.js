import { assertTaskSpec } from '../core/schema.js';
import { createQueue } from '../core/queue.js';

// Loads pending task specs into a bounded queue.
export function enqueueTasks(specs, capacity = 32) {
  const queue = createQueue(capacity);
  for (const spec of specs) {
    queue.push(assertTaskSpec(spec));
  }
  return queue;
}
