/**
 * Task execution logic
 */

import { loadPieceByIdentifier, isPiecePath, loadGlobalConfig } from '../../../infra/config/index.js';
import { TaskRunner, type TaskInfo, createSharedClone, autoCommitAndPush, summarizeTaskName, getCurrentBranch } from '../../../infra/task/index.js';
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
import { createPullRequest, buildPrBody, pushBranch } from '../../../infra/github/index.js';

export type { TaskExecutionOptions, ExecuteTaskOptions };

const log = createLogger('task');

/**
 * Execute a single task with piece.
 */
export async function executeTask(options: ExecuteTaskOptions): Promise<boolean> {
  const { task, cwd, pieceIdentifier, projectCwd, agentOverrides, interactiveUserInput, interactiveMetadata, startMovement, retryNote } = options;
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
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const executionLog: string[] = [];

  try {
    const { execCwd, execPiece, isWorktree, branch, baseBranch, startMovement, retryNote, autoPr } = await resolveTaskExecution(task, cwd, pieceName);

    // cwd is always the project root; pass it as projectCwd so reports/sessions go there
    const taskSuccess = await executeTask({
      task: task.content,
      cwd: execCwd,
      pieceIdentifier: execPiece,
      projectCwd: cwd,
      agentOverrides: options,
      startMovement,
      retryNote,
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
        const prBody = buildPrBody(undefined, `Task "${task.name}" completed successfully.`);
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
 * タスクを動的に取得する。各タスク実行前に次のタスクを取得するため、
 * 実行中にタスクファイルが追加・削除されても反映される。
 */
export async function runAllTasks(
  cwd: string,
  pieceName: string = DEFAULT_PIECE_NAME,
  options?: TaskExecutionOptions,
): Promise<void> {
  const taskRunner = new TaskRunner(cwd);

  // 最初のタスクを取得
  let task = taskRunner.getNextTask();

  if (!task) {
    info('No pending tasks in .takt/tasks/');
    info('Create task files as .takt/tasks/*.yaml or use takt add');
    return;
  }

  header('Running tasks');

  let successCount = 0;
  let failCount = 0;

  while (task) {
    blankLine();
    info(`=== Task: ${task.name} ===`);
    blankLine();

    const taskSuccess = await executeAndCompleteTask(task, taskRunner, cwd, pieceName, options);

    if (taskSuccess) {
      successCount++;
    } else {
      failCount++;
    }

    // 次のタスクを動的に取得（新しく追加されたタスクも含む）
    task = taskRunner.getNextTask();
  }

  const totalCount = successCount + failCount;
  blankLine();
  header('Tasks Summary');
  status('Total', String(totalCount));
  status('Success', String(successCount), successCount === totalCount ? 'green' : undefined);
  if (failCount > 0) {
    status('Failed', String(failCount), 'red');
  }
}

/**
 * Resolve execution directory and piece from task data.
 * If the task has worktree settings, create a shared clone and use it as cwd.
 * Task name is summarized to English by AI for use in branch/clone names.
 */
export async function resolveTaskExecution(
  task: TaskInfo,
  defaultCwd: string,
  defaultPiece: string
): Promise<{ execCwd: string; execPiece: string; isWorktree: boolean; branch?: string; baseBranch?: string; startMovement?: string; retryNote?: string; autoPr?: boolean }> {
  const data = task.data;

  // No structured data: use defaults
  if (!data) {
    return { execCwd: defaultCwd, execPiece: defaultPiece, isWorktree: false };
  }

  let execCwd = defaultCwd;
  let isWorktree = false;
  let branch: string | undefined;
  let baseBranch: string | undefined;

  // Handle worktree (now creates a shared clone)
  if (data.worktree) {
    baseBranch = getCurrentBranch(defaultCwd);
    // Summarize task content to English slug using AI
    info('Generating branch name...');
    const taskSlug = await summarizeTaskName(task.content, { cwd: defaultCwd });

    info('Creating clone...');
    const result = createSharedClone(defaultCwd, {
      worktree: data.worktree,
      branch: data.branch,
      taskSlug,
      issueNumber: data.issue,
    });
    execCwd = result.path;
    branch = result.branch;
    isWorktree = true;
    info(`Clone created: ${result.path} (branch: ${result.branch})`);
  }

  // Handle piece override
  const execPiece = data.piece || defaultPiece;

  // Handle start_movement override
  const startMovement = data.start_movement;

  // Handle retry_note
  const retryNote = data.retry_note;

  // Handle auto_pr (task YAML > global config)
  let autoPr: boolean | undefined;
  if (data.auto_pr !== undefined) {
    autoPr = data.auto_pr;
  } else {
    const globalConfig = loadGlobalConfig();
    autoPr = globalConfig.autoPr;
  }

  return { execCwd, execPiece, isWorktree, branch, baseBranch, startMovement, retryNote, autoPr };
}
