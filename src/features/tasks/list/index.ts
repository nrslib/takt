/**
 * List tasks command — main entry point.
 *
 * Interactive UI for reviewing branch-based task results.
 * Individual actions (merge, delete, instruct, diff) are in taskActions.ts.
 */

import { execFileSync } from 'node:child_process';
import {
  detectDefaultBranch,
  listTaktBranches,
  buildListItems,
} from '../../../infra/task/index.js';
import { selectOption, confirm } from '../../../shared/prompt/index.js';
import { info } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import type { BranchListItem } from '../../../infra/task/index.js';
import {
  type ListAction,
  showFullDiff,
  showDiffAndPromptAction,
  tryMergeBranch,
  mergeBranch,
  deleteBranch,
  instructBranch,
} from './taskActions.js';

export {
  type ListAction,
  isBranchMerged,
  showFullDiff,
  tryMergeBranch,
  mergeBranch,
  deleteBranch,
  instructBranch,
} from './taskActions.js';

const log = createLogger('list-tasks');

export interface ListNonInteractiveOptions {
  enabled: boolean;
  action?: string;
  branch?: string;
  format?: string;
  yes?: boolean;
}

function isValidAction(action: string): action is ListAction {
  return action === 'diff' || action === 'try' || action === 'merge' || action === 'delete';
}

function printNonInteractiveList(items: BranchListItem[], format?: string): void {
  const outputFormat = format ?? 'text';
  if (outputFormat === 'json') {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  for (const item of items) {
    const worktreeLabel = item.info.worktreePath ? ' (worktree)' : '';
    const instruction = item.originalInstruction ? ` - ${item.originalInstruction}` : '';
    console.log(`${item.info.branch}${worktreeLabel} (${item.filesChanged} files)${instruction}`);
  }
}

function showDiffStat(projectDir: string, defaultBranch: string, branch: string): void {
  try {
    const stat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    );
    console.log(stat);
  } catch {
    info('Could not generate diff stat');
  }
}

async function listTasksNonInteractive(
  cwd: string,
  _options: TaskExecutionOptions | undefined,
  nonInteractive: ListNonInteractiveOptions,
): Promise<void> {
  const defaultBranch = detectDefaultBranch(cwd);
  const branches = listTaktBranches(cwd);

  if (branches.length === 0) {
    info('No tasks to list.');
    return;
  }

  const items = buildListItems(cwd, branches, defaultBranch);

  if (!nonInteractive.action) {
    printNonInteractiveList(items, nonInteractive.format);
    return;
  }

  if (!nonInteractive.branch) {
    info('Missing --branch for non-interactive action.');
    process.exit(1);
  }

  if (!isValidAction(nonInteractive.action)) {
    info('Invalid --action. Use one of: diff, try, merge, delete.');
    process.exit(1);
  }

  const item = items.find((entry) => entry.info.branch === nonInteractive.branch);
  if (!item) {
    info(`Branch not found: ${nonInteractive.branch}`);
    process.exit(1);
  }

  switch (nonInteractive.action) {
    case 'diff':
      showDiffStat(cwd, defaultBranch, item.info.branch);
      return;
    case 'try':
      tryMergeBranch(cwd, item);
      return;
    case 'merge':
      mergeBranch(cwd, item);
      return;
    case 'delete':
      if (!nonInteractive.yes) {
        info('Delete requires --yes in non-interactive mode.');
        process.exit(1);
      }
      deleteBranch(cwd, item);
      return;
  }
}

/**
 * Main entry point: list branch-based tasks interactively.
 */
export async function listTasks(
  cwd: string,
  options?: TaskExecutionOptions,
  nonInteractive?: ListNonInteractiveOptions,
): Promise<void> {
  log.info('Starting list-tasks');

  if (nonInteractive?.enabled) {
    await listTasksNonInteractive(cwd, options, nonInteractive);
    return;
  }

  const defaultBranch = detectDefaultBranch(cwd);
  let branches = listTaktBranches(cwd);

  if (branches.length === 0) {
    info('No tasks to list.');
    return;
  }

  // Interactive loop
  while (branches.length > 0) {
    const items = buildListItems(cwd, branches, defaultBranch);

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
