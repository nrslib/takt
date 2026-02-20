import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { detectDefaultBranch } from '../../../infra/task/index.js';
import { selectOption } from '../../../shared/prompt/index.js';
import { info, warn, header, blankLine } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { type BranchActionTarget, type ListAction, resolveTargetBranch, resolveTargetInstruction } from './taskActionTarget.js';

const log = createLogger('list-tasks');

export function showFullDiff(cwd: string, branch: string): void {
  const defaultBranch = detectDefaultBranch(cwd);
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

export async function showDiffAndPromptActionForTask(
  cwd: string,
  target: BranchActionTarget,
): Promise<ListAction | null> {
  const branch = resolveTargetBranch(target);
  const instruction = resolveTargetInstruction(target);
  const defaultBranch = detectDefaultBranch(cwd);

  header(branch);
  if (instruction) {
    info(chalk.dim(`  ${instruction}`));
  }
  blankLine();

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

  return await selectOption<ListAction>(
    `Action for ${branch}:`,
    [
      { label: 'View diff', value: 'diff', description: 'Show full diff in pager' },
      { label: 'Instruct', value: 'instruct', description: 'Craft additional instructions and requeue this task' },
      { label: 'Sync with root', value: 'sync', description: 'Merge root HEAD into worktree branch; auto-resolve conflicts with AI' },
      { label: 'Try merge', value: 'try', description: 'Squash merge (stage changes without commit)' },
      { label: 'Merge & cleanup', value: 'merge', description: 'Merge and delete branch' },
      { label: 'Delete', value: 'delete', description: 'Discard changes, delete branch' },
    ],
  );
}
