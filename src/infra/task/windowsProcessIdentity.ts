import { execFileSync } from 'node:child_process';
import { resolveWindowsPowerShellExecutablePath } from '../../shared/utils/executable-path.js';
import type { ProcessIdentity } from './process.js';

const WINDOWS_START_TIME = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}Z$/;

export function isWindowsProcessStartTime(startTime: string): boolean {
  const match = WINDOWS_START_TIME.exec(startTime);
  if (match === null || match[0] !== startTime) return false;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month
    && date.getUTCDate() === day;
}

export function readWindowsProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const output = execFileSync(
      resolveWindowsPowerShellExecutablePath(),
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`,
      ],
      {
        encoding: 'utf8',
        shell: false,
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const startTime = output.trim();
    return isWindowsProcessStartTime(startTime) ? { startTime } : undefined;
  } catch {
    // An unavailable process inspector cannot establish process ownership.
    return undefined;
  }
}
