/**
 * Shared wait utilities for E2E tests.
 * Centralizes waitFor / waitForClose to avoid duplication across spec files.
 */

import { spawn } from 'node:child_process';

const FORCE_KILL_GRACE_MS = 1_000;

/**
 * Poll a predicate until it returns true or the timeout expires.
 * Returns true if the predicate became true, false on timeout.
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs: number = 100,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Wait for a spawned child process to exit.
 * On timeout, sends SIGKILL and rejects after termination is observed.
 */
export async function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
    };
  }

  return new Promise((resolve, reject) => {
    let timeoutError: Error | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      child.removeListener('close', onClose);
      child.removeListener('exit', onExit);
    };

    const rejectAfterCleanup = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (timeoutError) {
        reject(timeoutError);
        return;
      }
      resolve({ code, signal });
    };

    const onExit = (): void => {
      if (timeoutError) {
        rejectAfterCleanup(timeoutError);
      }
    };

    const timeout = setTimeout(() => {
      timeoutError = new Error(`Process did not exit within ${timeoutMs}ms`);
      try {
        if (!child.kill('SIGKILL')) {
          rejectAfterCleanup(timeoutError);
          return;
        }
      } catch (error) {
        rejectAfterCleanup(error);
        return;
      }

      if (settled) {
        return;
      }
      forceKillTimeout = setTimeout(() => {
        rejectAfterCleanup(new Error(
          `Process did not terminate within ${FORCE_KILL_GRACE_MS}ms after SIGKILL`,
        ));
      }, FORCE_KILL_GRACE_MS);
      forceKillTimeout.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.once('close', onClose);
    child.once('exit', onExit);
  });
}

export async function cleanupChildProcess(
  child: ReturnType<typeof spawn> | undefined,
  timeoutMs: number = 5_000,
): Promise<void> {
  if (!child) {
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (!child.kill('SIGINT')) {
      await waitForClose(child, timeoutMs);
      return;
    }
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    throw error;
  }

  await waitForClose(child, timeoutMs);
}

export function cleanupTestResource(label: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} cleanup failed: ${message}`);
  }
}
