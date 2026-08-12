import { pathKey } from './path-key.js';

export function progressText(path) {
  return `execution=${pathKey(path)}`;
}
