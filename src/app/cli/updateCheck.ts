import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { resolveUpdateCheckWorkerArgs, UPDATE_NOTIFIER_DISABLED_ARG } from '../../shared/utils/updateNotifierProcess.js';

/**
 * Cheaply detect a cached pending update without importing update-notifier.
 * Mirrors configstore's path resolution for `update-notifier-takt`.
 */
function hasCachedUpdate(currentVersion: string): boolean {
  if ('NO_UPDATE_NOTIFIER' in process.env) return false;
  if (process.argv.includes(UPDATE_NOTIFIER_DISABLED_ARG)) return false;
  if (process.stdout.isTTY !== true) return false;
  try {
    const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    const raw = readFileSync(join(configDir, 'configstore', 'update-notifier-takt.json'), 'utf8');
    const cached = JSON.parse(raw) as { update?: { latest?: string } };
    const latest = cached.update?.latest;
    return typeof latest === 'string' && latest !== currentVersion;
  } catch {
    return false;
  }
}

/**
 * Consume the cached update in an isolated worker and defer its notification
 * to the parent process's exit without importing the vendor into the parent.
 */
async function notifyPendingUpdate(currentVersion: string): Promise<void> {
  if (!hasCachedUpdate(currentVersion)) return;
  const { checkForUpdates } = await import('../../shared/utils/updateNotifier.js');
  checkForUpdates();
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
 * (preserving the pre-worker notification contract), then refresh the cache
 * in the background. The notification must consume the cache before the
 * worker starts so the two never race for the same cache entry.
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
