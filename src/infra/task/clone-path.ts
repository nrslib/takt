import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { slugify } from '../../shared/utils/slug.js';

const UNIQUE_SUFFIX_BYTES = 8;

function createUniqueClonePath(baseDir: string, name: string): string {
  const suffix = randomBytes(UNIQUE_SUFFIX_BYTES).toString('hex');
  return path.join(path.resolve(baseDir), `${name}-${suffix}`);
}

export function createTaskClonePath(
  baseDir: string,
  timestamp: string,
  issueNumber: number | undefined,
  taskSlug: string,
): string {
  const safeTaskSlug = slugify(taskSlug);
  const nameParts = [
    timestamp,
    safeTaskSlug && issueNumber !== undefined ? String(issueNumber) : undefined,
    safeTaskSlug,
  ];

  return createUniqueClonePath(baseDir, nameParts.filter(Boolean).join('-'));
}

export function createTempClonePath(baseDir: string, timestamp: string): string {
  return createUniqueClonePath(baseDir, `tmp-${timestamp}`);
}

export function createPrSyncWorktreePath(baseDir: string, timestamp: number): string {
  return createUniqueClonePath(baseDir, `pr-sync-${timestamp}`);
}
