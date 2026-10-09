import { readUnixStart as defaultUnixStart } from './unix-process-time.mjs';
export function getProcessStartTime(pid, {
  platform = process.platform,
  readUnixStart = defaultUnixStart,
  readWindowsCreationTime,
}) {
  if (platform === 'darwin' || platform === 'linux') return readUnixStart(pid);
  return undefined;
}

export function isSameProcess(record, readers) {
  return record.startedAt === getProcessStartTime(record.pid, readers);
}
