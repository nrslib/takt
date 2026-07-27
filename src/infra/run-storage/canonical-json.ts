import { createHash } from 'node:crypto';
export { canonicalJson } from '../../shared/utils/canonical-json.js';

export function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}
