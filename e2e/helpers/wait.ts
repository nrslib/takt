/**
 * Shared wait utilities for E2E tests.
 * Centralizes waitFor / waitForClose to avoid duplication across spec files.
 */

import { spawn } from 'node:child_process';

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
 * Kills the process with SIGKILL and rejects if the timeout is exceeded.
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
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
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
