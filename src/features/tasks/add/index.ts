/**
 * add command implementation
 *
 * Appends a task record to .takt/tasks.yaml.
 */

import { promptInput, confirm, selectOption } from '../../../shared/prompt/index.js';
import { info, error, withProgress } from '../../../shared/ui/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../../shared/constants.js';
import type { Language } from '../../../core/models/types.js';
import { saveEnqueuedTaskFile } from '../../../infra/task/enqueuedTaskFile.js';
import { determineWorkflow } from '../execute/selectAndExecute.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { isIssueReference, resolveIssueTask, parseIssueNumbers, formatPrReviewAsTask, getGitProvider } from '../../../infra/git/index.js';
import type { PrReviewData } from '../../../infra/git/index.js';
import { extractTitle, createIssueFromTask, createIssueFromTaskResult } from '../../../infra/task/issueTask.js';
import { displayTaskCreationResult, promptWorktreeSettings, type WorktreeSettings } from './worktree-settings.js';
import {
  createIssueAndEnqueueTask,
  formatIssueEnqueueFailure,
  IssueEnqueueCancelledError,
  joinIssueEnqueueFailureText,
  type SaveEnqueuedTaskFile,
  type SaveEnqueuedTaskFileOptions,
} from '../../../infra/task/enqueueService.js';
import {
  prepareTaskSpecDirectory,
  type TaskAttachment,
} from '../attachments.js';
export { extractTitle, createIssueFromTask, createIssueFromTaskResult };

const log = createLogger('add-task');

export type SaveTaskOptions = SaveEnqueuedTaskFileOptions & {
  attachments?: TaskAttachment[];
};

export async function saveTaskFile(
  cwd: string,
  taskContent: string,
  options?: SaveTaskOptions,
): Promise<{ taskName: string; tasksFile: string }> {
  const { attachments, ...saveOptions } = options ?? {};
  const prepareTaskSpec = attachments !== undefined
    ? (saveCwd: string, saveTaskContent: string) => prepareTaskSpecDirectory(saveCwd, saveTaskContent, attachments)
    : undefined;
  return saveEnqueuedTaskFile(cwd, taskContent, saveOptions, prepareTaskSpec);
}


/**
 * Prompt user to select a label for the issue.
 *
 * Presents 4 fixed options: None, bug, enhancement, custom input.
 * Returns an array of selected labels (empty if none selected).
 */
export async function promptLabelSelection(lang: Language): Promise<string[]> {
  const selected = await selectOption<string>(
    getLabel('issue.labelSelection.prompt', lang),
    [
      { label: getLabel('issue.labelSelection.none', lang), value: 'none' },
      { label: 'bug', value: 'bug' },
      { label: 'enhancement', value: 'enhancement' },
      { label: getLabel('issue.labelSelection.custom', lang), value: 'custom' },
    ],
  );

  if (selected === null || selected === 'none') return [];
  if (selected === 'custom') {
    const customLabel = await promptInput(getLabel('issue.labelSelection.customPrompt', lang));
    return customLabel?.split(',').map((l) => l.trim()).filter((l) => l.length > 0) ?? [];
  }
  return [selected];
}


/**
 * Save a task from interactive mode result.
 * Prompts for worktree/branch/auto_pr settings before saving.
 * If presetSettings is provided, skips the prompt and uses those settings directly.
 */
export async function saveTaskFromInteractive(
  cwd: string,
  task: string,
  workflow?: string,
  options?: {
    issue?: number;
    prNumber?: number;
    confirmAtEndMessage?: string;
    presetSettings?: WorktreeSettings;
    attachments?: TaskAttachment[];
  },
): Promise<{ taskName: string; tasksFile: string } | undefined> {
  if (options?.confirmAtEndMessage) {
    const approved = await confirm(options.confirmAtEndMessage, true);
    if (!approved) {
      return undefined;
    }
  }
  const settings = options?.presetSettings ?? await promptWorktreeSettings(cwd);
  const created = await saveTaskFile(cwd, task, {
    workflow,
    issue: options?.issue,
    prNumber: options?.prNumber,
    ...settings,
    ...(options?.attachments ? { attachments: options.attachments } : {}),
  });
  displayTaskCreationResult(created, settings, workflow);
  return created;
}

