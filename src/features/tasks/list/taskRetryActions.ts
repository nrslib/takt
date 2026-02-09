/**
 * Retry actions for failed tasks.
 *
 * Provides interactive retry functionality including
 * failure info display and movement selection.
 */

import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner } from '../../../infra/task/index.js';
import { loadPieceByIdentifier, loadGlobalConfig } from '../../../infra/config/index.js';
import { selectOption, promptInput } from '../../../shared/prompt/index.js';
import { success, error as logError, info, header, blankLine, status } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { PieceConfig } from '../../../core/models/index.js';

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

/**
 * Retry a failed task.
 *
 * @returns true if task was requeued, false if cancelled
 */
export async function retryFailedTask(
  task: TaskListItem,
  projectDir: string,
): Promise<boolean> {
  displayFailureInfo(task);

  const pieceName = task.data?.piece ?? loadGlobalConfig().defaultPiece ?? 'default';
  const pieceConfig = loadPieceByIdentifier(pieceName, projectDir);

  if (!pieceConfig) {
    logError(`Piece "${pieceName}" not found. Cannot determine available movements.`);
    return false;
  }

  const selectedMovement = await selectStartMovement(pieceConfig, task.failure?.movement ?? null);
  if (selectedMovement === null) {
    return false;
  }

  blankLine();
  const retryNote = await promptInput('Retry note (optional, press Enter to skip):');
  const trimmedNote = retryNote?.trim();

  try {
    const runner = new TaskRunner(projectDir);
    const startMovement = selectedMovement !== pieceConfig.initialMovement
      ? selectedMovement
      : undefined;

    runner.requeueFailedTask(task.name, startMovement, trimmedNote || undefined);

    success(`Task requeued: ${task.name}`);
    if (startMovement) {
      info(`  Will start from: ${startMovement}`);
    }
    if (trimmedNote) {
      info(`  Retry note: ${trimmedNote}`);
    }
    info(`  File: ${task.filePath}`);

    log.info('Requeued failed task', {
      name: task.name,
      tasksFile: task.filePath,
      startMovement,
      retryNote: trimmedNote,
    });

    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Failed to requeue task: ${msg}`);
    log.error('Failed to requeue task', { name: task.name, error: msg });
    return false;
  }
}
