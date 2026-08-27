import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, fchmodSync, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import type { CentralTaskRecord, CentralTaskRepository } from '../../infra/task/centralStateRepository.js';

export const CENTRAL_OWNER_TOKEN_ENV = 'TAKT_CENTRAL_OWNER_TOKEN';
export const CENTRAL_STATE_ID_ENV = 'TAKT_CENTRAL_STATE_ID';
export const CENTRAL_TASK_ID_ENV = 'TAKT_CENTRAL_TASK_ID';
export const CENTRAL_EXECUTION_ID_ENV = 'TAKT_CENTRAL_EXECUTION_ID';
export const CENTRAL_GENERATION_ENV = 'TAKT_CENTRAL_GENERATION';

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function buildWorkerArguments(workerEntryPath: string, input: {
  readonly stateId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly executionId: string;
}): string[] {
  return [
    workerEntryPath,
    '--state-id', input.stateId,
    '--task-id', input.taskId,
    '--generation', String(input.generation),
    '--execution-id', input.executionId,
  ];
}

export function buildCentralWorkerStderrPath(
  eventsDirectory: string,
  taskId: string,
  executionId: string,
): string {
  return join(eventsDirectory, `worker-${taskId}-${executionId}.stderr.log`);
}

export interface SpawnCentralWorkerOptions {
  readonly workerEntryPath: string;
  readonly projectDirectory: string;
  readonly globalConfigDirectory: string;
  readonly stateId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly executionId: string;
  readonly ownerToken: string;
  /** Durable central-state diagnostics for failures before worker adoption. */
  readonly stderrPath?: string;
  readonly spawnProcess?: SpawnProcess;
}

export interface SpawnedCentralWorker {
  readonly child: ChildProcess;
  readonly pid: number;
}

export interface CentralWorkerReservation {
  readonly taskId: string;
  readonly generation: number;
  readonly executionId: string;
  readonly ownerToken: string;
  readonly runId?: string;
}

export class CentralWorkerStartupError extends Error {
  readonly code = 'CENTRAL_WORKER_STARTUP_FAILED';
  readonly recoveryRequired: boolean;

  constructor(message: string, recoveryRequired = false) {
    super(message);
    this.recoveryRequired = recoveryRequired;
  }
}

export function centralWorkerHasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function isSameStartingReservation(
  task: CentralTaskRecord | undefined,
  input: CentralWorkerReservation,
): boolean {
  return task?.status === 'starting'
    && task.generation === input.generation
    && task.activeExecution?.executionId === input.executionId;
}

function isAdoptedReservation(
  task: CentralTaskRecord | undefined,
  input: CentralWorkerReservation,
): boolean {
  return task?.status === 'running'
    && task.generation === input.generation + 1
    && task.activeExecution?.executionId === input.executionId;
}

function isTerminalReservation(
  task: CentralTaskRecord | undefined,
  input: CentralWorkerReservation,
): boolean {
  return (task?.status === 'completed' || task?.status === 'failed')
    && task.runIds.at(-1) === input.runId
    && task.generation >= input.generation + 2;
}

/**
 * Keep the initial launcher subscribed after HTTP returns. A child that exits
 * before adoption is terminalized immediately by the reservation CAS rather
 * than waiting for a later request or reconciliation pass.
 */
export function monitorCentralStartupExit(
  repository: Pick<CentralTaskRepository, 'readTask' | 'failStarting'>,
  input: CentralWorkerReservation,
  child: ChildProcess,
): () => void {
  let completed = false;
  let retryCount = 0;
  const recover = async (): Promise<void> => {
    if (completed) return;
    const current = await repository.readTask(input.taskId).catch(() => undefined);
    if (current === undefined && retryCount < 8) {
      retryCount += 1;
      setImmediate(() => void recover());
      return;
    }
    completed = true;
    if (!isSameStartingReservation(current, input)) return;
    await repository.failStarting({
      taskId: input.taskId,
      generation: input.generation,
      executionId: input.executionId,
      ownerToken: input.ownerToken,
      message: 'Central worker exited before adopting its startup reservation',
    }).catch(() => undefined);
  };
  const onExit = (): void => {
    void recover();
  };
  child.once('exit', onExit);
  if (centralWorkerHasExited(child)) queueMicrotask(() => void recover());
  return () => {
    completed = true;
    child.off('exit', onExit);
  };
}

