import { createHash } from 'node:crypto';

export function goalEventId(goalId: string, kind: string, reference: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([goalId, kind, reference])).digest('hex');
}
