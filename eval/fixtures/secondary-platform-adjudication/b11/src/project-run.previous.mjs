import { writeFileSync } from 'node:fs';

export function beginProjectRun(pid, attemptPath = '.last-project') {
  writeFileSync(attemptPath, String(pid));
  return { pid, running: true };
}
