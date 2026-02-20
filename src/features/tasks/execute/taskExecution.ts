/**
 * Task execution logic
 */

import { loadPieceByIdentifier, isPiecePath, resolveConfigValueWithSource, resolvePieceConfigValues } from '../../../infra/config/index.js';
import { TaskRunner, type TaskInfo } from '../../../infra/task/index.js';
import {
  header,
  info,
  error,
  status,
  blankLine,
} from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage, getSlackWebhookUrl, notifyError, notifySuccess, sendSlackNotification, buildSlackRunSummary } from '../../../shared/utils/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { executePiece } from './pieceExecution.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';
import type { TaskExecutionOptions, ExecuteTaskOptions, PieceExecutionResult } from './types.js';
import { runWithWorkerPool } from './parallelExecution.js';
import { resolveTaskExecution, resolveTaskIssue } from './resolveTask.js';
import { postExecutionFlow } from './postExecution.js';
import { buildTaskResult, persistTaskError, persistTaskResult } from './taskResultHandler.js';
import { generateRunId, toSlackTaskDetail } from './slackSummaryAdapter.js';

export type { TaskExecutionOptions, ExecuteTaskOptions };

const log = createLogger('task');

async function executeTaskWithResult(options: ExecuteTaskOptions): Promise<PieceExecutionResult> {
  const {
    task,
    cwd,
    pieceIdentifier,
    projectCwd,
    agentOverrides,
    interactiveUserInput,
    interactiveMetadata,
    startMovement,
    retryNote,
    reportDirName,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
  } = options;
  const pieceConfig = loadPieceByIdentifier(pieceIdentifier, projectCwd);

  if (!pieceConfig) {
    if (isPiecePath(pieceIdentifier)) {
      error(`Piece file not found: ${pieceIdentifier}`);
      return { success: false, reason: `Piece file not found: ${pieceIdentifier}` };
    } else {
      error(`Piece "${pieceIdentifier}" not found.`);
      info('Available pieces are in ~/.takt/pieces/ or .takt/pieces/');
      info('Use "takt switch" to select a piece.');
      return { success: false, reason: `Piece "${pieceIdentifier}" not found.` };
    }
  }

  log.debug('Running piece', {
    name: pieceConfig.name,
    movements: pieceConfig.movements.map((s: { name: string }) => s.name),
  });

  const config = resolvePieceConfigValues(projectCwd, [
    'language',
    'provider',
    'model',
    'personaProviders',
    'providerProfiles',
  ]);
  const providerOptions = resolveConfigValueWithSource(projectCwd, 'providerOptions');
  return await executePiece(pieceConfig, task, cwd, {
    projectCwd,
    language: config.language,
    provider: agentOverrides?.provider ?? config.provider,
    model: agentOverrides?.model ?? config.model,
    providerOptions: providerOptions.value,
    providerOptionsSource: providerOptions.source === 'piece' ? 'global' : providerOptions.source,
    personaProviders: config.personaProviders,
    providerProfiles: config.providerProfiles,
    interactiveUserInput,
    interactiveMetadata,
    startMovement,
    retryNote,
    reportDirName,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
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
  pieceName: string,
  options?: TaskExecutionOptions,
  parallelOptions?: { abortSignal?: AbortSignal; taskPrefix?: string; taskColorIndex?: number; taskDisplayLabel?: string },
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
      issueNumber,
    } = await resolveTaskExecution(task, cwd, pieceName, taskAbortSignal);

    // cwd is always the project root; pass it as projectCwd so reports/sessions go there
    const taskRunResult = await executeTaskWithResult({
      task: taskPrompt ?? task.content,
      cwd: execCwd,
      pieceIdentifier: execPiece,
      projectCwd: cwd,
      agentOverrides: options,
      startMovement,
      retryNote,
      reportDirName,
      abortSignal: taskAbortSignal,
      taskPrefix: parallelOptions?.taskPrefix,
      taskColorIndex: parallelOptions?.taskColorIndex,
      taskDisplayLabel: parallelOptions?.taskDisplayLabel,
    });

    const taskSuccess = taskRunResult.success;
    const completedAt = new Date().toISOString();

    let prUrl: string | undefined;
    if (taskSuccess && isWorktree) {
      const issues = resolveTaskIssue(issueNumber);
      const postResult = await postExecutionFlow({
        execCwd,
        projectCwd: cwd,
        task: task.name,
        branch,
        baseBranch,
        shouldCreatePr: autoPr,
        draftPr,
        pieceIdentifier: execPiece,
        issues,
      });
      prUrl = postResult.prUrl;
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
    persistTaskResult(taskRunner, taskResult);

    return taskSuccess;
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

/**
 * Run all pending tasks from .takt/tasks.yaml
 *
 * Uses a worker pool for both sequential (concurrency=1) and parallel
 * (concurrency>1) execution through the same code path.
 */
export async function runAllTasks(
  cwd: string,
  pieceName: string = DEFAULT_PIECE_NAME,
  options?: TaskExecutionOptions,
): Promise<void> {
  const taskRunner = new TaskRunner(cwd);
  const globalConfig = resolvePieceConfigValues(
    cwd,
    ['notificationSound', 'notificationSoundEvents', 'concurrency', 'taskPollIntervalMs'],
  );
  const shouldNotifyRunComplete = globalConfig.notificationSound !== false
    && globalConfig.notificationSoundEvents?.runComplete !== false;
  const shouldNotifyRunAbort = globalConfig.notificationSound !== false
    && globalConfig.notificationSoundEvents?.runAbort !== false;
  const concurrency = globalConfig.concurrency;
  const slackWebhookUrl = getSlackWebhookUrl();
  const recovered = taskRunner.recoverInterruptedRunningTasks();
  if (recovered > 0) {
    info(`Recovered ${recovered} interrupted running task(s) to pending.`);
  }

  const initialTasks = taskRunner.claimNextTasks(concurrency);

  if (initialTasks.length === 0) {
    info('No pending tasks in .takt/tasks.yaml');
    info('Use takt add to append tasks.');
    return;
  }

  const runId = generateRunId();
  const startTime = Date.now();

  header('Running tasks');
  if (concurrency > 1) {
    info(`Concurrency: ${concurrency}`);
  }

  const sendSlackSummary = async (): Promise<void> => {
    if (!slackWebhookUrl) return;
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const tasks = taskRunner.listAllTaskItems().map(toSlackTaskDetail);
    const successCount = tasks.filter((t) => t.success).length;
    const message = buildSlackRunSummary({
      runId,
      total: tasks.length,
      success: successCount,
      failed: tasks.length - successCount,
      durationSec,
      concurrency,
      tasks,
    });
    await sendSlackNotification(slackWebhookUrl, message);
  };

  try {
    const result = await runWithWorkerPool(taskRunner, initialTasks, concurrency, cwd, pieceName, options, globalConfig.taskPollIntervalMs);

    const totalCount = result.success + result.fail;
    blankLine();
    header('Tasks Summary');
    status('Total', String(totalCount));
    status('Success', String(result.success), result.success === totalCount ? 'green' : undefined);
    if (result.fail > 0) {
      status('Failed', String(result.fail), 'red');
      if (shouldNotifyRunAbort) {
        notifyError('TAKT', getLabel('run.notifyAbort', undefined, { failed: String(result.fail) }));
      }
      await sendSlackSummary();
      return;
    }

    if (shouldNotifyRunComplete) {
      notifySuccess('TAKT', getLabel('run.notifyComplete', undefined, { total: String(totalCount) }));
    }
    await sendSlackSummary();
  } catch (e) {
    if (shouldNotifyRunAbort) {
      notifyError('TAKT', getLabel('run.notifyAbort', undefined, { failed: getErrorMessage(e) }));
    }
    await sendSlackSummary();
    throw e;
  }
}
