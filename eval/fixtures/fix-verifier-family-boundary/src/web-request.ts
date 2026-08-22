import { normalizeRequestToken } from './token-normalization.js';

export function webToken(raw: string): string {
  return normalizeRequestToken(raw);
}
