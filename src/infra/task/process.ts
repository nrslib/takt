/**
 * Shared process-level helpers.
 */

import { execFileSync } from 'node:child_process';
import { resolveWindowsPowerShellExecutablePath } from '../../shared/utils/executable-path.js';

/**
 * A process identity based on the operating system's process start time.
 * The PID alone is deliberately not used for ownership recovery because it
 * can be reused by an unrelated process.
 */
export interface ProcessIdentity {
  /** Opaque identifier; Unix values include the normalized format version. */
  readonly startTime: string;
}

const UNIX_START_TIME_PREFIX = 'ps-lstart-utc-v1:';
const UNIX_START_TIME = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d (\d{4})$/;
const WINDOWS_START_TIME = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}Z$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function calendarDate(year: number, month: number, day: number): Date | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month
    && date.getUTCDate() === day ? date : undefined;
}

function processIdentityFormat(identity: ProcessIdentity | undefined): 'unix' | 'windows' | undefined {
  if (identity === undefined) return undefined;
  const { startTime } = identity;
  if (startTime.startsWith(UNIX_START_TIME_PREFIX)) {
    const timestamp = startTime.slice(UNIX_START_TIME_PREFIX.length);
    const match = UNIX_START_TIME.exec(timestamp);
    if (match === null || match[0] !== timestamp) return undefined;
    const date = calendarDate(Number(match[4]), MONTHS.indexOf(match[2]!), Number(match[3]));
    return date !== undefined && WEEKDAYS[date.getUTCDay()] === match[1] ? 'unix' : undefined;
  }
  const match = WINDOWS_START_TIME.exec(startTime);
  if (match === null || match[0] !== startTime) return undefined;
  return calendarDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])) !== undefined
    ? 'windows' : undefined;
}

let selfProcessIdentity: ProcessIdentity | null | undefined;

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') return undefined;
  const windows = process.platform === 'win32';
  try {
    const output = execFileSync(
      windows ? resolveWindowsPowerShellExecutablePath() : 'ps',
      windows ? [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`,
      ] : ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        shell: false,
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(windows ? {} : { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } }),
      },
    );
    const startTime = output.trim();
    const identity = { startTime: windows ? startTime : `${UNIX_START_TIME_PREFIX}${startTime}` };
    return processIdentityFormat(identity) === (windows ? 'windows' : 'unix') ? identity : undefined;
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
  return first !== undefined && second !== undefined
    && processIdentityFormat(first) !== undefined && first.startTime === second.startTime;
}

/** Invalid or legacy timestamps cannot prove PID reuse. */
export function hasProcessIdentityMismatch(
  recorded: ProcessIdentity | undefined,
  current: ProcessIdentity | undefined,
): boolean {
  if (recorded === undefined || current === undefined) return false;
  const format = processIdentityFormat(recorded);
  return format !== undefined && format === processIdentityFormat(current)
    && recorded.startTime !== current.startTime;
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
