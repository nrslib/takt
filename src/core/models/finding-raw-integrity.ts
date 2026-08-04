import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import type { RawFinding } from './finding-types.js';

export function computeRawFindingIntegrityDigest(rawFinding: RawFinding): string {
  return createHash('sha256').update(canonicalJson({
    version: 1,
    rawFinding,
  })).digest('hex');
}
