import { pathKey } from './path-key.js';

export function statusResponse(path, state) {
  return { executionId: pathKey(path), state };
}
