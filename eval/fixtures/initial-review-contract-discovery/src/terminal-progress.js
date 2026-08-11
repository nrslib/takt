import { pathKey } from './path-key.js';

export function terminalProgress(path) {
  return `execution=${pathKey(path)}`;
}
