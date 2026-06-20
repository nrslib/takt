import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readSessionRecords(repoPath: string): Array<Record<string, unknown>> {
  const runsDir = join(repoPath, '.takt', 'runs');
  const runDirs = readdirSync(runsDir).sort();

  for (const runDir of runDirs) {
    const logsDir = join(runsDir, runDir, 'logs');
    const logFiles = readdirSync(logsDir).filter(isCanonicalSessionLogFile);
    for (const file of logFiles) {
      const content = readFileSync(join(logsDir, file), 'utf-8').trim();
      if (!content) continue;
      const records = content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records[0]?.type === 'workflow_start') {
        return records;
      }
    }
  }

  throw new Error('Session NDJSON log not found');
}

function isCanonicalSessionLogFile(file: string): boolean {
  return file.endsWith('.jsonl') && !file.endsWith('-otel-session-shadow.jsonl') && !file.endsWith('-usage-events.jsonl');
}
