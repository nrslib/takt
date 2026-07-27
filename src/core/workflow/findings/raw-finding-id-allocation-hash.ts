import { createHash } from 'node:crypto';

export function hashRawFindingIdAllocationContent(
  normalizedContent: string,
): string {
  return createHash('sha256').update(normalizedContent).digest('hex');
}
