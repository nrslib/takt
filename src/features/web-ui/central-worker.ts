import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSharedCloneAbortable } from '../../infra/task/clone.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { resolveCentralWorktree } from '../../infra/task/centralWorktree.js';
import { enterCentralExecution } from '../../shared/utils/child-process-env.js';
import {
  CentralTaskRepository,
  type CentralTaskRecord,
} from '../../infra/task/centralStateRepository.js';
import { assertCentralWorktreeOwnership } from '../../infra/task/centralWorktreeOwnership.js';
import {
  CENTRAL_EXECUTION_ID_ENV,
  CENTRAL_GENERATION_ENV,
  CENTRAL_OWNER_TOKEN_ENV,
  CENTRAL_STATE_ID_ENV,
  CENTRAL_TASK_ID_ENV,
  centralWorkerHasExited,
  buildCentralWorkerStderrPath,
  waitForCentralWorkerStartup,
} from './central-worker-spawn.js';
import {
  spawnCentralWorker,
  type SpawnProcess,
} from './central-worker-spawn.js';

export interface CentralWorkerInput {
  readonly globalConfigDirectory: string;
  readonly stateId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly executionId: string;
  readonly ownerToken: string;
}

interface CentralWorkerRunOptions {
  readonly workerEntryPath?: string;
  readonly spawnProcess?: SpawnProcess;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.includes('\0')) throw new Error(`${name} is missing`);
  delete process.env[name];
  return value;
}

export function readCentralWorkerInput(argv: readonly string[] = process.argv): CentralWorkerInput {
  const value = (name: string): string => {
    const index = argv.indexOf(name);
    if (index < 0 || argv[index + 1] === undefined) throw new Error(`${name} is missing`);
    return argv[index + 1]!;
  };
  const generation = Number(value('--generation'));
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('--generation is invalid');
  const input = {
    globalConfigDirectory: process.env.TAKT_CONFIG_DIR,
    stateId: value('--state-id'),
    taskId: value('--task-id'),
    generation,
    executionId: value('--execution-id'),
    ownerToken: requireEnvironment(CENTRAL_OWNER_TOKEN_ENV),
  };
  if (input.globalConfigDirectory === undefined || input.globalConfigDirectory.length === 0) throw new Error('TAKT_CONFIG_DIR is missing');
  delete process.env.TAKT_CONFIG_DIR;
  return { ...input, globalConfigDirectory: input.globalConfigDirectory };
}

export async function runCentralTask(
  input: CentralWorkerInput,
  options: CentralWorkerRunOptions = {},
): Promise<void> {
  const restoreChildBoundary = enterCentralExecution();
  process.env.TAKT_CONFIG_DIR = input.globalConfigDirectory;
  try {
    const repository = await CentralTaskRepository.openByState({
      globalConfigDirectory: input.globalConfigDirectory,
      stateId: input.stateId,
    });
    const task = await repository.readTask(input.taskId);
    if (task === undefined) throw new Error('Central task was not found');
    const adopted = await repository.adoptVerified({
      taskId: input.taskId,
      generation: input.generation,
      executionId: input.executionId,
      ownerToken: input.ownerToken,
    });
    let primaryError: unknown;
    try {
      await executeAndCommit(repository, adopted, input.ownerToken);
    } catch (error) {
      primaryError = error;
    }
    try {
      await spawnNextCentralTask(repository, options);
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }
    if (primaryError !== undefined) throw primaryError;
  } finally {
    restoreChildBoundary();
    delete process.env.TAKT_CONFIG_DIR;
  }
}

/**
 * A worker owns one exact task. After terminalizing it, it may reserve and
 * spawn one successor. The reservation CAS is the single spawn gate shared
 * with HTTP enqueue/reconcile callers.
 */
