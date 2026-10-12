/**
 * add command implementation
 *
 * Appends a task record to .takt/tasks.yaml.
 */

import { promptInput, selectOption } from '../../../shared/prompt/index.js';
import { info, warn, error, withProgress } from '../../../shared/ui/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../../shared/constants.js';
import type { Language } from '../../../core/models/types.js';
import { saveEnqueuedTaskFile } from '../../../infra/task/enqueuedTaskFile.js';
import { determineWorkflow } from '../execute/selectAndExecute.js';
import { checkTaskNameProvider, checkTaskProviders, terminalProviderConfirmation } from '../execute/providerPreflight.js';
import { createLogger, getErrorMessage, sanitizeTerminalText } from '../../../shared/utils/index.js';
import { isIssueReference, parseIssueNumbers, formatIssueAsTask, formatPrReviewAsTask, getGitProvider } from '../../../infra/git/index.js';
import type { PrReviewData } from '../../../infra/git/index.js';
import { GitHubProvider } from '../../../infra/github/GitHubProvider.js';
import { isGithubImageAttachmentUrl } from '../../../infra/github/image-download.js';
import { extractGithubImageReferences } from '../githubImageReferences.js';
import { prepareGithubTaskImages, type PreparedGithubTaskImages } from '../githubImages.js';
import { extractTitle, createIssueFromTask, createIssueFromTaskResult } from '../../../infra/task/issueTask.js';
import { displayTaskCreationResult, promptWorktreeSettings, type WorktreeSettings } from './worktree-settings.js';
import {
  createIssueAndEnqueueTask,
  formatIssueEnqueueFailure,
  type PrepareEnqueuedTaskSpec,
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
  prepareTaskSpec?: PrepareEnqueuedTaskSpec,
  abortSignal?: AbortSignal,
): Promise<{ taskName: string; tasksFile: string }> {
  const { attachments, ...saveOptions } = options ?? {};
  await checkTaskProviders(cwd, saveOptions.workflow ?? DEFAULT_WORKFLOW_NAME, {}, terminalProviderConfirmation(), abortSignal);
  await checkTaskNameProvider(cwd, terminalProviderConfirmation(), abortSignal);
  const attachmentPrepareTaskSpec = attachments !== undefined
    ? (saveCwd: string, saveTaskContent: string) => prepareTaskSpecDirectory(saveCwd, saveTaskContent, attachments)
    : prepareTaskSpec;
  return saveEnqueuedTaskFile(cwd, taskContent, saveOptions, attachmentPrepareTaskSpec, abortSignal);
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

function isCancelledWorktreeSettings(
  settings: WorktreeSettings | { readonly kind: 'cancelled' },
): settings is { readonly kind: 'cancelled' } {
  return 'kind' in settings && settings.kind === 'cancelled';
}


/**
 * Save a task from interactive mode result.
 * Prompts for worktree/branch/auto_pr settings before saving.
 * If presetSettings is provided, skips the prompt and uses those settings directly.
 */
export async function saveTaskFromInteractive(
  cwd: string,
  task: string,
  workflow: string | undefined,
  options: SaveTaskFromInteractiveOptions & { allowCancel: true },
): Promise<Awaited<ReturnType<typeof saveTaskFile>> | { readonly kind: 'cancelled' }>;
export function saveTaskFromInteractive(
  cwd: string,
  task: string,
  workflow?: string,
  options?: SaveTaskFromInteractiveOptions,
): Promise<Awaited<ReturnType<typeof saveTaskFile>>>;
export async function saveTaskFromInteractive(
  cwd: string,
  task: string,
  workflow?: string,
  options?: SaveTaskFromInteractiveOptions,
): Promise<Awaited<ReturnType<typeof saveTaskFile>> | { readonly kind: 'cancelled' }> {
  let settings: WorktreeSettings;
  if (options?.presetSettings !== undefined) {
    settings = options.presetSettings;
  } else if (options?.allowCancel === true) {
    const promptResult = await promptWorktreeSettings(cwd, { allowCancel: true });
    if (isCancelledWorktreeSettings(promptResult)) {
      return promptResult;
    }
    settings = promptResult;
  } else {
    settings = await promptWorktreeSettings(cwd);
  }
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

interface SaveTaskFromInteractiveOptions {
  issue?: number;
  prNumber?: number;
  presetSettings?: WorktreeSettings;
  attachments?: TaskAttachment[];
  allowCancel?: boolean;
}

interface SourceIssueCommentOptions {
  number: number;
  language: Language;
}

interface CreateIssueAndSaveTaskOptions {
  labels?: string[];
  attachments?: TaskAttachment[];
  sourceIssue?: SourceIssueCommentOptions;
}

function commentOnSourceIssue(
  gitProvider: ReturnType<typeof getGitProvider>,
  cwd: string,
  sourceIssue: SourceIssueCommentOptions,
  issueNumber: number,
  issueUrl?: string,
): void {
  try {
    const comment = getLabel('issue.createdFromIssueComment', sourceIssue.language, {
      issueNumber: String(issueNumber),
      issueUrl: issueUrl === undefined ? '' : ` (${issueUrl})`,
    });
    const result = gitProvider.commentOnIssue(sourceIssue.number, comment, cwd);
    if (result.success) {
      return;
    }
    warn(getLabel('issue.sourceIssueCommentFailed', sourceIssue.language, {
      sourceIssueNumber: String(sourceIssue.number),
      error: sanitizeTerminalText(result.error),
    }));
  } catch (error) {
    warn(getLabel('issue.sourceIssueCommentFailed', sourceIssue.language, {
      sourceIssueNumber: String(sourceIssue.number),
      error: sanitizeTerminalText(getErrorMessage(error)),
    }));
  }
}

export async function createIssueAndSaveTask(
  cwd: string,
  task: string,
  workflow?: string,
  options?: CreateIssueAndSaveTaskOptions,
): Promise<void> {
  const gitProvider = getGitProvider();
  const sourceIssue = options?.sourceIssue;
  const saveInteractiveTask: SaveEnqueuedTaskFile = async (saveCwd, taskContent, saveOptions) => {
    return saveTaskFromInteractive(saveCwd, taskContent, saveOptions?.workflow, {
      issue: saveOptions?.issue,
      ...(options?.attachments ? { attachments: options.attachments } : {}),
    });
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
    ...(sourceIssue ? {
      onIssueTaskEnqueued: ({ issueNumber, issueUrl }) => {
        commentOnSourceIssue(gitProvider, cwd, sourceIssue, issueNumber, issueUrl);
      },
    } : {}),
  });
  if (!result.success) {
    if (result.failure.stage !== 'issue_creation') {
      error(formatIssueEnqueueFailure(result.failure, getErrorMessage));
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

    const hasBodyImage = provider instanceof GitHubProvider
      && extractGithubImageReferences(prReview.body).some((reference) => isGithubImageAttachmentUrl(reference.url));
    if (prReview.reviews.length === 0 && prReview.comments.length === 0 && !hasBodyImage) {
      error(`PR #${prNumber} has no review comments`);
      return;
    }

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
    const images = provider instanceof GitHubProvider ? await prepareGithubTaskImages(cwd, { prReview }) : undefined;
    try {
      const taskContent = images === undefined ? formatPrReviewAsTask(prReview) : images.task;
      const created = await saveTaskFile(cwd, taskContent, {
        workflow, ...settings, prNumber,
        ...(images !== undefined ? { attachments: images.attachments } : {}),
      });
      displayTaskCreationResult(created, settings, workflow);
    } finally {
      images?.cleanup();
    }
    return;
  }

  if (!trimmedTask) {
    info('Usage: takt add <task>');
    return;
  }

  let taskContent: string;
  let issueNumber: number | undefined;
  let images: PreparedGithubTaskImages | undefined;

  if (isIssueReference(trimmedTask)) {
    try {
      const numbers = parseIssueNumbers([trimmedTask]);
      const primaryIssueNumber = numbers[0]!;
      const provider = getGitProvider();
      const issue = await withProgress(
        'Fetching issue...',
        primaryIssueNumber ? `Issue fetched: #${primaryIssueNumber}` : 'Issue fetched',
        async () => {
          const cliStatus = provider.checkCliStatus(cwd);
          if (!cliStatus.available) throw new Error(cliStatus.error);
          return provider.fetchIssue(primaryIssueNumber, cwd);
        },
      );
      images = provider instanceof GitHubProvider ? await prepareGithubTaskImages(cwd, { issue }) : undefined;
      taskContent = images === undefined ? formatIssueAsTask(issue) : images.task;
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

  try {
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
      ...(images !== undefined ? { attachments: images.attachments } : {}),
    });
    displayTaskCreationResult(created, settings, workflow);
  } finally {
    images?.cleanup();
  }
}
