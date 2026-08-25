import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { registerProject, type RegisteredProject } from '../../infra/config/global/projectRegistry.js';
import { CentralTaskRepository, type CentralWorktreeRequest } from '../../infra/task/centralStateRepository.js';
import {
  buildCentralWorkerStderrPath,
  buildWorkerArguments,
  CENTRAL_EXECUTION_ID_ENV,
  CENTRAL_GENERATION_ENV,
  CENTRAL_OWNER_TOKEN_ENV,
  CENTRAL_STATE_ID_ENV,
  CENTRAL_TASK_ID_ENV,
  centralWorkerHasExited,
  monitorCentralStartupExit,
  spawnCentralWorker,
  type SpawnProcess,
} from './central-worker-spawn.js';

const MAX_PROMPT_LENGTH = 64 * 1024;
const MAX_WORKFLOW_LENGTH = 512;

export interface LaunchRequest {
  readonly prompt: string;
  readonly workflow: string;
  readonly worktree?: CentralWorktreeRequest;
}

export interface LaunchResult {
  readonly pid: number;
  readonly disposition: 'started' | 'reused';
  readonly mode: 'run' | 'watch';
}

export {
  buildWorkerArguments,
  CENTRAL_EXECUTION_ID_ENV,
  CENTRAL_GENERATION_ENV,
  CENTRAL_OWNER_TOKEN_ENV,
  CENTRAL_STATE_ID_ENV,
  CENTRAL_TASK_ID_ENV,
};
export type { SpawnProcess } from './central-worker-spawn.js';

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength || trimmed.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

function parseWorktree(value: unknown): CentralWorktreeRequest {
  if (value === undefined) return true;
  if (value === false || value === true) return value;
  if (typeof value === 'string' && !value.includes('\0')) {
    const trimmed = value.trim();
    const segments = trimmed.split(/[\\/]+/u);
    if (
      trimmed.length > 0
      && trimmed.length <= 4096
      && (isAbsolute(trimmed) || !segments.includes('..'))
    ) return trimmed;
  }
  throw new Error('worktree must be false, true, or a safe path');
}

export function parseLaunchRequest(value: unknown): LaunchRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  const raw = value as Readonly<Record<string, unknown>>;
  return {
    prompt: requireText(raw.prompt, 'prompt', MAX_PROMPT_LENGTH),
    workflow: requireText(raw.workflow, 'workflow', MAX_WORKFLOW_LENGTH),
    worktree: parseWorktree(raw.worktree),
  };
}

function resolveProject(options: {
  readonly globalConfigDirectory: string;
  readonly projectDirectory: string;
  readonly registeredProject?: RegisteredProject;
}): Promise<RegisteredProject> {
  if (options.registeredProject !== undefined) return Promise.resolve(options.registeredProject);
  return registerProject({
    globalConfigDirectory: options.globalConfigDirectory,
    projectDirectory: options.projectDirectory,
    command: 'ui',
  });
}

export async function launchTaktRun(options: {
  readonly workerEntryPath?: string;
  readonly projectDirectory: string;
  readonly globalConfigDirectory?: string;
  readonly registeredProject?: RegisteredProject;
  readonly request: LaunchRequest;
  readonly spawnProcess: SpawnProcess;
}): Promise<LaunchResult> {
  const globalConfigDirectory = options.globalConfigDirectory ?? getGlobalConfigDir();
  const project = await resolveProject({
    globalConfigDirectory,
    projectDirectory: options.projectDirectory,
    ...(options.registeredProject === undefined ? {} : { registeredProject: options.registeredProject }),
  });
  const repository = await CentralTaskRepository.open({
    globalConfigDirectory,
    stateId: project.stateId,
    locationId: project.locationId,
    canonicalDirectory: project.canonicalDirectory,
    displayName: project.displayName,
    fingerprint: project.fingerprint,
  });
  // Reconcile only provably dead or PID-reused workers before making the
  // enqueue/start decision. A live worker with unknown identity remains owned.
  await repository.reconcile();
  const decision = await repository.enqueueOrReuse({
    task: options.request.prompt,
    workflow: options.request.workflow,
    worktree: options.request.worktree ?? true,
  });
  if (decision.kind === 'reused') {
    return {
      pid: decision.active?.pid ?? 0,
      disposition: 'reused',
      mode: 'run',
    };
  }

  const workerEntryPath = options.workerEntryPath
    ?? fileURLToPath(new URL('./worker-entry.js', import.meta.url));
  const task = decision.task;
  const ownerToken = decision.ownerToken;
  if (ownerToken === undefined || decision.executionId === undefined) {
    throw new Error('Central worker reservation is incomplete');
  }
  let child: ChildProcess | undefined;
  let spawnAcknowledged = false;
  try {
    const spawned = await spawnCentralWorker({
      workerEntryPath,
      projectDirectory: project.canonicalDirectory,
      globalConfigDirectory,
      stateId: project.stateId,
      taskId: task.taskId,
      generation: task.generation,
      executionId: decision.executionId,
      ownerToken,
      stderrPath: buildCentralWorkerStderrPath(
        repository.paths.eventsDirectory,
        task.taskId,
        decision.executionId,
      ),
      spawnProcess: options.spawnProcess,
    });
    child = spawned.child;
    spawnAcknowledged = true;
    monitorCentralStartupExit(repository, {
      taskId: task.taskId,
      generation: task.generation,
      executionId: decision.executionId,
      ownerToken,
      runId: task.runId,
    }, child);
    await repository.setStartingPid({
      taskId: task.taskId,
      generation: task.generation,
      executionId: decision.executionId,
      ownerToken,
      pid: spawned.pid,
      runId: task.runId,
    });
    return { pid: spawned.pid, disposition: 'started', mode: 'run' };
  } catch (error) {
    const current = await repository.readTask(task.taskId).catch(() => undefined);
    const childIsActive = spawnAcknowledged
      && child !== undefined
      && !centralWorkerHasExited(child);
    if (!childIsActive && current?.status === 'starting' && current.generation === task.generation) {
      await repository.failStarting({
        taskId: task.taskId,
        generation: task.generation,
        executionId: decision.executionId,
        ownerToken,
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    throw error;
  }
}

export function launchWithNodeSpawn(options: Omit<Parameters<typeof launchTaktRun>[0], 'spawnProcess'>): Promise<LaunchResult> {
  return launchTaktRun({ ...options, spawnProcess: spawn });
}