export async function createIssueAndSaveTask(
  cwd: string,
  task: string,
  workflow?: string,
  options?: { confirmAtEndMessage?: string; labels?: string[]; attachments?: TaskAttachment[] },
): Promise<void> {
  const gitProvider = getGitProvider();
  const saveInteractiveTask: SaveEnqueuedTaskFile = async (saveCwd, taskContent, saveOptions) => {
    const created = await saveTaskFromInteractive(saveCwd, taskContent, saveOptions?.workflow, {
      issue: saveOptions?.issue,
      confirmAtEndMessage: options?.confirmAtEndMessage,
      ...(options?.attachments ? { attachments: options.attachments } : {}),
    });
    if (created === undefined) {
      throw new IssueEnqueueCancelledError();
    }
    return created;
  };
  const result = await createIssueAndEnqueueTask({
    cwd,
    task,
    workflow: workflow ?? DEFAULT_WORKFLOW_NAME,
    worktree: true,
    autoPr: false,
    labels: options?.labels,
    gitProvider,
    issueOutputMode: 'terminal',
  }, {
    saveTaskFile: saveInteractiveTask,
    createIssueFromTaskResult,
  });
  if (!result.success) {
    if (result.failure.stage !== 'issue_creation') {
      error(joinIssueEnqueueFailureText(
        formatIssueEnqueueFailure(result.failure, getErrorMessage),
        '; ',
      ));
    }
    return;
  }
}

/**
 * add command handler
 *
 * Flow:
 *   A) --pr オプション: PRレビュー取得 → ワークフロー選択 → YAML作成
 *   B) 引数なし: Usage表示して終了
 *   C) Issue参照の場合: issue取得 → ワークフロー選択 → ワークツリー設定 → YAML作成
 *   D) 通常入力: ワークフロー選択 → ワークツリー設定 → YAML作成
 */
export async function addTask(
  cwd: string,
  task?: string,
  opts?: { prNumber?: number; workflow?: string },
): Promise<void> {
  const rawTask = task ?? '';
  const trimmedTask = rawTask.trim();
  const prNumber = opts?.prNumber;

  if (prNumber !== undefined) {
    const provider = getGitProvider();
    const cliStatus = provider.checkCliStatus(cwd);
    if (!cliStatus.available) {
      error(cliStatus.error);
      return;
    }

    let prReview: PrReviewData;
    try {
      prReview = await withProgress(
        'Fetching PR review comments...',
        (fetchedPrReview: PrReviewData) => `PR fetched: #${fetchedPrReview.number} ${fetchedPrReview.title}`,
        async () => provider.fetchPrReviewComments(prNumber, cwd),
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      error(`Failed to fetch PR review comments #${prNumber}: ${msg}`);
      return;
    }

    if (prReview.reviews.length === 0 && prReview.comments.length === 0) {
      error(`PR #${prNumber} has no review comments`);
      return;
    }

    const taskContent = formatPrReviewAsTask(prReview);
    const workflow = await determineWorkflow(cwd, opts?.workflow);
    if (workflow === null) {
      info('Cancelled.');
      return;
    }

    const settings = {
      worktree: true,
      branch: prReview.headRefName,
      baseBranch: prReview.baseRefName,
      autoPr: false,
      shouldPublishBranchToOrigin: true,
    };
    const created = await saveTaskFile(cwd, taskContent, { workflow, ...settings, prNumber });
    displayTaskCreationResult(created, settings, workflow);
    return;
  }

  if (!trimmedTask) {
    info('Usage: takt add <task>');
    return;
  }

  let taskContent: string;
  let issueNumber: number | undefined;

  if (isIssueReference(trimmedTask)) {
    try {
      const numbers = parseIssueNumbers([trimmedTask]);
      const primaryIssueNumber = numbers[0];
      taskContent = await withProgress(
        'Fetching issue...',
        primaryIssueNumber ? `Issue fetched: #${primaryIssueNumber}` : 'Issue fetched',
        async () => resolveIssueTask(trimmedTask, cwd),
      );
      if (numbers.length > 0) {
        issueNumber = numbers[0];
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      log.error('Failed to fetch issue', { task: trimmedTask, error: msg });
      info(`Failed to fetch issue ${trimmedTask}: ${msg}`);
      return;
    }
  } else {
    taskContent = rawTask;
  }

  const workflow = await determineWorkflow(cwd, opts?.workflow);
  if (workflow === null) {
    info('Cancelled.');
    return;
  }

  const settings = await promptWorktreeSettings(cwd);

  const created = await saveTaskFile(cwd, taskContent, {
    workflow,
    issue: issueNumber,
    ...settings,
  });

  displayTaskCreationResult(created, settings, workflow);
}
