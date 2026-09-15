import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NdjsonRecord, NdjsonStepComplete } from '../../shared/utils/types.js';

export function writeRunSessionLogFixture(
  cwd: string,
  slug: string,
  history: Array<Pick<NdjsonStepComplete, 'step' | 'persona' | 'status' | 'content'>>,
): void {
  const timestamp = '2026-02-01T00:00:00.000Z';
  const records: NdjsonRecord[] = [
    { type: 'workflow_start', task: 'fixture task', workflowName: 'default', startTime: timestamp },
    ...history.map((entry, index): NdjsonStepComplete => ({
      type: 'step_complete',
      ...entry,
      iteration: index + 1,
      instruction: '',
      timestamp,
    })),
    { type: 'workflow_complete', iterations: history.length, endTime: timestamp },
  ];
  writeFileSync(
    join(cwd, '.takt', 'runs', slug, 'logs', 'session-001.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}
