/**
 * Retry actions for failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and direct re-execution.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import * as fs from 'node:fs';
import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner } from '../../../infra/task/index.js';
import { loadPieceByIdentifier, loadGlobalConfig, getPieceDescription } from '../../../infra/config/index.js';
import { selectPiece } from '../../pieceSelection/index.js';
import { selectOption } from '../../../shared/prompt/index.js';
import { info, header, blankLine, status } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { PieceConfig } from '../../../core/models/index.js';
import {
  findRunForTask,
  loadRunSessionContext,
  getRunPaths,
  formatRunSessionForPrompt,
  runRetryMode,
  type RetryContext,
  type RetryFailureInfo,
  type RetryRunInfo,
} from '../../interactive/index.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import { appendRetryNote } from './requeueHelpers.js';

const log = createLogger('list-tasks');

function displayFailureInfo(task: TaskListItem): void {
  header(`Failed Task: ${task.name}`);
  info(`  Failed at: ${task.createdAt}`);

  if (task.failure) {
    blankLine();
    if (task.failure.movement) {
      status('Failed at', task.failure.movement, 'red');
    }
    status('Error', task.failure.error, 'red');
    if (task.failure.last_message) {
      status('Last message', task.failure.last_message);
    }
  }

  blankLine();
}

async function selectStartMovement(
  pieceConfig: PieceConfig,
  defaultMovement: string | null,
): Promise<string | null> {
  const movements = pieceConfig.movements.map((m) => m.name);

  const defaultIdx = defaultMovement
    ? movements.indexOf(defaultMovement)
    : 0;
  const effectiveDefault = defaultIdx >= 0 ? movements[defaultIdx] : movements[0];

  const options = movements.map((name) => ({
    label: name === effectiveDefault ? `${name} (default)` : name,
    value: name,
    description: name === pieceConfig.initialMovement ? 'Initial movement' : undefined,
  }));

  return await selectOption<string>('Start from movement:', options);
}

function buildRetryFailureInfo(task: TaskListItem): RetryFailureInfo {
  return {
    taskName: task.name,
    taskContent: task.content,
    createdAt: task.createdAt,
    failedMovement: task.failure?.movement ?? '',
    error: task.failure?.error ?? '',
    lastMessage: task.failure?.last_message ?? '',
    retryNote: task.data?.retry_note ?? '',
  };
}

function buildRetryRunInfo(
  runsBaseDir: string,
  slug: string,
): RetryRunInfo {
  const paths = getRunPaths(runsBaseDir, slug);
  const sessionContext = loadRunSessionContext(runsBaseDir, slug);
  const formatted = formatRunSessionForPrompt(sessionContext);
  return {
    logsDir: paths.logsDir,
    reportsDir: paths.reportsDir,
    task: formatted.runTask,
    piece: formatted.runPiece,
    status: formatted.runStatus,
    movementLogs: formatted.runMovementLogs,
    reports: formatted.runReports,
  };
}

function resolveWorktreePath(task: TaskListItem): string {
  if (!task.worktreePath) {
    throw new Error(`Worktree path is not set for task: ${task.name}`);
  }
  if (!fs.existsSync(task.worktreePath)) {
    throw new Error(`Worktree directory does not exist: ${task.worktreePath}`);
  }
  return task.worktreePath;
}

/**
 * Retry a failed task.
 *
 * Runs the retry conversation in the existing worktree, then directly
 * re-executes the task there (auto-commit + push + status update).
 *
 * @returns true if task was re-executed successfully, false if cancelled or failed
 */
export async function retryFailedTask(
  task: TaskListItem,
  projectDir: string,
): Promise<boolean> {
  if (task.kind !== 'failed') {
    throw new Error(`retryFailedTask requires failed task. received: ${task.kind}`);
  }

  const worktreePath = resolveWorktreePath(task);

  displayFailureInfo(task);

  const selectedPiece = await selectPiece(projectDir);
  if (!selectedPiece) {
    info('Cancelled');
    return false;
  }

  const globalConfig = loadGlobalConfig();
  const pieceConfig = loadPieceByIdentifier(selectedPiece, projectDir);

  if (!pieceConfig) {
    throw new Error(`Piece "${selectedPiece}" not found after selection.`);
  }

  const selectedMovement = await selectStartMovement(pieceConfig, task.failure?.movement ?? null);
  if (selectedMovement === null) {
    return false;
  }

  const pieceDesc = getPieceDescription(selectedPiece, projectDir, globalConfig.interactivePreviewMovements);
  const pieceContext = {
    name: pieceDesc.name,
    description: pieceDesc.description,
    pieceStructure: pieceDesc.pieceStructure,
    movementPreviews: pieceDesc.movementPreviews,
  };

  // Runs data lives in the worktree (written during previous execution)
  const matchedSlug = findRunForTask(worktreePath, task.content);
  const runInfo = matchedSlug ? buildRetryRunInfo(worktreePath, matchedSlug) : null;

  blankLine();
  const branchName = task.branch ?? task.name;
  const retryContext: RetryContext = {
    failure: buildRetryFailureInfo(task),
    branchName,
    pieceContext,
    run: runInfo,
  };

  const retryResult = await runRetryMode(worktreePath, retryContext);
  if (retryResult.action === 'cancel') {
    return false;
  }

  const startMovement = selectedMovement !== pieceConfig.initialMovement
    ? selectedMovement
    : undefined;
  const retryNote = appendRetryNote(task.data?.retry_note, retryResult.task);
  const runner = new TaskRunner(projectDir);

  if (retryResult.action === 'save_task') {
    runner.requeueTask(task.name, ['failed'], startMovement, retryNote);
    info(`Task "${task.name}" has been requeued.`);
    return true;
  }

  const taskInfo = runner.startReExecution(task.name, ['failed'], startMovement, retryNote);

  log.info('Starting re-execution of failed task', {
    name: task.name,
    worktreePath,
    startMovement,
  });

  return executeAndCompleteTask(taskInfo, runner, projectDir, selectedPiece);
}
