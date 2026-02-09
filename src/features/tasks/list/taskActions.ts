/**
 * Individual actions for branch-based tasks.
 *
 * Provides merge, delete, try-merge, instruct, and diff operations
 * for branches listed by the listTasks command.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import {
  createTempCloneForBranch,
  removeClone,
  removeCloneMeta,
  cleanupOrphanedClone,
  detectDefaultBranch,
  autoCommitAndPush,
  type BranchListItem,
} from '../../../infra/task/index.js';
import { selectOption, promptInput } from '../../../shared/prompt/index.js';
import { info, success, error as logError, warn, header, blankLine } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { executeTask } from '../execute/taskExecution.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import { listPieces, getCurrentPiece } from '../../../infra/config/index.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';
import { encodeWorktreePath } from '../../../infra/config/project/sessionStore.js';

const log = createLogger('list-tasks');

/** Actions available for a listed branch */
export type ListAction = 'diff' | 'instruct' | 'try' | 'merge' | 'delete';

/**
 * Check if a branch has already been merged into HEAD.
 */
export function isBranchMerged(projectDir: string, branch: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], {
    cwd: projectDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.error) {
    log.error('Failed to check if branch is merged', {
      branch,
      error: getErrorMessage(result.error),
    });
    return false;
  }

  return result.status === 0;
}

/**
 * Show full diff in an interactive pager (less).
 * Falls back to direct output if pager is unavailable.
 */
