/**
 * Shared process-level helpers.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveWindowsPowerShellExecutablePath } from '../../shared/utils/executable-path.js';
import { getTaskProcessIdentity } from './taskProcessIdentity.js';

/**
 * A process identity based on the operating system's process start time.
 * The PID alone is deliberately not used for ownership recovery because it
 * can be reused by an unrelated process.
 */
export interface ProcessIdentity {
  /** Opaque identifier; Unix values include the normalized format version. */
  readonly startTime: string;
}

const DARWIN_START_TIME = /^darwin-start-v2:([1-9]\d*)$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINUX_START_TIME = /^linux-start-v3:([0-9a-f-]{36}):(0|[1-9]\d*)$/;
const WINDOWS_START_TIME = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}Z$/;

function calendarDate(year: number, month: number, day: number): Date | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month
    && date.getUTCDate() === day ? date : undefined;
}

function processIdentityFormat(identity: ProcessIdentity | undefined): 'darwin' | 'linux' | 'windows' | undefined {
  if (identity === undefined) return undefined;
  const { startTime } = identity;
  const darwin = DARWIN_START_TIME.exec(startTime);
  if (darwin !== null && darwin[0] === startTime && Number.isSafeInteger(Number(darwin[1]))) return 'darwin';
  const linux = LINUX_START_TIME.exec(startTime);
  if (linux !== null && linux[0] === startTime && BOOT_ID.test(linux[1]!)
    && BigInt(linux[2]!) <= 0xffffffffffffffffn) return 'linux';
  const match = WINDOWS_START_TIME.exec(startTime);
  if (match === null || match[0] !== startTime) return undefined;
  return calendarDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])) !== undefined
    ? 'windows' : undefined;
}

let selfProcessIdentity: ProcessIdentity | null | undefined;

function readDarwinProcessIdentity(pid: number): ProcessIdentity | undefined {
  const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', shell: false, timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
  }).trim();
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) ([1-9]\d{3})$/.exec(output);
  if (match === null) return undefined;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2]!);
  const date = calendarDate(Number(match[7]), month, Number(match[3]));
  if (date === undefined || date.getUTCDay() !== ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(match[1]!)) return undefined;
  date.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]));
  return { startTime: `darwin-start-v2:${date.getTime() / 1_000}` };
}

function readLinuxProcessIdentity(pid: number): ProcessIdentity | undefined {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!BOOT_ID.test(bootId) || bootId.length !== 36) return undefined;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm can contain spaces and parentheses; field 3 follows the final closing parenthesis.
  const end = stat.lastIndexOf(')');
  if (!stat.startsWith(`${pid} (`) || end < 0) return undefined;
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  const ticks = fields[19]; // /proc/PID/stat field 22, preserved in clock ticks.
  if (ticks === undefined || !/^(0|[1-9]\d*)$/.test(ticks) || BigInt(ticks) > 0xffffffffffffffffn) return undefined;
  const identity = { startTime: `linux-start-v3:${bootId}:${ticks}` };
  return processIdentityFormat(identity) === 'linux' ? identity : undefined;
}

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') return undefined;
  try {
    if (process.platform === 'darwin') return readDarwinProcessIdentity(pid);
    if (process.platform === 'linux') return readLinuxProcessIdentity(pid);
    const output = execFileSync(
      resolveWindowsPowerShellExecutablePath(),
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`,
      ],
      {
        encoding: 'utf8',
        shell: false,
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const startTime = output.trim();
    const identity = { startTime };
    return processIdentityFormat(identity) === 'windows' ? identity : undefined;
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

export function isStaleRunningTask(
  ownerPid: number | undefined,
  ownerStartTime?: string,
): boolean {
  if (ownerPid == null || !isProcessAlive(ownerPid)) return true;
  // Legacy records and unavailable inspectors do not prove a live owner stale.
  if (ownerStartTime === undefined) return false;
  const identity = getTaskProcessIdentity(ownerPid);
  return identity !== undefined && identity.startTime !== ownerStartTime;
}
