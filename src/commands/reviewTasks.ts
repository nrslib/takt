/**
 * Review tasks command
 *
 * Interactive UI for reviewing worktree-based task results:
 * try merge, merge & cleanup, or delete actions.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import {
  removeWorktree,
  detectDefaultBranch,
  listTaktWorktrees,
  buildReviewItems,
  type WorktreeReviewItem,
} from '../task/worktree.js';
import { selectOption, confirm, promptInput } from '../prompt/index.js';
import { info, success, error as logError, warn } from '../utils/ui.js';
import { createLogger } from '../utils/debug.js';
import { executeTask } from './taskExecution.js';
import { autoCommitWorktree } from '../task/autoCommit.js';
import { listWorkflows } from '../config/workflowLoader.js';
import { getCurrentWorkflow } from '../config/paths.js';
import { DEFAULT_WORKFLOW_NAME } from '../constants.js';

const log = createLogger('review-tasks');

/** Actions available for a reviewed worktree */
export type ReviewAction = 'diff' | 'instruct' | 'try' | 'merge' | 'delete';

/**
 * Check if a branch has already been merged into HEAD.
 */
export function isBranchMerged(projectDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
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
      { cwd, stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, GIT_PAGER: 'less -R' } },
    );
    if (result.status !== 0) {
      warn('Could not display diff');
    }
  } catch {
    warn('Could not display diff');
  }
}

/**
 * Show diff stat for a branch and prompt for an action.
 */
