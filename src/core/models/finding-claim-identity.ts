import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/utils/canonical-json.js';

export function normalizeFindingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function computeClaimIdentityHash(input: {
  targetFindingId: string | null | undefined;
  title: string;
  description: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    domain: 'finding-claim-identity',
    version: 1,
    targetFindingId: input.targetFindingId ?? null,
    title: normalizeFindingText(input.title),
    description: input.description,
  })).digest('hex');
}
