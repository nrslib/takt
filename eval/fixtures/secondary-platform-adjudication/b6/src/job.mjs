import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionEndpoint } from './platform-path.mjs';

export function runJob(job, secret, stateDir = '.job-state') {
  writeFileSync(join(stateDir, 'secret'), secret, { mode: 0o600 });
  return { completed: true, endpoint: sessionEndpoint(), job };
}
