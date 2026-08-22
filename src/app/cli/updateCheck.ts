import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

const UPDATE_CHECK_WORKER_PATH = fileURLToPath(
  new URL('../../shared/utils/updateNotifierWorker.js', import.meta.url),
);
const UPDATE_NOTIFIER_DISABLED_ARG = '--no-update-notifier';

function resolveWorkerArgs(): string[] {
  return process.argv.includes(UPDATE_NOTIFIER_DISABLED_ARG)
    ? [UPDATE_CHECK_WORKER_PATH, UPDATE_NOTIFIER_DISABLED_ARG]
    : [UPDATE_CHECK_WORKER_PATH];
}

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
 * Show a cached pending update exactly like the previous in-process flow:
 * update-notifier consumes the cache and defers the boxen message to this
 * (parent) process's exit. The heavy import is only paid when an update is
 * actually pending, so the lightweight startup path stays unaffected.
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
  const worker = spawn(process.execPath, resolveWorkerArgs(), {
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
