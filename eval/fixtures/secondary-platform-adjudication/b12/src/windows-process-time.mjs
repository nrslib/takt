import { execFileSync } from 'node:child_process';

export function readWindowsCreationTime(pid, run = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError('invalid pid');
  const command = `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToString('o')`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  }).trim();
}
