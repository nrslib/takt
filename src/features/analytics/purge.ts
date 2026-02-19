/**
 * Retention-based purge for analytics event files.
 *
 * Deletes JSONL files older than the configured retention period.
 */

import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Purge JSONL event files older than the retention period.
 *
 * @param eventsDir Absolute path to the analytics events directory
 * @param retentionDays Number of days to retain (files older than this are deleted)
 * @param now Reference time for age calculation
 * @returns List of deleted file names
 */
export function purgeOldEvents(eventsDir: string, retentionDays: number, now: Date): string[] {
  const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  let files: string[];
  try {
    files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }

  const deleted: string[] = [];
  for (const file of files) {
    const dateStr = file.replace('.jsonl', '');
    if (dateStr < cutoffStr) {
      unlinkSync(join(eventsDir, file));
      deleted.push(file);
    }
  }

  return deleted;
}
