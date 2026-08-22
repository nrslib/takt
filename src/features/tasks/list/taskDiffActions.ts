import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { detectDefaultBranch } from '../../../infra/task/index.js';
import { selectOption } from '../../../shared/prompt/index.js';
import { info, warn, header, blankLine } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import {
  type BranchActionTarget,
  type ListAction,
  ensureRootBranchReady,
  resolveTargetBranch,
  resolveTargetInstruction,
} from './taskActionTarget.js';

const log = createLogger('list-tasks');

export function showFullDiff(cwd: string, target: BranchActionTarget): void {
  if (!ensureRootBranchReady(cwd, target, 'full diff')) {
    warn('Could not display diff');
    return;
  }

  const branch = resolveTargetBranch(target);
  const defaultBranch = detectDefaultBranch(cwd);
  try {
    const result = spawnSync('git', ['diff', '--color=always', `${defaultBranch}...${branch}`], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, GIT_PAGER: 'less -R' },
    });
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

export function showDiffStatForTask(cwd: string, target: BranchActionTarget): void {
  if (!ensureRootBranchReady(cwd, target, 'diff stat')) {
    warn('Could not generate diff stat');
    return;
  }

  const branch = resolveTargetBranch(target);
  const defaultBranch = detectDefaultBranch(cwd);

  try {
    const stat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
    info(stat);
  } catch (err) {
    warn('Could not generate diff stat');
    log.error('Failed to generate diff stat', {
      branch,
      defaultBranch,
      error: getErrorMessage(err),
    });
  }
}

export function showDiffAndPromptActionForTask(
  cwd: string,
  target: BranchActionTarget,
  includeCreatePullRequest: false,
): Promise<Exclude<ListAction, 'create_pr'> | null>;
export function showDiffAndPromptActionForTask(
  cwd: string,
  target: BranchActionTarget,
  includeCreatePullRequest?: true,
): Promise<ListAction | null>;
export async function showDiffAndPromptActionForTask(
  cwd: string,
  target: BranchActionTarget,
  includeCreatePullRequest = true,
): Promise<ListAction | null> {
  const branch = resolveTargetBranch(target);
  const instruction = resolveTargetInstruction(target);

  header(branch);
  if (instruction) {
    info(chalk.dim(`  ${instruction}`));
  }
  blankLine();

  showDiffStatForTask(cwd, target);

  const actions: Array<{ label: string; value: ListAction; description: string }> = [
    { label: 'View diff', value: 'diff' as ListAction, description: 'Show full diff in pager' },
    { label: 'Instruct', value: 'instruct' as ListAction, description: 'Craft additional instructions and requeue this task' },
    ...(includeCreatePullRequest
      ? [{ label: 'Create PR', value: 'create_pr' as ListAction, description: 'Commit, push, and create a pull request' }]
      : []),
    { label: 'Merge from root', value: 'sync' as ListAction, description: 'Merge root HEAD into worktree branch; auto-resolve conflicts with AI' },
    { label: 'Pull from remote', value: 'pull' as ListAction, description: 'Pull latest changes from remote origin (fast-forward only)' },
    { label: 'Try merge', value: 'try' as ListAction, description: 'Squash merge (stage changes without commit)' },
    { label: 'Merge & cleanup', value: 'merge' as ListAction, description: 'Merge and delete branch' },
    { label: 'Delete', value: 'delete' as ListAction, description: 'Discard changes, delete branch' },
  ];

  return await selectOption<ListAction>(
    `Action for ${branch}:`,
    actions,
  );
}
