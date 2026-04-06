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
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
