import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read session NDJSON log records from a piece execution run.
 * Finds the first .jsonl file whose first record is `piece_start`.
 */
export function readSessionRecords(repoPath: string): Array<Record<string, unknown>> {
  const runsDir = join(repoPath, '.takt', 'runs');
  const runDirs = readdirSync(runsDir).sort();

  for (const runDir of runDirs) {
    const logsDir = join(runsDir, runDir, 'logs');
    const logFiles = readdirSync(logsDir).filter((file) => file.endsWith('.jsonl'));
    for (const file of logFiles) {
      const content = readFileSync(join(logsDir, file), 'utf-8').trim();
      if (!content) continue;
      const records = content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records[0]?.type === 'piece_start') {
        return records;
      }
    }
  }

  throw new Error('Session NDJSON log not found');
}
