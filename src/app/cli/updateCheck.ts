import { spawn } from 'node:child_process';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { consumeCachedNewerVersion } from '../../shared/utils/updateNotifierCache.js';
import { resolveUpdateCheckWorkerArgs, UPDATE_NOTIFIER_DISABLED_ARG } from '../../shared/utils/updateNotifierProcess.js';

/**
 * Consume the optional notification without waiting for a registry request.
 */
function consumePendingUpdate(currentVersion: string): string | undefined {
  if ('NO_UPDATE_NOTIFIER' in process.env) return undefined;
  if (process.argv.includes(UPDATE_NOTIFIER_DISABLED_ARG)) return undefined;
  if (process.stdout.isTTY !== true) return undefined;
  return consumeCachedNewerVersion(currentVersion);
}

/**
 * Display the cached version before starting the main command.
 */
async function notifyPendingUpdate(currentVersion: string): Promise<void> {
  const latest = consumePendingUpdate(currentVersion);
  if (latest === undefined) return;
  const { checkForUpdates } = await import('../../shared/utils/updateNotifier.js');
  checkForUpdates(currentVersion, latest);
}

function logUpdateCheckFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`takt: update check skipped (${sanitizeTerminalText(message)})`);
}

/**
 * Refresh the update cache in a silent detached worker for future runs.
 * The worker never writes to the terminal (stdio is always ignored), so it
 * cannot interleave output with the parent CLI.
 */
export function startUpdateCheckWorker(): void {
  const worker = spawn(process.execPath, resolveUpdateCheckWorkerArgs(), {
    detached: true,
    stdio: 'ignore',
  });
  // Update check is best-effort: without this listener a spawn failure is
  // emitted as an unhandled 'error' event and would crash the CLI itself.
  worker.on('error', logUpdateCheckFailure);
  worker.unref();
}

/**
 * Run the update check: notify any cached update from the parent process
 * then refresh the cache in the background.
 * Every step is best-effort: an update-check failure must never take down
 * the CLI itself.
 */
export async function runUpdateCheck(currentVersion: string): Promise<void> {
  try {
    await notifyPendingUpdate(currentVersion);
  } catch (error) {
    logUpdateCheckFailure(error);
  }
  try {
    startUpdateCheckWorker();
  } catch (error) {
    logUpdateCheckFailure(error);
  }
}
