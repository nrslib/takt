/**
 * Shared process-level helpers.
 */

import { execFileSync } from 'node:child_process';

/**
 * A portable-enough process identity for platforms where `ps` is available.
 * The PID alone is deliberately not used for ownership recovery because it
 * can be reused by an unrelated process.
 */
export interface ProcessIdentity {
  readonly startTime: string;
}

export function getProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        shell: false,
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const startTime = output.trim();
    return startTime.length > 0 ? { startTime } : undefined;
  } catch {
    // An unavailable process inspector is treated as unknown by callers.
    return undefined;
  }
}

export function sameProcessIdentity(
  first: ProcessIdentity | undefined,
  second: ProcessIdentity | undefined,
): boolean {
  return first !== undefined && second !== undefined && first.startTime === second.startTime;
}

export function isProcessAlive(ownerPid: number): boolean {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ESRCH') {
      return false;
    }
    if (nodeErr.code === 'EPERM') {
      return true;
    }
    throw err;
  }
}

export function isStaleRunningTask(ownerPid: number | undefined): boolean {
  return ownerPid == null || !isProcessAlive(ownerPid);
}
