/**
 * Task execution logic
 */

import { loadPieceByIdentifier, isPiecePath, resolvePieceConfigValues } from '../../../infra/config/index.js';
import { resolveProviderOptionsWithTrace } from '../../../infra/config/resolveConfigValue.js';
import { TaskRunner, type TaskInfo } from '../../../infra/task/index.js';
import { info, error } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { executePiece } from './pieceExecution.js';
import type { TaskExecutionOptions, ExecuteTaskOptions, PieceExecutionResult } from './types.js';
import { resolveTaskExecution, resolveTaskIssue } from './resolveTask.js';
import { postExecutionFlow } from './postExecution.js';
import { buildBooleanTaskResult, buildTaskResult, persistExceededTaskResult, persistTaskError, persistPrFailedTaskResult, persistTaskResult } from './taskResultHandler.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';

export type { TaskExecutionOptions, ExecuteTaskOptions };

const log = createLogger('task');

type TaskExecutionParallelOptions = {
  abortSignal?: AbortSignal;
  taskPrefix?: string;
  taskColorIndex?: number;
  taskDisplayLabel?: string;
};

async function executeTaskWithResult(options: ExecuteTaskOptions): Promise<PieceExecutionResult> {
  const {
    task,
    cwd,
    pieceIdentifier,
    projectCwd,
    agentOverrides,
    interactiveUserInput,
    pieceUserInputHandler,
    interactiveMetadata,
    startMovement,
    retryNote,
    reportDirName,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
    maxMovementsOverride,
    initialIterationOverride,
  } = options;
  const pieceConfig = loadPieceByIdentifier(pieceIdentifier, projectCwd);
  const safePieceIdentifier = sanitizeTerminalText(pieceIdentifier);

  if (!pieceConfig) {
    if (isPiecePath(pieceIdentifier)) {
      error(`Workflow file not found: ${safePieceIdentifier}`);
      return { success: false, reason: `Workflow file not found: ${safePieceIdentifier}` };
    } else {
      error(`Workflow "${safePieceIdentifier}" not found.`);
      info('Available workflows are searched in .takt/workflows/, .takt/pieces/, ~/.takt/workflows/, then ~/.takt/pieces/.');
      info('If the same workflow name exists in multiple locations, project workflows/ take priority over project pieces/, then user workflows/, then user pieces/.');
      info('Specify a valid workflow when creating tasks (e.g., via "takt add").');
      return { success: false, reason: `Workflow "${safePieceIdentifier}" not found.` };
    }
  }

  log.debug('Running piece', {
    name: pieceConfig.name,
    movements: pieceConfig.movements.map((s: { name: string }) => s.name),
  });

  const config = resolvePieceConfigValues(projectCwd, ['language', 'personaProviders', 'providerProfiles']);
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  return await executePiece(pieceConfig, task, cwd, {
    projectCwd,
    language: config.language,
    provider: agentOverrides?.provider,
    model: agentOverrides?.model,
    providerOptions: providerOptions.value,
    providerOptionsSource: providerOptions.source,
    providerOptionsOriginResolver: providerOptions.originResolver,
    personaProviders: config.personaProviders,
    providerProfiles: config.providerProfiles,
    interactiveUserInput,
    pieceUserInputHandler,
    interactiveMetadata,
    startMovement,
    retryNote,
    reportDirName,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
    maxMovementsOverride,
    initialIterationOverride,
  });
}

/**
 * Execute a single task with piece.
 */
export async function executeTask(options: ExecuteTaskOptions): Promise<boolean> {
  const result = await executeTaskWithResult(options);
  return result.success;
}

/**
 * Execute a task: resolve clone → run piece → auto-commit+push → remove clone → record completion.
 *
 * Shared by runAllTasks() and watchTasks() to avoid duplicated
 * resolve → execute → autoCommit → complete logic.
 *
 * @returns true if the task succeeded
 */
export async function executeAndCompleteTask(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const taskAbortController = new AbortController();
  const externalAbortSignal = parallelOptions?.abortSignal;
  const taskAbortSignal = externalAbortSignal ? taskAbortController.signal : undefined;

  const onExternalAbort = (): void => {
    taskAbortController.abort();
  };

  if (externalAbortSignal) {
    if (externalAbortSignal.aborted) {
      taskAbortController.abort();
    } else {
      externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const {
      execCwd,
      execPiece,
      isWorktree,
      taskPrompt,
      reportDirName,
      branch,
      worktreePath,
      baseBranch,
      startMovement,
      retryNote,
      autoPr,
      draftPr,
      shouldPublishBranchToOrigin,
      issueNumber,
      maxMovementsOverride,
      initialIterationOverride,
    } = await resolveTaskExecution(task, cwd, taskAbortSignal);

    const projectRootCwd = cwd;
    const taskRunResult = await executeTaskWithResult({
      task: taskPrompt ?? task.content,
      cwd: execCwd,
      pieceIdentifier: execPiece,
      projectCwd: projectRootCwd,
      agentOverrides: taskExecutionOptions,
      startMovement,
      retryNote,
      reportDirName,
      abortSignal: taskAbortSignal,
      taskPrefix: parallelOptions?.taskPrefix,
      taskColorIndex: parallelOptions?.taskColorIndex,
      taskDisplayLabel: parallelOptions?.taskDisplayLabel,
      maxMovementsOverride,
      initialIterationOverride,
    });

    if (taskRunResult.exceeded && taskRunResult.exceededInfo) {
      persistExceededTaskResult(taskRunner, task, taskRunResult.exceededInfo, {
        worktreePath,
        branch,
      });
      return false;
    }

    const taskSuccess = taskRunResult.success;
    const completedAt = new Date().toISOString();

    let prUrl: string | undefined;
    let prFailedError: string | undefined;
    let postExecutionTaskError: string | undefined;
    if (taskSuccess && isWorktree) {
      const issues = resolveTaskIssue(issueNumber, projectRootCwd);
      const postResult = await postExecutionFlow({
        execCwd,
        projectCwd: projectRootCwd,
        task: task.name,
        branch,
        baseBranch,
        shouldCreatePr: autoPr,
        shouldPublishBranchToOrigin,
        draftPr,
        pieceIdentifier: execPiece,
        issues,
      });
      prUrl = postResult.prUrl;
      if (postResult.prFailed) {
        prFailedError = postResult.prError;
      }
      if (postResult.taskFailed) {
        postExecutionTaskError = postResult.taskError;
      }
    }

    if (postExecutionTaskError !== undefined) {
      const taskResult = buildBooleanTaskResult({
        task,
        taskSuccess: false,
        startedAt,
        completedAt,
        successResponse: 'Task completed successfully',
        failureResponse: postExecutionTaskError,
        branch,
        worktreePath,
      });
      persistTaskResult(taskRunner, taskResult);
      return false;
    }

    const taskResult = buildTaskResult({
      task,
      runResult: taskRunResult,
      startedAt,
      completedAt,
      branch,
      worktreePath,
      prUrl,
    });

    if (prFailedError !== undefined) {
      persistPrFailedTaskResult(taskRunner, taskResult, prFailedError);
      return true;
    }

    persistTaskResult(taskRunner, taskResult);

    return taskRunResult.success;
  } catch (err) {
    const completedAt = new Date().toISOString();
    persistTaskError(taskRunner, task, startedAt, completedAt, err);
    return false;
  } finally {
    if (externalAbortSignal) {
      externalAbortSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
