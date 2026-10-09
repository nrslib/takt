import {
  confirm,
  confirmWithCancel,
  promptInput,
  promptInputWithCancel,
  type CancellablePromptResult,
} from '../../../shared/prompt/index.js';
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

export interface PromptWorktreeSettingsOptions {
  allowCancel?: boolean;
}

export type WorktreeSettingsPromptResult = WorktreeSettings | { readonly kind: 'cancelled' };

async function askForInput(
  message: string,
  allowCancel: boolean,
): Promise<CancellablePromptResult<string | null>> {
  return allowCancel
    ? promptInputWithCancel(message)
    : { kind: 'value', value: await promptInput(message) };
}

async function askForConfirmation(
  message: string,
  defaultYes: boolean,
  allowCancel: boolean,
): Promise<CancellablePromptResult<boolean>> {
  return allowCancel
    ? confirmWithCancel(message, defaultYes)
    : { kind: 'value', value: await confirm(message, defaultYes) };
}

export function displayTaskCreationResult(
  created: { taskName: string; tasksFile: string },
  settings: WorktreeSettings,
  workflow?: string,
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
  if (workflow) info(`  Workflow: ${sanitizeTerminalText(workflow)}`);
}

export function promptWorktreeSettings(cwd: string): Promise<WorktreeSettings>;
export function promptWorktreeSettings(
  cwd: string,
  options: PromptWorktreeSettingsOptions & { allowCancel: true },
): Promise<WorktreeSettingsPromptResult>;
export async function promptWorktreeSettings(
  cwd: string,
  options: PromptWorktreeSettingsOptions = {},
): Promise<WorktreeSettings | WorktreeSettingsPromptResult> {
  const allowCancel = options.allowCancel === true;
  let currentBranch: string | undefined;
  try {
    currentBranch = getCurrentBranch(cwd);
  } catch (err) {
    error(`Failed to detect current branch: ${getErrorMessage(err)}`);
  }
  let baseBranch: string | undefined;

  if (currentBranch && currentBranch !== 'main' && currentBranch !== 'master') {
    const safeCurrentBranch = sanitizeTerminalText(currentBranch);
    const useCurrentAsBase = await askForConfirmation(
      `現在のブランチ: ${safeCurrentBranch}\nBase branch として ${safeCurrentBranch} を使いますか？`,
      true,
      allowCancel,
    );
    if (useCurrentAsBase.kind === 'cancelled') {
      return useCurrentAsBase;
    }
    if (useCurrentAsBase.value) {
      const resolvedBaseBranch = await resolveExistingBaseBranch(cwd, currentBranch, allowCancel);
      if (resolvedBaseBranch !== undefined && typeof resolvedBaseBranch !== 'string') {
        return resolvedBaseBranch;
      }
      baseBranch = resolvedBaseBranch;
    }
  }

  const customPath = await askForInput('Worktree path (Enter for auto)', allowCancel);
  if (customPath.kind === 'cancelled') {
    return customPath;
  }
  const worktree: boolean | string = customPath.value || true;

  const customBranch = await askForInput('Branch name (Enter for auto)', allowCancel);
  if (customBranch.kind === 'cancelled') {
    return customBranch;
  }
  const branch = customBranch.value || undefined;

  const autoPrResult = await askForConfirmation('Auto-create PR?', true, allowCancel);
  if (autoPrResult.kind === 'cancelled') {
    return autoPrResult;
  }
  const autoPr = autoPrResult.value;

  let draftPr = false;
  if (autoPr) {
    const draftPrResult = await askForConfirmation('Create as draft?', true, allowCancel);
    if (draftPrResult.kind === 'cancelled') {
      return draftPrResult;
    }
    draftPr = draftPrResult.value;
  }

  const settings = { worktree, branch, baseBranch, autoPr, draftPr };
  return settings;
}

async function resolveExistingBaseBranch(
  cwd: string,
  initialBranch: string,
  allowCancel: boolean,
): Promise<string | undefined | { readonly kind: 'cancelled' }> {
  let candidate: string | undefined = initialBranch;

  while (candidate) {
    if (branchExists(cwd, candidate)) {
      return candidate;
    }
    error(`Base branch does not exist: ${sanitizeTerminalText(candidate)}`);
    const nextInput = await askForInput('Base branch (Enter for default)', allowCancel);
    if (nextInput.kind === 'cancelled') {
      return nextInput;
    }
    candidate = nextInput.value ?? undefined;
  }

  return undefined;
}
