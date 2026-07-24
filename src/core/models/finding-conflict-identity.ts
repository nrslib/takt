import { createHash } from 'node:crypto';

export interface ConflictIdentity {
  findingIds: readonly string[];
  rawFindingIds: readonly string[];
}

function formatConflictSignature(conflict: ConflictIdentity): string {
  const namespace = conflict.findingIds.length > 0 ? 'finding' : 'raw';
  const ids = conflict.findingIds.length > 0 ? conflict.findingIds : conflict.rawFindingIds;
  return JSON.stringify({ namespace, ids: [...ids].sort() });
}

export function formatConflictId(conflict: ConflictIdentity): string {
  const signature = formatConflictSignature(conflict);
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 12).toUpperCase();
  return `C-${hash}`;
}

export function collectRegeneratedConflictIds(
  regeneratedConflicts: readonly ConflictIdentity[],
): Set<string> {
  return new Set(regeneratedConflicts.map(formatConflictId));
}
