import { pathKey } from './path-key.js';

export function executionEvent(path, type) {
  return { executionId: pathKey(path), type };
}
