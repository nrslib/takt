import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { assertValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { registerProject, type RegisteredProject } from '../../infra/config/global/projectRegistry.js';
import {
  CentralTaskRepository,
  type CentralTaskLaunchDecision,
  type CentralWorktreeRequest,
} from '../../infra/task/centralStateRepository.js';
import {
  CentralTaskActionError,
  enrichTaskActionConversationContext,
  executeCentralTaskAction,
  type CentralTaskAction,
  type CentralTaskActionResult,
} from './task-actions.js';
import type { WebChatService, WebTaskActionClaim, WebTaskActionKind } from './chat.js';
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
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly autoPr?: boolean;
  readonly draftPr?: boolean;
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

function parseOptionalBranch(value: unknown, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  const branch = requireText(value, label, 255);
  try {
    assertValidLocalBranchName(branch);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  return branch;
}

function parseBoolean(value: unknown, label: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

export function parseLaunchRequest(value: unknown): LaunchRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  const raw = value as Readonly<Record<string, unknown>>;
  const worktree = parseWorktree(raw.worktree);
  const branch = parseOptionalBranch(raw.branch, 'branch');
  const baseBranch = parseOptionalBranch(raw.baseBranch, 'baseBranch');
  const autoPr = parseBoolean(raw.autoPr, 'autoPr', false);
  const draftPr = parseBoolean(raw.draftPr, 'draftPr', false);
  if (autoPr && worktree === false) throw new Error('autoPr requires worktree');
  if (draftPr && !autoPr) throw new Error('draftPr requires autoPr');
  return {
    prompt: requireText(raw.prompt, 'prompt', MAX_PROMPT_LENGTH),
    workflow: requireText(raw.workflow, 'workflow', MAX_WORKFLOW_LENGTH),
    worktree,
    ...(branch === undefined ? {} : { branch }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    autoPr,
    draftPr,
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

export async function openProjectRepository(
  globalConfigDirectory: string,
  project: RegisteredProject,
): Promise<CentralTaskRepository> {
  const repository = await CentralTaskRepository.open({
    globalConfigDirectory,
    stateId: project.stateId,
    locationId: project.locationId,
    canonicalDirectory: project.canonicalDirectory,
    displayName: project.displayName,
    fingerprint: project.fingerprint,
  });
  await repository.reconcile();
  return repository;
}

export async function spawnReservedDecision(options: {
  readonly workerEntryPath?: string;
  readonly globalConfigDirectory: string;
  readonly project: RegisteredProject;
  readonly repository: CentralTaskRepository;
  readonly decision: CentralTaskLaunchDecision;
  readonly spawnProcess: SpawnProcess;
}): Promise<LaunchResult> {
  const { decision, repository, project, globalConfigDirectory } = options;
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
  if (ownerToken === undefined || decision.executionId === undefined || decision.runId === undefined) {
    throw new Error('Central worker reservation is incomplete');
  }
  const runId = decision.runId;
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
      runId,
    }, child);
    await repository.setStartingPid({
      taskId: task.taskId,
      generation: task.generation,
      executionId: decision.executionId,
      ownerToken,
      pid: spawned.pid,
      runId,
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
  const repository = await openProjectRepository(globalConfigDirectory, project);
  const decision = await repository.enqueueOrReuse({
    task: options.request.prompt,
    workflow: options.request.workflow,
    worktree: options.request.worktree ?? true,
    ...(options.request.branch === undefined ? {} : { branch: options.request.branch }),
    ...(options.request.baseBranch === undefined ? {} : { baseBranch: options.request.baseBranch }),
    autoPr: options.request.autoPr ?? false,
    draftPr: options.request.draftPr ?? false,
  });
  return spawnReservedDecision({
    ...(options.workerEntryPath === undefined ? {} : { workerEntryPath: options.workerEntryPath }),
    globalConfigDirectory,
    project,
    repository,
    decision,
    spawnProcess: options.spawnProcess,
  });
}

export async function requeueTaktTask(options: {
  readonly workerEntryPath?: string;
  readonly projectDirectory: string;
  readonly globalConfigDirectory?: string;
  readonly registeredProject?: RegisteredProject;
  readonly taskId: string;
  readonly spawnProcess: SpawnProcess;
}): Promise<LaunchResult> {
  const globalConfigDirectory = options.globalConfigDirectory ?? getGlobalConfigDir();
  const project = await resolveProject({
    globalConfigDirectory,
    projectDirectory: options.projectDirectory,
    ...(options.registeredProject === undefined ? {} : { registeredProject: options.registeredProject }),
  });
  const repository = await openProjectRepository(globalConfigDirectory, project);
  const decision = await repository.requeueFailedTask(options.taskId);
  return spawnReservedDecision({
    ...(options.workerEntryPath === undefined ? {} : { workerEntryPath: options.workerEntryPath }),
    globalConfigDirectory,
    project,
    repository,
    decision,
    spawnProcess: options.spawnProcess,
  });
}

export function launchWithNodeSpawn(options: Omit<Parameters<typeof launchTaktRun>[0], 'spawnProcess'>): Promise<LaunchResult> {
  return launchTaktRun({ ...options, spawnProcess: spawn });
}

export function requeueWithNodeSpawn(options: Omit<Parameters<typeof requeueTaktTask>[0], 'spawnProcess'>): Promise<LaunchResult> {
  return requeueTaktTask({ ...options, spawnProcess: spawn });
}

/**
 * Execute an action against the central ledger selected by the registered
 * project. Unlike the legacy requeue endpoint this never constructs a
 * project-local TaskRunner or touches tasks.yaml.
 */
export async function executeCentralTaskActionWithNodeSpawn(options: {
  readonly projectDirectory: string;
  readonly globalConfigDirectory?: string;
  readonly registeredProject?: RegisteredProject;
  readonly taskId: string;
  readonly action: CentralTaskAction;
  readonly input?: string;
  readonly conversationId?: string;
  readonly taskActionClaim?: WebTaskActionClaim;
}): Promise<CentralTaskActionResult> {
  const globalConfigDirectory = options.globalConfigDirectory ?? getGlobalConfigDir();
  const project = await resolveProject({
    globalConfigDirectory,
    projectDirectory: options.projectDirectory,
    ...(options.registeredProject === undefined ? {} : { registeredProject: options.registeredProject }),
  });
  const repository = await openProjectRepository(globalConfigDirectory, project);
  const task = await repository.readTask(options.taskId);
  if (task === undefined) {
    throw new CentralTaskActionError('Central task was not found', 404);
  }
  return executeCentralTaskAction({
    globalConfigDirectory,
    projectDirectory: project.canonicalDirectory,
    projectId: project.id,
    repository,
    task,
    action: options.action,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    ...(options.taskActionClaim === undefined ? {} : { taskActionClaim: options.taskActionClaim }),
    spawnDecision: (decision, decisionRepository) => spawnReservedDecision({
      globalConfigDirectory,
      project,
      repository: decisionRepository,
      decision,
      spawnProcess: spawn,
    }),
  });
}

/** Open retry/instruct without mutating the central task until the user uses /go. */
export async function startCentralTaskActionConversation(options: {
  readonly projectDirectory: string;
  readonly globalConfigDirectory?: string;
  readonly registeredProject?: RegisteredProject;
  readonly taskId: string;
  readonly action: WebTaskActionKind;
  readonly chat: WebChatService;
}): Promise<CentralTaskActionResult> {
  const globalConfigDirectory = options.globalConfigDirectory ?? getGlobalConfigDir();
  const project = await resolveProject({
    globalConfigDirectory,
    projectDirectory: options.projectDirectory,
    ...(options.registeredProject === undefined ? {} : { registeredProject: options.registeredProject }),
  });
  const repository = await openProjectRepository(globalConfigDirectory, project);
  const task = await repository.readTask(options.taskId);
  if (task === undefined) throw new CentralTaskActionError('Central task was not found', 404);
  const enriched = await enrichTaskActionConversationContext(
    task,
    options.action,
    project.canonicalDirectory,
    repository,
  );
  const context = {
    ...enriched,
    projectId: project.id,
    stateId: project.stateId,
    projectDirectory: project.canonicalDirectory,
  } as const;
  const createTaskAction = options.chat.createTaskAction;
  if (createTaskAction === undefined) {
    throw new CentralTaskActionError('Task action conversation is unavailable after Web UI restart', 501);
  }
  const conversationCwd = context.worktreePath ?? project.canonicalDirectory;
  const chatSession = createTaskAction(conversationCwd, context);
  return {
    action: options.action,
    taskId: task.taskId,
    status: 'conversation',
    taskStatus: context.status as CentralTaskActionResult['taskStatus'],
    chatSession,
  };
}
