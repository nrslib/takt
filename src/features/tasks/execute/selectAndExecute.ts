/**
 * Task execution orchestration.
 *
 * Coordinates piece selection and task execution,
 * auto-commit, and PR creation. Extracted from cli.ts to avoid
 * mixing CLI parsing with business logic.
 */

import {
  loadPieceByIdentifier,
  isPiecePath,
} from '../../../infra/config/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { createSharedClone, summarizeTaskName, resolveBaseBranch, TaskRunner } from '../../../infra/task/index.js';
import { info, error, withProgress } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { executeTask } from './taskExecution.js';
import type { TaskExecutionOptions, WorktreeConfirmationResult, SelectAndExecuteOptions } from './types.js';
import { selectPiece } from '../../pieceSelection/index.js';
import { buildBooleanTaskResult, persistTaskError, persistTaskResult } from './taskResultHandler.js';

export type { WorktreeConfirmationResult, SelectAndExecuteOptions };

const log = createLogger('selectAndExecute');

export async function determinePiece(cwd: string, override?: string): Promise<string | null> {
  if (override) {
    if (isPiecePath(override)) {
      return override;
    }
    const resolvedPiece = loadPieceByIdentifier(override, cwd);
    if (!resolvedPiece) {
      error(`Piece not found: ${override}`);
      return null;
    }
    return override;
  }
  return selectPiece(cwd);
}

export async function confirmAndCreateWorktree(
  cwd: string,
  task: string,
  createWorktreeOverride?: boolean | undefined,
  branchOverride?: string,
): Promise<WorktreeConfirmationResult> {
  const useWorktree =
    typeof createWorktreeOverride === 'boolean'
      ? createWorktreeOverride
      : await confirm('Create worktree?', true);

  if (!useWorktree) {
    return { execCwd: cwd, isWorktree: false };
  }

  const baseBranch = resolveBaseBranch(cwd).branch;

  const taskSlug = await withProgress(
    'Generating branch name...',
    (slug) => `Branch name generated: ${slug}`,
    () => summarizeTaskName(task, { cwd }),
  );

  const result = await withProgress(
    'Creating clone...',
    (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
    async () => createSharedClone(cwd, {
      worktree: true,
      taskSlug,
      ...(branchOverride ? { branch: branchOverride } : {}),
    }),
  );

  return { execCwd: result.path, isWorktree: true, branch: result.branch, baseBranch, taskSlug };
}

/**
 * Execute a task with piece selection.
 * Shared by direct task execution and interactive mode.
 */
export async function selectAndExecuteTask(
  cwd: string,
  task: string,
  options?: SelectAndExecuteOptions,
  agentOverrides?: TaskExecutionOptions,
): Promise<void> {
  const pieceIdentifier = await determinePiece(cwd, options?.piece);

  if (pieceIdentifier === null) {
    info('Cancelled');
    return;
  }

  // execute action always runs in-place (no worktree prompt/creation).
  const execCwd = cwd;
  log.info('Starting task execution', { piece: pieceIdentifier, worktree: false });
  const taskRunner = new TaskRunner(cwd);
  let taskRecord: Awaited<ReturnType<TaskRunner['addTask']>> | null = null;
  if (options?.skipTaskList !== true) {
    taskRecord = taskRunner.addTask(task, {
      piece: pieceIdentifier,
    });
  }
  const startedAt = new Date().toISOString();

  let taskSuccess: boolean;
  try {
    taskSuccess = await executeTask({
      task,
      cwd: execCwd,
      pieceIdentifier,
      projectCwd: cwd,
      agentOverrides,
      interactiveUserInput: options?.interactiveUserInput === true,
      interactiveMetadata: options?.interactiveMetadata,
    });
  } catch (err) {
    const completedAt = new Date().toISOString();
    if (taskRecord) {
      persistTaskError(taskRunner, taskRecord, startedAt, completedAt, err, {
        responsePrefix: 'Task failed: ',
      });
    }
    throw err;
  }

  const completedAt = new Date().toISOString();

  const effectiveSuccess = taskSuccess;
  if (taskRecord) {
    const taskResult = buildBooleanTaskResult({
      task: taskRecord,
      taskSuccess: effectiveSuccess,
      successResponse: 'Task completed successfully',
      failureResponse: 'Task failed',
      startedAt,
      completedAt,
    });
    persistTaskResult(taskRunner, taskResult);
  }

  if (!effectiveSuccess) {
    process.exit(1);
  }
}
