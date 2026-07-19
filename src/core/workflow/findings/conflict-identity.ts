import { createHash } from 'node:crypto';

export interface ConflictIdentity {
  findingIds: readonly string[];
  rawFindingIds: readonly string[];
}

export interface IdentifiedConflict extends ConflictIdentity {
  id: string;
}

export function formatConflictSignature(conflict: ConflictIdentity): string {
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
  existingConflicts: readonly IdentifiedConflict[],
  regeneratedConflicts: readonly ConflictIdentity[],
): Set<string> {
  const regeneratedSignatures = new Set(regeneratedConflicts.map(formatConflictSignature));
  const conflictIds = new Set(regeneratedConflicts.map(formatConflictId));
  for (const conflict of existingConflicts) {
    if (regeneratedSignatures.has(formatConflictSignature(conflict))) {
      conflictIds.add(conflict.id);
    }
  }
  return conflictIds;
}
