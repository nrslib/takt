import { execFileSync } from 'node:child_process';
import {
  createTempCloneForBranch,
  removeClone,
  removeCloneMeta,
  TaskRunner,
} from '../../../infra/task/index.js';
import { loadGlobalConfig, getPieceDescription } from '../../../infra/config/index.js';
import { info, success, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { executeTask } from '../execute/taskExecution.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import { buildBooleanTaskResult, persistTaskError, persistTaskResult } from '../execute/taskResultHandler.js';
import { runInstructMode } from './instructMode.js';
import { saveTaskFile } from '../add/index.js';
import { selectPiece } from '../../pieceSelection/index.js';
import { dispatchConversationAction } from '../../interactive/actionDispatcher.js';
import type { PieceContext } from '../../interactive/interactive.js';
import { type BranchActionTarget, resolveTargetBranch, resolveTargetWorktreePath } from './taskActionTarget.js';
import { detectDefaultBranch, autoCommitAndPush } from '../../../infra/task/index.js';

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
  options?: TaskExecutionOptions,
): Promise<boolean> {
  const branch = resolveTargetBranch(target);
  const worktreePath = resolveTargetWorktreePath(target);

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

  const branchContext = getBranchContext(projectDir, branch);
  const result = await runInstructMode(projectDir, branchContext, branch, pieceContext);

  return dispatchConversationAction(result, {
    cancel: () => {
      info('Cancelled');
      return false;
    },
    save_task: async ({ task }) => {
      const created = await saveTaskFile(projectDir, task, {
        piece: selectedPiece,
        worktree: true,
        branch,
        autoPr: false,
      });
      success(`Task saved: ${created.taskName}`);
      info(`  Branch: ${branch}`);
      log.info('Task saved from instruct mode', { branch, piece: selectedPiece });
      return true;
    },
    execute: async ({ task }) => {
      log.info('Instructing branch via temp clone', { branch, piece: selectedPiece });
      info(`Running instruction on ${branch}...`);

      const clone = createTempCloneForBranch(projectDir, branch);
      const fullInstruction = branchContext
        ? `${branchContext}## 追加指示\n${task}`
        : task;

      const runner = new TaskRunner(projectDir);
      const taskRecord = runner.addTask(fullInstruction, {
        piece: selectedPiece,
        worktree: true,
        branch,
        auto_pr: false,
        ...(worktreePath ? { worktree_path: worktreePath } : {}),
      });
      const startedAt = new Date().toISOString();

      try {
        const taskSuccess = await executeTask({
          task: fullInstruction,
          cwd: clone.path,
          pieceIdentifier: selectedPiece,
          projectCwd: projectDir,
          agentOverrides: options,
        });

        const completedAt = new Date().toISOString();
        const taskResult = buildBooleanTaskResult({
          task: taskRecord,
          taskSuccess,
          successResponse: 'Instruction completed',
          failureResponse: 'Instruction failed',
          startedAt,
          completedAt,
          branch,
          ...(worktreePath ? { worktreePath } : {}),
        });
        persistTaskResult(runner, taskResult, { emitStatusLog: false });

        if (taskSuccess) {
          const commitResult = autoCommitAndPush(clone.path, task, projectDir);
          if (commitResult.success && commitResult.commitHash) {
            success(`Auto-committed & pushed: ${commitResult.commitHash}`);
          } else if (!commitResult.success) {
            logError(`Auto-commit failed: ${commitResult.message}`);
          }

          success(`Instruction completed on ${branch}`);
          log.info('Instruction completed', { branch });
        } else {
          logError(`Instruction failed on ${branch}`);
          log.error('Instruction failed', { branch });
        }

        return taskSuccess;
      } catch (err) {
        const completedAt = new Date().toISOString();
        persistTaskError(runner, taskRecord, startedAt, completedAt, err, {
          emitStatusLog: false,
          responsePrefix: 'Instruction failed: ',
        });
        logError(`Instruction failed on ${branch}`);
        log.error('Instruction crashed', { branch, error: getErrorMessage(err) });
        throw err;
      } finally {
        removeClone(clone.path);
        removeCloneMeta(projectDir, branch);
      }
    },
  });
}
