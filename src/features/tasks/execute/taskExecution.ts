/**
 * Task execution logic
 */

import { loadPieceByIdentifier, isPiecePath, loadGlobalConfig } from '../../../infra/config/index.js';
import { TaskRunner, type TaskInfo, autoCommitAndPush } from '../../../infra/task/index.js';
import {
  header,
  info,
  error,
  success,
  status,
  blankLine,
} from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { executePiece } from './pieceExecution.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';
import type { TaskExecutionOptions, ExecuteTaskOptions } from './types.js';
import { createPullRequest, buildPrBody, pushBranch, fetchIssue, checkGhCli } from '../../../infra/github/index.js';
import { runWithWorkerPool } from './parallelExecution.js';
import { resolveTaskExecution } from './resolveTask.js';

export type { TaskExecutionOptions, ExecuteTaskOptions };

const log = createLogger('task');

/**
 * Resolve a GitHub issue from task data's issue number.
 * Returns issue array for buildPrBody, or undefined if no issue or gh CLI unavailable.
 */
function resolveTaskIssue(issueNumber: number | undefined): ReturnType<typeof fetchIssue>[] | undefined {
  if (issueNumber === undefined) {
    return undefined;
  }

  const ghStatus = checkGhCli();
  if (!ghStatus.available) {
    log.info('gh CLI unavailable, skipping issue resolution for PR body', { issueNumber });
    return undefined;
  }

  try {
    const issue = fetchIssue(issueNumber);
    return [issue];
  } catch (e) {
    log.info('Failed to fetch issue for PR body, continuing without issue info', { issueNumber, error: getErrorMessage(e) });
    return undefined;
  }
}

/**
 * Execute a single task with piece.
 */
export async function executeTask(options: ExecuteTaskOptions): Promise<boolean> {
  const { task, cwd, pieceIdentifier, projectCwd, agentOverrides, interactiveUserInput, interactiveMetadata, startMovement, retryNote, abortSignal, taskPrefix, taskColorIndex } = options;
  const pieceConfig = loadPieceByIdentifier(pieceIdentifier, projectCwd);

  if (!pieceConfig) {
    if (isPiecePath(pieceIdentifier)) {
      error(`Piece file not found: ${pieceIdentifier}`);
    } else {
      error(`Piece "${pieceIdentifier}" not found.`);
      info('Available pieces are in ~/.takt/pieces/ or .takt/pieces/');
      info('Use "takt switch" to select a piece.');
    }
    return false;
  }

  log.debug('Running piece', {
    name: pieceConfig.name,
    movements: pieceConfig.movements.map((s: { name: string }) => s.name),
  });

  const globalConfig = loadGlobalConfig();
  const result = await executePiece(pieceConfig, task, cwd, {
    projectCwd,
    language: globalConfig.language,
    provider: agentOverrides?.provider,
    model: agentOverrides?.model,
    interactiveUserInput,
    interactiveMetadata,
    startMovement,
    retryNote,
    abortSignal,
    taskPrefix,
    taskColorIndex,
  });
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
  parallelOptions?: { abortSignal?: AbortSignal; taskPrefix?: string; taskColorIndex?: number },
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const executionLog: string[] = [];

  try {
    const { execCwd, execPiece, isWorktree, branch, baseBranch, startMovement, retryNote, autoPr, issueNumber } = await resolveTaskExecution(task, cwd, pieceName);

    // cwd is always the project root; pass it as projectCwd so reports/sessions go there
    const taskSuccess = await executeTask({
      task: task.content,
      cwd: execCwd,
      pieceIdentifier: execPiece,
      projectCwd: cwd,
      agentOverrides: options,
      startMovement,
      retryNote,
      abortSignal: parallelOptions?.abortSignal,
      taskPrefix: parallelOptions?.taskPrefix,
      taskColorIndex: parallelOptions?.taskColorIndex,
    });
    const completedAt = new Date().toISOString();

    if (taskSuccess && isWorktree) {
      const commitResult = autoCommitAndPush(execCwd, task.name, cwd);
      if (commitResult.success && commitResult.commitHash) {
        info(`Auto-committed & pushed: ${commitResult.commitHash}`);
      } else if (!commitResult.success) {
        error(`Auto-commit failed: ${commitResult.message}`);
      }

      // Create PR if autoPr is enabled and commit succeeded
      if (commitResult.success && commitResult.commitHash && branch && autoPr) {
        info('Creating pull request...');
        // Push branch from project cwd to origin
        try {
          pushBranch(cwd, branch);
        } catch (pushError) {
          // Branch may already be pushed, continue to PR creation
          log.info('Branch push from project cwd failed (may already exist)', { error: pushError });
        }
        const issues = resolveTaskIssue(issueNumber);
        const prBody = buildPrBody(issues, `Piece \`${execPiece}\` completed successfully.`);
        const prResult = createPullRequest(cwd, {
          branch,
          title: task.name.length > 100 ? `${task.name.slice(0, 97)}...` : task.name,
          body: prBody,
          base: baseBranch,
        });
        if (prResult.success) {
          success(`PR created: ${prResult.url}`);
        } else {
          error(`PR creation failed: ${prResult.error}`);
        }
      }
    }

    const taskResult = {
      task,
      success: taskSuccess,
      response: taskSuccess ? 'Task completed successfully' : 'Task failed',
      executionLog,
      startedAt,
      completedAt,
    };

    if (taskSuccess) {
      taskRunner.completeTask(taskResult);
      success(`Task "${task.name}" completed`);
    } else {
      taskRunner.failTask(taskResult);
      error(`Task "${task.name}" failed`);
    }

    return taskSuccess;
  } catch (err) {
    const completedAt = new Date().toISOString();

    taskRunner.failTask({
      task,
      success: false,
      response: getErrorMessage(err),
      executionLog,
      startedAt,
      completedAt,
    });

    error(`Task "${task.name}" error: ${getErrorMessage(err)}`);
    return false;
  }
}

/**
 * Run all pending tasks from .takt/tasks/
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
  const globalConfig = loadGlobalConfig();
  const concurrency = globalConfig.concurrency;

  const initialTasks = taskRunner.claimNextTasks(concurrency);

  if (initialTasks.length === 0) {
    info('No pending tasks in .takt/tasks/');
    info('Create task files as .takt/tasks/*.yaml or use takt add');
    return;
  }

  header('Running tasks');
  if (concurrency > 1) {
    info(`Concurrency: ${concurrency}`);
  }

  const result = await runWithWorkerPool(taskRunner, initialTasks, concurrency, cwd, pieceName, options, globalConfig.taskPollIntervalMs);

  const totalCount = result.success + result.fail;
  blankLine();
  header('Tasks Summary');
  status('Total', String(totalCount));
  status('Success', String(result.success), result.success === totalCount ? 'green' : undefined);
  if (result.fail > 0) {
    status('Failed', String(result.fail), 'red');
  }
}

// Re-export for backward compatibility with existing consumers
export { resolveTaskExecution } from './resolveTask.js';
