import { writeFileSync } from 'node:fs';
import { getProcessStartTime } from './process-start.mjs';

export function beginProjectRun(pid, readers, attemptPath = '.last-project') {
  writeFileSync(attemptPath, String(pid));
  const startedAt = getProcessStartTime(pid, readers);
  if (!startedAt) throw new Error('process start time unavailable');
  return { pid, startedAt, running: true };
}
