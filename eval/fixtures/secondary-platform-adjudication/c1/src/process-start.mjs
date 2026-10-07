import { readUnixStart as defaultUnixStart } from './unix-process-time.mjs';
import { readWindowsCreationTime as defaultWindowsCreationTime } from './windows-process-time.mjs';

export function getProcessStartTime(pid, {
  platform = process.platform,
  readUnixStart = defaultUnixStart,
  readWindowsCreationTime = defaultWindowsCreationTime,
} = {}) {
  if (platform === 'win32') return readWindowsCreationTime(pid);
  if (platform === 'darwin' || platform === 'linux') return readUnixStart(pid);
  return undefined;
}

export function isSameProcess(record, currentPid, readers) {
  if (record.pid !== currentPid) return false;
  const startedAt = getProcessStartTime(currentPid, readers);
  return startedAt !== undefined && record.startedAt === startedAt;
}