async function spawnNextCentralTask(
  repository: CentralTaskRepository,
  options: CentralWorkerRunOptions,
): Promise<void> {
  const next = await repository.claimNextPending();
  if (next === undefined) return;
  const workerEntryPath = options.workerEntryPath
    ?? fileURLToPath(new URL('./worker-entry.js', import.meta.url));
  let child: import('node:child_process').ChildProcess | undefined;
  let acknowledged = false;
  try {
    const spawned = await spawnCentralWorker({
      workerEntryPath,
      projectDirectory: repository.locations.projectDirectory,
      globalConfigDirectory: repository.globalConfigDirectory,
      stateId: repository.state.stateId,
      taskId: next.task.taskId,
      generation: next.task.generation,
      executionId: next.executionId,
      ownerToken: next.ownerToken,
      stderrPath: buildCentralWorkerStderrPath(
        repository.paths.eventsDirectory,
        next.task.taskId,
        next.executionId,
      ),
      spawnProcess: options.spawnProcess ?? spawn,
    });
    child = spawned.child;
    acknowledged = true;
    await repository.setStartingPid({
      taskId: next.task.taskId,
      generation: next.task.generation,
      executionId: next.executionId,
      ownerToken: next.ownerToken,
      pid: spawned.pid,
      runId: next.runId,
    });
    await waitForCentralWorkerStartup(repository, {
      taskId: next.task.taskId,
      generation: next.task.generation,
      executionId: next.executionId,
      ownerToken: next.ownerToken,
      runId: next.runId,
    }, spawned.child);
  } catch (error) {
    const current = await repository.readTask(next.task.taskId).catch(() => undefined);
    const childIsActive = acknowledged
      && child !== undefined
      && !centralWorkerHasExited(child);
    if (!childIsActive && current?.status === 'starting' && current.generation === next.task.generation) {
      await repository.failStarting({
        taskId: next.task.taskId,
        generation: next.task.generation,
        executionId: next.executionId,
        ownerToken: next.ownerToken,
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function executeAndCommit(
  repository: CentralTaskRepository,
  task: CentralTaskRecord,
  ownerToken: string,
): Promise<void> {
  let terminalized = false;
  try {
    const runId = task.activeExecution?.runId;
    if (runId === undefined) throw new Error('Central task run id is missing');
    // These checks belong to the same failure boundary as the execution. The
    // workflow lifecycle owns run directory/meta publication; the worker owns
    // only the central task ledger and must not project a competing meta file.
    await repository.verifyProjectIdentity();
    let executionCwd = repository.locations.projectDirectory;
    let branch: string | undefined;
    if (task.worktree !== false) {
      await repository.verifyProjectIdentity();
      // A terminal re-execution must reuse the worktree recorded by the
      // central ledger.  Falling back to a new clone here would split the
      // ownership boundary and could execute against an unrelated checkout.
      if (task.attempt > 1 || task.worktreePath !== undefined) {
        const owned = assertCentralWorktreeOwnership(
          repository.locations.projectDirectory,
          repository.globalConfigDirectory,
          repository.state.stateId,
          task,
        );
        executionCwd = owned.worktreePath;
        branch = owned.branch;
      } else {
        const configured = resolveConfigValue(repository.locations.projectDirectory, 'worktreeDir');
        const worktree = resolveCentralWorktree({
          request: task.worktree,
          projectDirectory: repository.locations.projectDirectory,
          executionDirectory: repository.locations.executionDirectory,
          globalConfigDirectory: repository.globalConfigDirectory,
          stateId: repository.state.stateId,
          ...(configured === undefined ? {} : { configuredWorktreeDirectory: configured }),
        });
        if (worktree.baseDirectory === undefined) throw new Error('Central worktree path is missing');
        const clone = await createSharedCloneAbortable(repository.locations.projectDirectory, {
          worktree: task.worktree,
          worktreeBaseDirectory: worktree.baseDirectory,
          ...(worktree.cloneMetadataDirectory === undefined ? {} : { cloneMetadataDirectory: worktree.cloneMetadataDirectory }),
          skipProjectLocalTaktSync: true,
          taskSlug: task.taskId.slice(0, 12),
          ...(task.branch === undefined ? {} : { branch: task.branch }),
          ...(task.baseBranch === undefined ? {} : { baseBranch: task.baseBranch }),
        });
        executionCwd = clone.path;
        branch = clone.branch;
      }
    }
    await repository.updateExecutionContext({
      taskId: task.taskId,
      generation: task.generation,
      executionId: task.activeExecution!.executionId,
      ownerToken,
      worktreePath: executionCwd,
      ...(branch === undefined ? {} : { branch }),
    });
    // Providers are loaded only after the private owner token was consumed by
    // the worker entrypoint. The workflow run itself writes below state/runs.
    const { runWorkflowExecution } = await import('../tasks/execute/workflowExecutionApi.js');
    const executionRequest = task.executionRequest;
    const result = await runWorkflowExecution({
      task: task.task,
      cwd: executionCwd,
      projectCwd: repository.locations.projectDirectory,
      workflowIdentifier: task.workflow,
      ...(executionRequest?.startStep === undefined ? {} : { startStep: executionRequest.startStep }),
      ...(executionRequest?.resumePoint === undefined ? {} : { resumePoint: executionRequest.resumePoint }),
      ...(executionRequest?.restartPoint === undefined ? {} : { restartPoint: executionRequest.restartPoint }),
      ...(executionRequest?.retryNote === undefined ? {} : { retryNote: executionRequest.retryNote }),
      ...(executionRequest === undefined ? {} : {
        resumeSource: {
          resumeMode: executionRequest.resumeMode,
          ...(executionRequest.sourceRunSlug === undefined
            ? {}
            : { sourceRunSlug: executionRequest.sourceRunSlug }),
        },
      }),
      outputMode: 'silent',
      reportDirName: runId,
      runPathsDirectory: repository.paths.runsDirectory,
      sessionStorageDirectory: repository.paths.sessionsDirectory,
      skipWorktreeRuntimeProtection: true,
    });
    let postExecutionFailure: { readonly code: string; readonly message: string } | undefined;
    let prUrl: string | undefined;
    if (result.success && task.worktree !== false) {
      const { postExecutionFlow } = await import('../tasks/execute/postExecution.js');
      const postResult = await postExecutionFlow({
        execCwd: executionCwd,
        projectCwd: repository.locations.projectDirectory,
        task: task.task,
        ...(branch === undefined ? {} : { branch }),
        ...(task.baseBranch === undefined ? {} : { baseBranch: task.baseBranch }),
        shouldCreatePr: task.autoPr === true,
        draftPr: task.draftPr === true,
        workflowIdentifier: task.workflow,
        outputMode: 'silent',
      });
      prUrl = postResult.prUrl;
      if (postResult.taskFailed) {
        postExecutionFailure = {
          code: 'post_execution_failed',
          message: postResult.taskError ?? 'Post-execution processing failed',
        };
      } else if (postResult.prFailed) {
        postExecutionFailure = {
          code: 'pr_failed',
          message: postResult.prError ?? 'Pull request creation failed',
        };
      }
    }
    const succeeded = result.success && postExecutionFailure === undefined;
    await repository.terminal({
      taskId: task.taskId,
      generation: task.generation,
      executionId: task.activeExecution!.executionId,
      ownerToken,
      status: succeeded ? 'completed' : 'failed',
      ...(succeeded
        ? {}
        : {
            failure: postExecutionFailure ?? {
              code: 'workflow_failed',
              message: result.reason ?? 'Workflow failed',
            },
          }),
      ...(prUrl === undefined ? {} : { prUrl }),
    });
    terminalized = true;
  } catch (error) {
    if (!terminalized && task.activeExecution !== undefined) {
      await repository.terminal({
        taskId: task.taskId,
        generation: task.generation,
        executionId: task.activeExecution.executionId,
        ownerToken,
        status: 'failed',
        failure: { code: 'worker_failed', message: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function runCentralWorkerFromEnvironment(argv: readonly string[] = process.argv): Promise<void> {
  // Consume all private handoff fields before importing provider/runtime code.
  const input = readCentralWorkerInput(argv);
  delete process.env[CENTRAL_STATE_ID_ENV];
  delete process.env[CENTRAL_TASK_ID_ENV];
  delete process.env[CENTRAL_EXECUTION_ID_ENV];
  delete process.env[CENTRAL_GENERATION_ENV];
  await runCentralTask(input);
}
