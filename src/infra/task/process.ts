/**
 * Shared process-level helpers.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

const DARWIN_START_TIME = /^darwin-start-v1:([1-9]\d*):(0|[1-9]\d{0,5})$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINUX_START_TIME = /^linux-start-v2:([0-9a-f-]{36}):(0|[1-9]\d*):([0-9a-f-]{36})$/;
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
    && BigInt(linux[2]!) <= 0xffffffffffffffffn && BOOT_ID.test(linux[3]!)) return 'linux';
  const match = WINDOWS_START_TIME.exec(startTime);
  if (match === null || match[0] !== startTime) return undefined;
  return calendarDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])) !== undefined
    ? 'windows' : undefined;
}

let selfProcessIdentity: ProcessIdentity | null | undefined;

function readDarwinProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (process.arch !== 'arm64' && process.arch !== 'x64') return undefined;
  // Darwin LP64 SDK: sizeof(kinfo_proc)=648, p_starttime=(int64 sec,int32 usec), p_pid at 40.
  // sysctl CLI exposes kern.proc as a table; it does not accept a PID suffix.
  const table = execFileSync('/usr/sbin/sysctl', ['-b', 'kern.proc'], {
    shell: false, timeout: 1_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const recordSize = 648;
  if (table.length % recordSize !== 0) return undefined;
  let identity: ProcessIdentity | undefined;
  for (let offset = 0; offset < table.length; offset += recordSize) {
    if (table.readInt32LE(offset + 40) !== pid) continue;
    if (identity !== undefined) return undefined;
    const seconds = table.readBigInt64LE(offset);
    const microseconds = table.readInt32LE(offset + 8);
    if (seconds <= 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER) || microseconds < 0 || microseconds >= 1_000_000) return undefined;
    identity = { startTime: `darwin-start-v1:${seconds}:${microseconds}` };
  }
  return identity;
}

function readLinuxInstanceEvidence(pid: number): string | undefined {
  const prefix = `takt-process-identity-${pid}-`;
  let evidence: string | undefined;
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    const path = `/proc/${pid}/fd/${fd}`;
    let target: string;
    try { target = readlinkSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const name = basename(target);
    if (!name.startsWith(prefix) || !name.endsWith(' (deleted)')) continue;
    const nonce = name.slice(prefix.length, -' (deleted)'.length);
    if (!BOOT_ID.test(nonce) || nonce.length !== 36) return undefined;
    // Open without blocking: an FD can be replaced between readlink and open.
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 0n || opened.size !== 36n) return undefined;
      const content = Buffer.alloc(37);
      if (readSync(descriptor, content, 0, content.length, 0) !== 36 || content.subarray(0, 36).toString('utf8') !== nonce) return undefined;
      const current = statSync(path, { bigint: true });
      if (readlinkSync(path) !== target || current.dev !== opened.dev || current.ino !== opened.ino) return undefined;
      if (evidence !== undefined && evidence !== nonce) return undefined;
      evidence = nonce;
    } finally { closeSync(descriptor); }
  }
  return evidence;
}

function initializeLinuxInstanceEvidence(): void {
  const nonce = randomUUID();
  const path = join(tmpdir(), `takt-process-identity-${process.pid}-${nonce}`);
  const descriptor = openSync(path, 'wx+', 0o600);
  try {
    writeFileSync(descriptor, nonce);
    unlinkSync(path);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  // The OS closes this unlinked file at process exit, including SIGKILL.
  // It must stay open until the last ownership check; it is not inherited by spawn.
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
  let evidence = readLinuxInstanceEvidence(pid);
  if (pid === process.pid && evidence === undefined) {
    initializeLinuxInstanceEvidence();
    evidence = readLinuxInstanceEvidence(pid);
  }
  if (evidence === undefined) return undefined;
  const identity = { startTime: `linux-start-v2:${bootId}:${ticks}:${evidence}` };
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
  if (selfProcessIdentity !== null && processIdentityFormat(selfProcessIdentity) === 'linux') {
    try {
      if (!selfProcessIdentity.startTime.endsWith(`:${readLinuxInstanceEvidence(process.pid)}`)) return undefined;
    } catch {
      // A cached identifier does not prove that its lifetime FD is still held.
      return undefined;
    }
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
