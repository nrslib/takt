import { execFileSync } from 'node:child_process';
import type { ProcessIdentity } from './process.js';

let selfIdentity: ProcessIdentity | null | undefined;

function readTaskProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined;
  try {
    const startTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      shell: false,
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Tasks can be recovered by another invocation with a different locale
      // or timezone. Keep this format separate from existing central locks.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
    return startTime.length > 0 ? { startTime } : undefined;
  } catch {
    return undefined;
  }
}

export function getSelfTaskProcessIdentity(): ProcessIdentity | undefined {
  if (selfIdentity === undefined) {
    selfIdentity = readTaskProcessIdentity(process.pid) ?? null;
  }
  return selfIdentity ?? undefined;
}

export function getTaskProcessIdentity(pid: number): ProcessIdentity | undefined {
  return pid === process.pid ? getSelfTaskProcessIdentity() : readTaskProcessIdentity(pid);
}
