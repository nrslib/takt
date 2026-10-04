/**
 * Cross-platform spawn wrapper.
 *
 * On Windows, npm-installed CLIs may be `.cmd` shim files.  This wrapper
 * delegates to `cross-spawn` there so callers keep argv-based execution
 * without shell-specific platform checks.
 */

import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import crossSpawnPackage from 'cross-spawn';
import { resolveSystem32ExecutablePath } from './executable-path.js';
import { formatProcessExitCause } from './process-exit.js';

const TERMINATION_GRACE_MS = 250;
const TERMINATION_SETTLE_INTERVAL_MS = 10;
const TERMINATION_SETTLE_TIMEOUT_MS = 2_000;

export function crossSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const spawnImpl = process.platform === 'win32' ? crossSpawnPackage : spawn;
  return spawnImpl(command, args as string[], options);
}

export interface ManagedProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ManagedProcess {
  readonly child: ChildProcess;
  waitForExit(): Promise<ManagedProcessExit>;
  wait(): Promise<ManagedProcessExit>;
  terminate(): Promise<void>;
}

export interface ManagedProcessLifecycleOptions {
  readonly terminationMode?: 'process-tree' | 'child';
  readonly terminationGraceMs?: number;
}

function isProcessMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function requireProcessId(pid: number | undefined): number {
  if (pid === undefined) {
    throw new Error('Spawned process has no PID');
  }
  return pid;
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isProcessMissing(error)) {
      throw error;
    }
  }
}

async function forceTerminateWindowsProcess(pid: number | undefined): Promise<void> {
  const targetPid = requireProcessId(pid);
  const taskkillExecutable = resolveSystem32ExecutablePath('taskkill.exe');
  const killer = crossSpawn(taskkillExecutable, ['/pid', String(targetPid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    killer.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    killer.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `taskkill for process ${targetPid} exited with ${formatProcessExitCause(code, signal)}`,
      ));
    });
  });
}

function isPosixProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isProcessMissing(error)) return false;
    throw error;
  }
}

async function waitForPosixProcessGroupExit(pid: number): Promise<void> {
  const deadline = Date.now() + TERMINATION_SETTLE_TIMEOUT_MS;
  while (isPosixProcessGroupRunning(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process group ${pid} did not terminate`);
    }
    await delay(TERMINATION_SETTLE_INTERVAL_MS);
  }
}

async function terminatePosixProcessTree(targetPid: number | undefined): Promise<void> {
  const pid = requireProcessId(targetPid);
  let terminationError: unknown;
  try {
    signalPosixProcessGroup(pid, 'SIGTERM');
  } catch (error) {
    terminationError = error;
  }
  await delay(TERMINATION_GRACE_MS);
  try {
    signalPosixProcessGroup(pid, 'SIGKILL');
  } catch (error) {
    terminationError ??= error;
  }
  try {
    await waitForPosixProcessGroupExit(pid);
  } catch (error) {
    terminationError ??= error;
  }
  if (terminationError !== undefined) throw terminationError;
}

function terminateProcessTree(pid: number | undefined): Promise<void> {
  return process.platform === 'win32'
    ? forceTerminateWindowsProcess(pid)
    : terminatePosixProcessTree(pid);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

async function waitForCloseSettlement(closePromise: Promise<ManagedProcessExit>): Promise<void> {
  await Promise.race([
    closePromise.then(() => undefined),
    delay(TERMINATION_GRACE_MS),
  ]);
}

export function spawnManagedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  signal: AbortSignal | undefined,
  lifecycleOptions?: ManagedProcessLifecycleOptions,
): ManagedProcess {
  signal?.throwIfAborted();
  const child = crossSpawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
  const processGroupId = child.pid;
  let spawnError: unknown;
  let terminationError: unknown;
  let terminationPromise: Promise<void> | undefined;
  let resolveTerminationSettled!: () => void;
  let resolveSpawnError!: (error: unknown) => void;
  const terminationSettledPromise = new Promise<void>((resolve) => {
    resolveTerminationSettled = resolve;
  });
  const spawnErrorPromise = new Promise<unknown>((resolve) => {
    resolveSpawnError = resolve;
  });

  const leaderExitOutcomePromise = new Promise<
    | { readonly kind: 'exit'; readonly result: ManagedProcessExit }
    | { readonly kind: 'spawn-error'; readonly error: unknown }
  >((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolveSpawnError(error);
      resolve({ kind: 'spawn-error', error });
    });
    child.once('exit', (code, exitSignal) => {
      resolve({ kind: 'exit', result: { code, signal: exitSignal } });
    });
  });

  const closePromise = new Promise<ManagedProcessExit>((resolve) => {
    child.once('close', (code, closeSignal) => {
      resolve({ code, signal: closeSignal });
    });
  });

  async function terminateChild(): Promise<void> {
    child.kill('SIGTERM');
    const closedBeforeDeadline = await Promise.race([
      closePromise.then(() => true),
      delay(lifecycleOptions?.terminationGraceMs ?? TERMINATION_GRACE_MS).then(() => false),
    ]);
    if (!closedBeforeDeadline) {
      child.kill('SIGKILL');
    }
    await closePromise;
  }

  function requestTermination(): void {
    if (terminationPromise !== undefined) return;
    terminationPromise = (
      lifecycleOptions?.terminationMode === 'child'
        ? terminateChild()
        : terminateProcessTree(processGroupId)
    )
      .catch((error: unknown) => {
        terminationError = error;
      })
      .finally(() => {
        signal?.removeEventListener('abort', requestTermination);
        resolveTerminationSettled();
      });
  }

  signal?.addEventListener('abort', requestTermination, { once: true });
  if (signal?.aborted) {
    requestTermination();
  }

  return {
    child,
    async waitForExit(): Promise<ManagedProcessExit> {
      const outcome = await leaderExitOutcomePromise;
      if (outcome.kind === 'spawn-error') {
        throw outcome.error;
      }
      return outcome.result;
    },
    async wait(): Promise<ManagedProcessExit> {
      const outcome = await Promise.race([
        closePromise.then((result) => ({ kind: 'closed' as const, result })),
        terminationSettledPromise.then(() => ({ kind: 'termination-settled' as const })),
        spawnErrorPromise.then((error) => ({ kind: 'spawn-error' as const, error })),
      ]);
      if (outcome.kind === 'spawn-error') {
        signal?.removeEventListener('abort', requestTermination);
        throw outcome.error;
      }
      if (outcome.kind === 'closed') {
        if (signal?.aborted) {
          requestTermination();
        } else if (terminationPromise === undefined) {
          signal?.removeEventListener('abort', requestTermination);
        }
        if (terminationPromise !== undefined) {
          await terminationPromise;
        }
      } else {
        await waitForCloseSettlement(closePromise);
      }
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      if (spawnError !== undefined) {
        throw spawnError;
      }
      if (terminationError !== undefined) {
        throw terminationError;
      }
      return outcome.kind === 'closed' ? outcome.result : closePromise;
    },
    async terminate(): Promise<void> {
      requestTermination();
      if (terminationPromise === undefined) {
        await closePromise;
      } else {
        await terminationPromise;
      }
      if (terminationError !== undefined) {
        await waitForCloseSettlement(closePromise);
        throw terminationError;
      }
      await closePromise;
    },
  };
}
