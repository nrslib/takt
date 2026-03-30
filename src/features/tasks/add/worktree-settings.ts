import { confirm, promptInput } from '../../../shared/prompt/index.js';
import { info, success, error } from '../../../shared/ui/index.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { getCurrentBranch, branchExists } from '../../../infra/task/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';

export interface WorktreeSettings {
  worktree?: boolean | string;
  branch?: string;
  baseBranch?: string;
  autoPr?: boolean;
  draftPr?: boolean;
}

export function displayTaskCreationResult(
  created: { taskName: string; tasksFile: string },
  settings: WorktreeSettings,
  piece?: string,
): void {
  success(`Task created: ${sanitizeTerminalText(created.taskName)}`);
  info(`  File: ${sanitizeTerminalText(created.tasksFile)}`);
  if (settings.worktree) {
    info(`  Worktree: ${typeof settings.worktree === 'string' ? sanitizeTerminalText(settings.worktree) : 'auto'}`);
  }
  if (settings.branch) {
    info(`  Branch: ${sanitizeTerminalText(settings.branch)}`);
  }
  if (settings.baseBranch) {
    info(`  Base branch: ${sanitizeTerminalText(settings.baseBranch)}`);
  }
  if (settings.autoPr) {
    info(`  Auto-PR: yes`);
  }
  if (settings.draftPr) {
    info(`  Draft PR: yes`);
  }
  if (piece) info(`  Workflow: ${sanitizeTerminalText(piece)}`);
}

export async function promptWorktreeSettings(cwd: string): Promise<WorktreeSettings> {
  let currentBranch: string | undefined;
  try {
    currentBranch = getCurrentBranch(cwd);
  } catch (err) {
    error(`Failed to detect current branch: ${getErrorMessage(err)}`);
  }
  let baseBranch: string | undefined;

  if (currentBranch && currentBranch !== 'main' && currentBranch !== 'master') {
    const safeCurrentBranch = sanitizeTerminalText(currentBranch);
    const useCurrentAsBase = await confirm(
      `現在のブランチ: ${safeCurrentBranch}\nBase branch として ${safeCurrentBranch} を使いますか？`,
      true,
    );
    if (useCurrentAsBase) {
      baseBranch = await resolveExistingBaseBranch(cwd, currentBranch);
    }
  }

  const customPath = await promptInput('Worktree path (Enter for auto)');
  const worktree: boolean | string = customPath || true;

  const customBranch = await promptInput('Branch name (Enter for auto)');
  const branch = customBranch || undefined;

  const autoPr = await confirm('Auto-create PR?', true);
  const draftPr = autoPr ? await confirm('Create as draft?', true) : false;

  return { worktree, branch, baseBranch, autoPr, draftPr };
}

async function resolveExistingBaseBranch(cwd: string, initialBranch: string): Promise<string | undefined> {
  let candidate: string | undefined = initialBranch;

  while (candidate) {
    if (branchExists(cwd, candidate)) {
      return candidate;
    }
    error(`Base branch does not exist: ${sanitizeTerminalText(candidate)}`);
    const nextInput = await promptInput('Base branch (Enter for default)');
    candidate = nextInput ?? undefined;
  }

  return undefined;
}
