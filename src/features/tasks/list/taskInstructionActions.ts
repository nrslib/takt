/**
 * Instruction actions for completed/failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and direct re-execution.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  TaskRunner,
  detectDefaultBranch,
} from '../../../infra/task/index.js';
import { loadGlobalConfig, getPieceDescription } from '../../../infra/config/index.js';
import { info, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { runInstructMode } from './instructMode.js';
import { selectPiece } from '../../pieceSelection/index.js';
import { dispatchConversationAction } from '../../interactive/actionDispatcher.js';
import type { PieceContext } from '../../interactive/interactive.js';
import { resolveLanguage } from '../../interactive/index.js';
import { type BranchActionTarget, resolveTargetBranch } from './taskActionTarget.js';
import { appendRetryNote, selectRunSessionContext } from './requeueHelpers.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';

const log = createLogger('list-tasks');

function getBranchContext(projectDir: string, branch: string): string {
  const defaultBranch = detectDefaultBranch(projectDir);
  const lines: string[] = [];

  try {
    const diffStat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    if (diffStat) {
      lines.push('## 現在の変更内容（mainからの差分）');
      lines.push('```');
      lines.push(diffStat);
      lines.push('```');
    }
  } catch (err) {
    log.debug('Failed to collect branch diff stat for instruction context', {
      branch,
      defaultBranch,
      error: getErrorMessage(err),
    });
  }

  try {
    const commitLog = execFileSync(
      'git', ['log', '--oneline', `${defaultBranch}..${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    if (commitLog) {
      lines.push('');
      lines.push('## コミット履歴');
      lines.push('```');
      lines.push(commitLog);
      lines.push('```');
    }
  } catch (err) {
    log.debug('Failed to collect branch commit log for instruction context', {
      branch,
      defaultBranch,
      error: getErrorMessage(err),
    });
  }

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

export async function instructBranch(
  projectDir: string,
  target: BranchActionTarget,
): Promise<boolean> {
  if (!('kind' in target)) {
    throw new Error('Instruct requeue requires a task target.');
  }

  if (!target.worktreePath || !fs.existsSync(target.worktreePath)) {
    logError(`Worktree directory does not exist for task: ${target.name}`);
    return false;
  }
  const worktreePath = target.worktreePath;

  const branch = resolveTargetBranch(target);

  const selectedPiece = await selectPiece(projectDir);
  if (!selectedPiece) {
    info('Cancelled');
    return false;
  }

  const globalConfig = loadGlobalConfig();
  const pieceDesc = getPieceDescription(selectedPiece, projectDir, globalConfig.interactivePreviewMovements);
  const pieceContext: PieceContext = {
    name: pieceDesc.name,
    description: pieceDesc.description,
    pieceStructure: pieceDesc.pieceStructure,
    movementPreviews: pieceDesc.movementPreviews,
  };

  const lang = resolveLanguage(globalConfig.language);
  // Runs data lives in the worktree (written during previous execution)
  const runSessionContext = await selectRunSessionContext(worktreePath, lang);

  const branchContext = getBranchContext(projectDir, branch);

  const result = await runInstructMode(
    worktreePath, branchContext, branch,
    target.name, target.content, target.data?.retry_note ?? '',
    pieceContext, runSessionContext,
  );

  const executeWithInstruction = async (instruction: string): Promise<boolean> => {
    const retryNote = appendRetryNote(target.data?.retry_note, instruction);
    const runner = new TaskRunner(projectDir);
    const taskInfo = runner.startReExecution(target.name, ['completed', 'failed'], undefined, retryNote);

    log.info('Starting re-execution of instructed task', {
      name: target.name,
      worktreePath,
      branch,
      piece: selectedPiece,
    });

    return executeAndCompleteTask(taskInfo, runner, projectDir, selectedPiece);
  };

  return dispatchConversationAction(result, {
    cancel: () => {
      info('Cancelled');
      return false;
    },
    execute: async ({ task }) => executeWithInstruction(task),
    save_task: async ({ task }) => {
      const retryNote = appendRetryNote(target.data?.retry_note, task);
      const runner = new TaskRunner(projectDir);
      runner.requeueTask(target.name, ['completed', 'failed'], undefined, retryNote);
      info(`Task "${target.name}" has been requeued.`);
      return true;
    },
  });
}
