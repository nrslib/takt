import { pathKey } from './path-key.js';

export function createCheckpoint(path, state) {
  return { executionId: pathKey(path), state };
}

export function resumeCheckpoint(path, checkpoint) {
  if (checkpoint.executionId !== pathKey(path)) throw new Error('checkpoint mismatch');
  return checkpoint.state;
}
