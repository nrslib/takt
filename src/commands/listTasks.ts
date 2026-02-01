/**
 * List tasks command
 *
 * Interactive UI for reviewing branch-based task results:
 * try merge, merge & cleanup, or delete actions.
 * Clones are ephemeral — only branches persist between sessions.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import {
  createTempCloneForBranch,
  removeClone,
  removeCloneMeta,
  cleanupOrphanedClone,
} from '../task/clone.js';
import {
  detectDefaultBranch,
  listTaktBranches,
  buildListItems,
  type BranchListItem,
} from '../task/branchList.js';
import { autoCommitAndPush } from '../task/autoCommit.js';
import { selectOption, confirm, promptInput } from '../prompt/index.js';
import { info, success, error as logError, warn, header, blankLine } from '../utils/ui.js';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';
import { executeTask, type TaskExecutionOptions } from './taskExecution.js';
import { listWorkflows } from '../config/workflowLoader.js';
import { getCurrentWorkflow } from '../config/paths.js';
import { DEFAULT_WORKFLOW_NAME } from '../constants.js';

const log = createLogger('list-tasks');

/** Actions available for a listed branch */
export type ListAction = 'diff' | 'instruct' | 'try' | 'merge' | 'delete';

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
  item: BranchListItem,
): Promise<ListAction | null> {
  header(item.info.branch);
  if (item.originalInstruction) {
    console.log(chalk.dim(`  ${item.originalInstruction}`));
  }
  blankLine();

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
 * User can inspect staged changes and commit manually if satisfied.
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
 * Otherwise merge first, then delete the branch.
 * No worktree removal needed — clones are ephemeral.
 */
export function mergeBranch(projectDir: string, item: BranchListItem): boolean {
  const { branch } = item.info;
  const alreadyMerged = isBranchMerged(projectDir, branch);

  try {
    // Merge only if not already merged
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

    // Delete the branch
    try {
      execFileSync('git', ['branch', '-d', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch {
      warn(`Could not delete branch ${branch}. You may delete it manually.`);
    }

    // Clean up orphaned clone directory if it still exists
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
 * No worktree removal needed — clones are ephemeral.
 */
export function deleteBranch(projectDir: string, item: BranchListItem): boolean {
  const { branch } = item.info;

  try {
    // Force-delete the branch
    execFileSync('git', ['branch', '-D', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    // Clean up orphaned clone directory if it still exists
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
 * Get the workflow to use for instruction.
 * If multiple workflows available, prompt user to select.
 */
async function selectWorkflowForInstruction(projectDir: string): Promise<string | null> {
  const availableWorkflows = listWorkflows(projectDir);
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
 * Get branch context: diff stat and commit log from main branch.
 */
function getBranchContext(projectDir: string, branch: string): string {
  const defaultBranch = detectDefaultBranch(projectDir);
  const lines: string[] = [];

  // Get diff stat
  try {
    const diffStat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' }
    ).trim();
    if (diffStat) {
      lines.push('## 現在の変更内容（mainからの差分）');
      lines.push('```');
      lines.push(diffStat);
      lines.push('```');
    }
  } catch {
    // Ignore errors
  }

  // Get commit log
  try {
    const commitLog = execFileSync(
      'git', ['log', '--oneline', `${defaultBranch}..${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' }
    ).trim();
    if (commitLog) {
      lines.push('');
      lines.push('## コミット履歴');
      lines.push('```');
      lines.push(commitLog);
      lines.push('```');
    }
  } catch {
    // Ignore errors
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

  log.info('Instructing branch via temp clone', { branch, workflow: selectedWorkflow });
  info(`Running instruction on ${branch}...`);

  // 3. Create temp clone for the branch
  const clone = createTempCloneForBranch(projectDir, branch);

  try {
    // 4. Build instruction with branch context
    const branchContext = getBranchContext(projectDir, branch);
    const fullInstruction = branchContext
      ? `${branchContext}## 追加指示\n${instruction}`
      : instruction;

    // 5. Execute task on temp clone
    const taskSuccess = await executeTask({
      task: fullInstruction,
      cwd: clone.path,
      workflowIdentifier: selectedWorkflow,
      projectCwd: projectDir,
      agentOverrides: options,
    });

    // 6. Auto-commit+push if successful
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
    // 7. Always remove temp clone and metadata
    removeClone(clone.path);
    removeCloneMeta(projectDir, branch);
  }
}

/**
 * Main entry point: list branch-based tasks interactively.
 */
export async function listTasks(cwd: string, options?: TaskExecutionOptions): Promise<void> {
  log.info('Starting list-tasks');

  const defaultBranch = detectDefaultBranch(cwd);
  let branches = listTaktBranches(cwd);

  if (branches.length === 0) {
    info('No tasks to list.');
    return;
  }

  // Interactive loop
  while (branches.length > 0) {
    const items = buildListItems(cwd, branches, defaultBranch);

    // Build selection options
    const menuOptions = items.map((item, idx) => {
      const filesSummary = `${item.filesChanged} file${item.filesChanged !== 1 ? 's' : ''} changed`;
      const description = item.originalInstruction
        ? `${filesSummary} | ${item.originalInstruction}`
        : filesSummary;
      return {
        label: item.info.branch,
        value: String(idx),
        description,
      };
    });

    const selected = await selectOption<string>(
      'List Tasks (Branches)',
      menuOptions,
    );

    if (selected === null) {
      return;
    }

    const selectedIdx = parseInt(selected, 10);
    const item = items[selectedIdx];
    if (!item) continue;

    // Action loop: re-show menu after viewing diff
    let action: ListAction | null;
    do {
      action = await showDiffAndPromptAction(cwd, defaultBranch, item);

      if (action === 'diff') {
        showFullDiff(cwd, defaultBranch, item.info.branch);
      }
    } while (action === 'diff');

    if (action === null) continue;

    switch (action) {
      case 'instruct':
        await instructBranch(cwd, item, options);
        break;
      case 'try':
        tryMergeBranch(cwd, item);
        break;
      case 'merge':
        mergeBranch(cwd, item);
        break;
      case 'delete': {
        const confirmed = await confirm(
          `Delete ${item.info.branch}? This will discard all changes.`,
          false,
        );
        if (confirmed) {
          deleteBranch(cwd, item);
        }
        break;
      }
    }

    // Refresh branch list after action
    branches = listTaktBranches(cwd);
  }

  info('All tasks listed.');
}
