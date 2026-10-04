// Bounded FIFO queue for pending task specs.
export function createQueue(capacity) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`queue capacity must be a positive integer: ${capacity}`);
  }
  const items = [];
  return {
    push(item) {
      if (items.length >= capacity) throw new Error('queue is full');
      items.push(item);
      return items.length;
    },
    shift: () => items.shift(),
    size: () => items.length,
  };
}
