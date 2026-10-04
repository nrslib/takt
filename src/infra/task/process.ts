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

let selfProcessIdentity: ProcessIdentity | null | undefined;

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
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

/** Resolve the current process identity once; its start time cannot change. */
export function getSelfProcessIdentity(): ProcessIdentity | undefined {
  if (selfProcessIdentity === undefined) {
    selfProcessIdentity = readProcessIdentity(process.pid) ?? null;
  }
  return selfProcessIdentity ?? undefined;
}

export function getProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (pid === process.pid) return getSelfProcessIdentity();
  return readProcessIdentity(pid);
}

/**
 * Returns true only when both identities are known and equal. Unknown identity
 * is never treated as a match, so callers remain fail-closed.
 */
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