export function showFullDiff(
  cwd: string,
  defaultBranch: string,
  branch: string,
): void {
  try {
    const result = spawnSync(
      'git', ['diff', '--color=always', `${defaultBranch}...${branch}`],
      {
        cwd,
        stdio: 'inherit',
        env: { ...process.env, GIT_PAGER: 'less -R' },
      },
    );
    if (result.status !== 0) {
      warn('Could not display diff');
    }
  } catch (err) {
    warn('Could not display diff');
    log.error('Failed to display full diff', {
      branch,
      defaultBranch,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Show diff stat for a branch and prompt for an action.
 */
export async function showDiffAndPromptAction(
  cwd: string,
  defaultBranch: string,
  item: BranchListItem,
): Promise<ListAction | null> {
  header(item.info.branch);
  if (item.originalInstruction) {
    info(chalk.dim(`  ${item.originalInstruction}`));
  }
  blankLine();

  try {
    const stat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${item.info.branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
    info(stat);
  } catch (err) {
    warn('Could not generate diff stat');
    log.error('Failed to generate diff stat', {
      branch: item.info.branch,
      defaultBranch,
      error: getErrorMessage(err),
    });
  }

  const action = await selectOption<ListAction>(
    `Action for ${item.info.branch}:`,
    [
      { label: 'View diff', value: 'diff', description: 'Show full diff in pager' },
      { label: 'Instruct', value: 'instruct', description: 'Give additional instructions via temp clone' },
      { label: 'Try merge', value: 'try', description: 'Squash merge (stage changes without commit)' },
      { label: 'Merge & cleanup', value: 'merge', description: 'Merge and delete branch' },
      { label: 'Delete', value: 'delete', description: 'Discard changes, delete branch' },
    ],
  );

  return action;
}

/**
 * Try-merge (squash): stage changes from branch without committing.
 */
export function tryMergeBranch(projectDir: string, item: BranchListItem): boolean {
  const { branch } = item.info;

  try {
    execFileSync('git', ['merge', '--squash', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    success(`Squash-merged ${branch} (changes staged, not committed)`);
    info('Run `git status` to see staged changes, `git commit` to finalize, or `git reset` to undo.');
    log.info('Try-merge (squash) completed', { branch });
    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Squash merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Try-merge (squash) failed', { branch, error: msg });
    return false;
  }
}

/**
 * Merge & cleanup: if already merged, skip merge and just delete the branch.
 */
export function mergeBranch(projectDir: string, item: BranchListItem): boolean {
  const { branch } = item.info;
  const alreadyMerged = isBranchMerged(projectDir, branch);

  try {
    if (alreadyMerged) {
      info(`${branch} is already merged, skipping merge.`);
      log.info('Branch already merged, cleanup only', { branch });
    } else {
      execFileSync('git', ['merge', '--no-edit', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_MERGE_AUTOEDIT: 'no',
        },
      });
    }

    try {
      execFileSync('git', ['branch', '-d', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      warn(`Could not delete branch ${branch}. You may delete it manually.`);
      log.error('Failed to delete merged branch', {
        branch,
        error: getErrorMessage(err),
      });
    }

    cleanupOrphanedClone(projectDir, branch);

    success(`Merged & cleaned up ${branch}`);
    log.info('Branch merged & cleaned up', { branch, alreadyMerged });
    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Merge & cleanup failed', { branch, error: msg });
    return false;
  }
}

/**
 * Delete a branch (discard changes).
 * For worktree branches, removes the worktree directory and session file.
 */
export function deleteBranch(projectDir: string, item: BranchListItem): boolean {
  const { branch, worktreePath } = item.info;

  try {
    // If this is a worktree branch, remove the worktree directory and session file
    if (worktreePath) {
      // Remove worktree directory if it exists
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
        log.info('Removed worktree directory', { worktreePath });
      }

      // Remove worktree-session file
      const encodedPath = encodeWorktreePath(worktreePath);
      const sessionFile = join(projectDir, '.takt', 'worktree-sessions', `${encodedPath}.json`);
      if (existsSync(sessionFile)) {
        unlinkSync(sessionFile);
        log.info('Removed worktree-session file', { sessionFile });
      }

      success(`Deleted worktree ${branch}`);
      log.info('Worktree branch deleted', { branch, worktreePath });
      return true;
    }

    // For regular branches, use git branch -D
    execFileSync('git', ['branch', '-D', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    cleanupOrphanedClone(projectDir, branch);

    success(`Deleted ${branch}`);
    log.info('Branch deleted', { branch });
    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Delete failed: ${msg}`);
    log.error('Delete failed', { branch, error: msg });
    return false;
  }
}

/**
 * Get the piece to use for instruction.
 */
async function selectPieceForInstruction(projectDir: string): Promise<string | null> {
  const availablePieces = listPieces(projectDir);
  const currentPiece = getCurrentPiece(projectDir);

  if (availablePieces.length === 0) {
    return DEFAULT_PIECE_NAME;
  }

  if (availablePieces.length === 1 && availablePieces[0]) {
    return availablePieces[0];
  }

  const options = availablePieces.map((name) => ({
    label: name === currentPiece ? `${name} (current)` : name,
    value: name,
  }));

  return await selectOption('Select piece:', options);
}

/**
 * Get branch context: diff stat and commit log from main branch.
 */
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

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * Instruct branch: create a temp clone, give additional instructions,
 * auto-commit+push, then remove clone.
 */
export async function instructBranch(
  projectDir: string,
  item: BranchListItem,
  options?: TaskExecutionOptions,
): Promise<boolean> {
  const { branch } = item.info;

  const instruction = await promptInput('Enter instruction');
  if (!instruction) {
    info('Cancelled');
    return false;
  }

  const selectedPiece = await selectPieceForInstruction(projectDir);
  if (!selectedPiece) {
    info('Cancelled');
    return false;
  }

  log.info('Instructing branch via temp clone', { branch, piece: selectedPiece });
  info(`Running instruction on ${branch}...`);

  const clone = createTempCloneForBranch(projectDir, branch);

  try {
    const branchContext = getBranchContext(projectDir, branch);
    const fullInstruction = branchContext
      ? `${branchContext}## 追加指示\n${instruction}`
      : instruction;

    const taskSuccess = await executeTask({
      task: fullInstruction,
      cwd: clone.path,
      pieceIdentifier: selectedPiece,
      projectCwd: projectDir,
      agentOverrides: options,
    });

    if (taskSuccess) {
      const commitResult = autoCommitAndPush(clone.path, item.taskSlug, projectDir);
      if (commitResult.success && commitResult.commitHash) {
        info(`Auto-committed & pushed: ${commitResult.commitHash}`);
      } else if (!commitResult.success) {
        warn(`Auto-commit skipped: ${commitResult.message}`);
      }
      success(`Instruction completed on ${branch}`);
      log.info('Instruction completed', { branch });
    } else {
      logError(`Instruction failed on ${branch}`);
      log.error('Instruction failed', { branch });
    }

    return taskSuccess;
  } finally {
    removeClone(clone.path);
    removeCloneMeta(projectDir, branch);
  }
}
