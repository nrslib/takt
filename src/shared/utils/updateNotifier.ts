import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { resolveUpdateCheckWorkerArgs } from './updateNotifierProcess.js';

const NOTIFICATION_TIMEOUT_MS = 2000;
const MAX_NOTIFICATION_BYTES = 64 * 1024;

/**
 * The vendor installs signal handlers on import, so even cached notifications
 * must run in a worker to preserve the parent CLI's shutdown control.
 */
export function checkForUpdates(): void {
  const result = spawnSync(process.execPath, resolveUpdateCheckWorkerArgs(), {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    timeout: NOTIFICATION_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_NOTIFICATION_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Update notification worker failed (${result.signal ?? result.status}): ${result.stderr}`);
  }
  if (result.stderr.length > 0) {
    process.once('exit', () => writeSync(2, result.stderr));
  }
}
