import { pathKey } from './path-key.js';

export function statusRecord(path, state) {
  return { executionId: pathKey(path), state };
}