/** Wait for a successor to commit running/terminal state before its parent exits. */
export async function waitForCentralWorkerStartup(
  repository: Pick<CentralTaskRepository, 'readTask' | 'failStarting'>,
  input: CentralWorkerReservation,
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<'adopted' | 'terminal'> {
  let exited = centralWorkerHasExited(child);
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const onExit = (): void => {
    exited = true;
    resolveExit();
  };
  child.once('exit', onExit);
  try {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await repository.readTask(input.taskId);
      if (isAdoptedReservation(current, input)) return 'adopted';
      if (isTerminalReservation(current, input)) return 'terminal';
      if (exited) {
        if (current === undefined) {
          if (Date.now() >= deadline) {
            throw new CentralWorkerStartupError(
              'Central successor exited while its reservation was unavailable; recovery is required',
              true,
            );
          }
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
          continue;
        }
        if (isSameStartingReservation(current, input)) {
          await repository.failStarting({
            taskId: input.taskId,
            generation: input.generation,
            executionId: input.executionId,
            ownerToken: input.ownerToken,
            message: 'Central worker exited before adopting its startup reservation',
          }).catch(() => undefined);
          throw new CentralWorkerStartupError('Central successor exited before adopting its startup reservation');
        }
        throw new CentralWorkerStartupError('Central successor reservation changed before startup adoption', true);
      }
      if (Date.now() >= deadline) {
        throw new CentralWorkerStartupError(
          'Central successor did not acknowledge startup before the deadline; recovery is required',
          true,
        );
      }
      await Promise.race([
        exitPromise,
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25)),
      ]);
      exited ||= centralWorkerHasExited(child);
    }
  } finally {
    child.off('exit', onExit);
  }
}

export function waitForSpawn(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => rejectPromise(error);
    child.once('error', onError);
    child.once('spawn', () => {
      child.off('error', onError);
      const pid = child.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        rejectPromise(new Error('Central worker started without a process id'));
        return;
      }
      child.unref();
      resolvePromise(pid);
    });
  });
}

function openCentralWorkerStderr(stderrPath: string): number {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(stderrPath, 'wx', 0o600);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new CentralWorkerStartupError('Central worker diagnostics must be a regular file');
    }
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

/**
 * The owner token is deliberately present only in this private worker handoff
 * environment. It is never included in argv or the persisted task ledger.
 */
export async function spawnCentralWorker(
  options: SpawnCentralWorkerOptions,
): Promise<SpawnedCentralWorker> {
  const spawnProcess = options.spawnProcess ?? spawn;
  let stderrFd: number | undefined;
  try {
    if (options.stderrPath !== undefined) {
      stderrFd = openCentralWorkerStderr(options.stderrPath);
    }
    const child = spawnProcess(
      process.execPath,
      buildWorkerArguments(options.workerEntryPath, options),
      {
        cwd: options.projectDirectory,
        detached: true,
        shell: false,
        stdio: stderrFd === undefined ? 'ignore' : ['ignore', 'ignore', stderrFd],
        env: {
          ...buildChildProcessEnv(process.env, { centralExecution: true }),
          TAKT_CONFIG_DIR: options.globalConfigDirectory,
          [CENTRAL_OWNER_TOKEN_ENV]: options.ownerToken,
          [CENTRAL_STATE_ID_ENV]: options.stateId,
          [CENTRAL_TASK_ID_ENV]: options.taskId,
          [CENTRAL_EXECUTION_ID_ENV]: options.executionId,
          [CENTRAL_GENERATION_ENV]: String(options.generation),
        },
      },
    );
    const pid = await waitForSpawn(child);
    return { child, pid };
  } finally {
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
}