async function showDiffAndPromptAction(
  cwd: string,
  defaultBranch: string,
  item: WorktreeReviewItem,
): Promise<ReviewAction | null> {
  console.log();
  console.log(chalk.bold.cyan(`=== ${item.info.branch} ===`));
  console.log();

  // Show diff stat
  try {
    const stat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${item.info.branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
    console.log(stat);
  } catch {
    warn('Could not generate diff stat');
  }

  // Prompt action
  const action = await selectOption<ReviewAction>(
    `Action for ${item.info.branch}:`,
    [
      { label: 'View diff', value: 'diff', description: 'Show full diff in pager' },
      { label: 'Instruct', value: 'instruct', description: 'Give additional instructions to modify this worktree' },
      { label: 'Try merge', value: 'try', description: 'Merge without cleanup (keep worktree & branch)' },
      { label: 'Merge & cleanup', value: 'merge', description: 'Merge (if needed) and remove worktree & branch' },
      { label: 'Delete', value: 'delete', description: 'Discard changes, remove worktree and branch' },
    ],
  );

  return action;
}

/**
 * Try-merge: merge the branch without cleanup.
 * Keeps the worktree and branch intact for further review.
 */
export function tryMergeWorktreeBranch(projectDir: string, item: WorktreeReviewItem): boolean {
  const { branch } = item.info;

  try {
    execFileSync('git', ['merge', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    success(`Merged ${branch} (worktree kept)`);
    log.info('Try-merge completed', { branch });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Try-merge failed', { branch, error: msg });
    return false;
  }
}

/**
 * Merge & cleanup: if already merged, skip merge and just cleanup.
 * Otherwise merge first, then cleanup (remove worktree + delete branch).
 */
export function mergeWorktreeBranch(projectDir: string, item: WorktreeReviewItem): boolean {
  const { branch } = item.info;
  const alreadyMerged = isBranchMerged(projectDir, branch);

  try {
    // 1. Remove worktree (must happen before merge to unlock branch)
    removeWorktree(projectDir, item.info.path);

    // 2. Merge only if not already merged
    if (alreadyMerged) {
      info(`${branch} is already merged, skipping merge.`);
      log.info('Branch already merged, cleanup only', { branch });
    } else {
      execFileSync('git', ['merge', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }

    // 3. Delete the branch
    try {
      execFileSync('git', ['branch', '-d', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch {
      warn(`Could not delete branch ${branch}. You may delete it manually.`);
    }

    success(`Merged & cleaned up ${branch}`);
    log.info('Worktree merged & cleaned up', { branch, alreadyMerged });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Merge & cleanup failed', { branch, error: msg });
    return false;
  }
}

/**
 * Delete a worktree and its branch (discard changes).
 */
export function deleteWorktreeBranch(projectDir: string, item: WorktreeReviewItem): boolean {
  const { branch } = item.info;

  try {
    // 1. Remove worktree
    removeWorktree(projectDir, item.info.path);

    // 2. Force-delete the branch
    execFileSync('git', ['branch', '-D', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    success(`Deleted ${branch}`);
    log.info('Worktree deleted', { branch });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Delete failed: ${msg}`);
    log.error('Delete failed', { branch, error: msg });
    return false;
  }
}

/**
 * Get the workflow to use for instruction.
 * If multiple workflows available, prompt user to select.
 */
async function selectWorkflowForInstruction(projectDir: string): Promise<string | null> {
  const availableWorkflows = listWorkflows();
  const currentWorkflow = getCurrentWorkflow(projectDir);

  if (availableWorkflows.length === 0) {
    return DEFAULT_WORKFLOW_NAME;
  }

  if (availableWorkflows.length === 1 && availableWorkflows[0]) {
    return availableWorkflows[0];
  }

  // Multiple workflows: let user select
  const options = availableWorkflows.map((name) => ({
    label: name === currentWorkflow ? `${name} (current)` : name,
    value: name,
  }));

  return await selectOption('Select workflow:', options);
}

/**
 * Instruct worktree: give additional instructions to modify the worktree.
 * Executes a task on the worktree and auto-commits if successful.
 */
export async function instructWorktree(
  projectDir: string,
  item: WorktreeReviewItem,
): Promise<boolean> {
  const { branch } = item.info;
  const worktreePath = item.info.path;

  // 1. Prompt for instruction
  const instruction = await promptInput('Enter instruction');
  if (!instruction) {
    info('Cancelled');
    return false;
  }

  // 2. Select workflow
  const selectedWorkflow = await selectWorkflowForInstruction(projectDir);
  if (!selectedWorkflow) {
    info('Cancelled');
    return false;
  }

  log.info('Instructing worktree', { branch, worktreePath, workflow: selectedWorkflow });
  info(`Running instruction on ${branch}...`);

  // 3. Execute task on worktree
  const taskSuccess = await executeTask(instruction, worktreePath, selectedWorkflow, projectDir);

  // 4. Auto-commit if successful
  if (taskSuccess) {
    const commitResult = autoCommitWorktree(worktreePath, item.taskSlug);
    if (commitResult.success && commitResult.commitHash) {
      info(`Auto-committed: ${commitResult.commitHash}`);
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
}

/**
 * Main entry point: review worktree tasks interactively.
 */
export async function reviewTasks(cwd: string): Promise<void> {
  log.info('Starting review-tasks');

  const defaultBranch = detectDefaultBranch(cwd);
  let worktrees = listTaktWorktrees(cwd);

  if (worktrees.length === 0) {
    info('No tasks to review.');
    return;
  }

  // Interactive loop
  while (worktrees.length > 0) {
    const items = buildReviewItems(cwd, worktrees, defaultBranch);

    // Build selection options
    const options = items.map((item, idx) => ({
      label: item.info.branch,
      value: String(idx),
      description: `${item.filesChanged} file${item.filesChanged !== 1 ? 's' : ''} changed`,
    }));

    const selected = await selectOption<string>(
      'Review Tasks (Worktrees)',
      options,
    );

    if (selected === null) {
      return;
    }

    const selectedIdx = parseInt(selected, 10);
    const item = items[selectedIdx];
    if (!item) continue;

    // Action loop: re-show menu after viewing diff
    let action: ReviewAction | null;
    do {
      action = await showDiffAndPromptAction(cwd, defaultBranch, item);

      if (action === 'diff') {
        showFullDiff(cwd, defaultBranch, item.info.branch);
      }
    } while (action === 'diff');

    if (action === null) continue;

    switch (action) {
      case 'instruct':
        await instructWorktree(cwd, item);
        break;
      case 'try':
        tryMergeWorktreeBranch(cwd, item);
        break;
      case 'merge':
        mergeWorktreeBranch(cwd, item);
        break;
      case 'delete': {
        const confirmed = await confirm(
          `Delete ${item.info.branch}? This will discard all changes.`,
          false,
        );
        if (confirmed) {
          deleteWorktreeBranch(cwd, item);
        }
        break;
      }
    }

    // Refresh worktree list after action
    worktrees = listTaktWorktrees(cwd);
  }

  info('All tasks reviewed.');
}
