/**
 * Retry actions for failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and queue persistence.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import type { TaskFailure, TaskListItem } from '../../../infra/task/index.js';
import { resolveWorkflowConfigValue, getWorkflowDescription } from '../../../infra/config/index.js';
import { selectOptionWithDefault } from '../../../shared/prompt/index.js';
import { info, header, blankLine, status, warn } from '../../../shared/ui/index.js';
import type {
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowResumePoint,
} from '../../../core/models/index.js';
import {
  loadRunSessionContext,
  getRunPaths,
  formatRunSessionForPrompt,
  runTaskRetryMode,
  resolveLanguage,
  type RetryContext,
  type RetryFailureInfo,
  type RetryRunInfo,
} from '../../interactive/index.js';
import { cleanupInteractiveResultAttachments } from '../../interactive/imageAttachments.js';
import { appendRetryNote, persistFailedTaskRetry } from '../taskRetryPersistence.js';
import {
  buildAutoRequeueNote,
  DEPRECATED_PROVIDER_CONFIG_WARNING,
  hasDeprecatedProviderConfig,
  selectWorkflowWithOptionalReuse,
} from './requeueHelpers.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import type { PullRequestContext } from '../../../core/workflow/pr-context.js';
import { resolveTaskPullRequestWorktreeContext } from '../pullRequestWorktreeContext.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import {
  selectTaskRetryStart,
  InvalidTaskRetryResumeWithoutRestartError,
  resolveTaskRetryStartOwnership,
  type TaskRetryStartSelection,
} from './taskRetryStartSelection.js';
import {
  buildFailedTaskRetryStartContext,
  prepareFailedTaskRetry,
  type FailedTaskRetryStartContext,
  type FailedTaskRetryPreparation,
} from '../taskRetryPreparation.js';

interface FailedTaskRetrySelection extends FailedTaskRetryPreparation {
  selectedWorkflow: string;
  startStep: string | undefined;
  selectedResumePoint: FailedTaskRetryPreparation['resumePoint'];
  selectedRestartPoint: WorkflowRestartPoint | undefined;
  selectedWorkflowOverride: string | undefined;
}

function displayFailureInfo(task: TaskListItem, failure: TaskFailure): void {
  header(`Failed Task: ${sanitizeTerminalText(task.name)}`);
  info(`  Failed at: ${task.createdAt}`);

  blankLine();
  if (failure.step) {
    status('Failed at', sanitizeTerminalText(failure.step), 'red');
  }
  status('Error', sanitizeTerminalText(failure.error), 'red');
  if (failure.last_message) {
    status('Last message', sanitizeTerminalText(failure.last_message));
  }

  blankLine();
}

async function selectRetryStart(
  workflowConfig: WorkflowConfig,
  options: {
    projectCwd: string;
    lookupCwd: string;
    resumePoint?: WorkflowResumePoint;
    preferredRootStep?: string;
  },
): Promise<TaskRetryStartSelection | null> {
  const result = await selectTaskRetryStart(
    workflowConfig,
    options,
    (message, candidates, defaultValue) => selectOptionWithDefault(
      message,
      candidates,
      defaultValue,
    ),
  );
  if (result === null) {
    return null;
  }
  info(`Selected start position: ${result.label}`);
  return result.selection;
}

function buildRetryFailureInfo(task: TaskListItem, failure: TaskFailure): RetryFailureInfo {
  return {
    taskName: task.name,
    taskContent: task.content,
    createdAt: task.createdAt,
    failedStep: failure.step ?? '',
    error: failure.error,
    lastMessage: failure.last_message ?? '',
    retryNote: task.data?.retry_note ?? '',
  };
}

function buildRetryRunInfo(
  runsBaseDir: string,
  slug: string,
): RetryRunInfo {
  const paths = getRunPaths(runsBaseDir, slug);
  const sessionContext = loadRunSessionContext(runsBaseDir, slug);
  const formatted = formatRunSessionForPrompt(sessionContext);
  return {
    logsDir: paths.logsDir,
    reportsDir: paths.reportsDir,
    task: formatted.runTask,
    workflow: formatted.runWorkflow,
    status: formatted.runStatus,
    stepLogs: formatted.runStepLogs,
    reports: formatted.runReports,
  };
}

function resolveTaskRetryPullRequestContext(
  task: TaskListItem,
  projectDir: string,
  worktreePath: string,
): PullRequestContext | undefined {
  const data = task.data;
  if (data?.source !== 'pr_review') {
    return undefined;
  }
  if (data.pr_number === undefined) {
    throw new Error(`PR review task "${sanitizeTerminalText(task.name)}" is missing pr_number.`);
  }
  if (!data.branch?.trim()) {
    throw new Error(`PR review task "${sanitizeTerminalText(task.name)}" is missing head branch.`);
  }

  return resolveTaskPullRequestWorktreeContext({
    projectDir,
    worktreePath,
    taskName: task.name,
    prNumber: data.pr_number,
    headBranch: data.branch,
    ...(data.base_branch === undefined ? {} : { savedBaseBranch: data.base_branch }),
  });
}

async function prepareFailedTaskRetrySelection(
  task: TaskListItem,
  projectDir: string,
): Promise<FailedTaskRetrySelection | null> {
  const preparation = prepareFailedTaskRetry(task, projectDir);
  displayFailureInfo(task, preparation.failure);

  const selectedWorkflow = await selectWorkflowWithOptionalReuse(
    projectDir,
    preparation.previousWorkflow,
    preparation.worktreePath,
  );
  if (!selectedWorkflow) {
    info('Cancelled');
    return null;
  }

  let startContext: FailedTaskRetryStartContext;
  try {
    startContext = buildFailedTaskRetryStartContext(preparation, projectDir, selectedWorkflow);
  } catch (error) {
    if (!(error instanceof InvalidTaskRetryResumeWithoutRestartError)) {
      throw error;
    }
    warn(sanitizeTerminalText(error.message));
    return null;
  }
  const selectedStart = await selectRetryStart(startContext.workflowConfig, startContext.options);
  if (selectedStart === null) {
    return null;
  }

  if (hasDeprecatedProviderConfig(preparation.previousOrderContent)) {
    warn(DEPRECATED_PROVIDER_CONFIG_WARNING);
  }

  const retryStartOwnership = resolveTaskRetryStartOwnership(selectedStart, startContext.workflowConfig);

  return {
    ...preparation,
    selectedWorkflow,
    startStep: retryStartOwnership.startStep,
    selectedResumePoint: retryStartOwnership.resumePoint,
    selectedRestartPoint: retryStartOwnership.restartPoint,
    selectedWorkflowOverride: startContext.workflowOverride,
  };
}

export async function requeueFailedTask(
  task: TaskListItem,
  projectDir: string,
): Promise<boolean> {
  const selection = await prepareFailedTaskRetrySelection(task, projectDir);
  if (!selection) {
    return false;
  }

  const retryNote = appendRetryNote(
    task.data?.retry_note,
    buildAutoRequeueNote({
      ...selection.failure,
      step: selection.failedStep,
    }),
  );
  await persistFailedTaskRetry({
    task,
    projectDir,
    worktreePath: selection.worktreePath,
    startStep: selection.startStep,
    retryNote,
    resumePoint: selection.selectedResumePoint,
    workflow: selection.selectedWorkflowOverride,
    taskDir: undefined,
    sourceRunSlug: selection.matchedRunSlug,
    restartPoint: selection.selectedRestartPoint,
  });

  info(`Task "${sanitizeTerminalText(task.name)}" has been requeued.`);
  return true;
}

/**
 * Retry a failed task.
 *
 * Runs the retry conversation in the existing worktree, then persists the
 * revised order and returns the task to the queue without starting a worker.
 *
 * @returns true if the revised task was queued, false if cancelled
 */
export async function retryFailedTask(
  task: TaskListItem,
  projectDir: string,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  const selection = await prepareFailedTaskRetrySelection(task, projectDir);
  if (!selection) {
    return false;
  }
  const runInfo = selection.matchedRunSlug && selection.runMeta
    ? buildRetryRunInfo(selection.worktreePath, selection.matchedRunSlug)
    : null;
  const previewCount = resolveWorkflowConfigValue(projectDir, 'interactivePreviewSteps');
  const lang = resolveLanguage(resolveWorkflowConfigValue(selection.worktreePath, 'language'));
  const workflowDesc = getWorkflowDescription(
    selection.selectedWorkflow,
    projectDir,
    previewCount,
    selection.worktreePath,
    agentOverrides,
  );
  const workflowContext = {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
  };

  blankLine();
  const prContext = resolveTaskRetryPullRequestContext(task, projectDir, selection.worktreePath);
  const retryContext: RetryContext = {
    failure: buildRetryFailureInfo(task, selection.failure),
    subject: {
      kind: 'branch',
      value: task.branch ?? task.name,
    },
    workflowContext,
    run: runInfo,
    previousOrderContent: selection.previousOrderContent,
    ...(prContext ? { prContext } : {}),
  };

  const displayTaskName = sanitizeTerminalText(task.name);
  const retryResult = await runTaskRetryMode(selection.worktreePath, retryContext, {
    taskName: displayTaskName,
    subjectValue: task.branch ?? displayTaskName,
  });
  try {
    if (retryResult.action === 'cancel') {
      return false;
    }

    // User-authored requirements are stored in order.md. Existing retry_note
    // is retained only for historical/automatic attempt diagnostics.
    const executionRetryNote = retryResult.source === 'go'
      ? undefined
      : task.data?.retry_note;
    if (retryResult.action !== 'save_task') {
      throw new Error('Retry must finish by queueing the revised task.');
    }
    await persistFailedTaskRetry({
      task,
      projectDir,
      worktreePath: selection.worktreePath,
      startStep: selection.startStep,
      retryNote: executionRetryNote,
      resumePoint: selection.selectedResumePoint,
      workflow: selection.selectedWorkflowOverride,
      taskDir: task.taskDir,
      sourceRunSlug: selection.matchedRunSlug,
      restartPoint: selection.selectedRestartPoint,
      ...(retryResult.source === 'go'
        ? {
          revisedOrder: {
            content: retryResult.task,
            lang,
            attachments: retryResult.attachments,
          },
        }
        : {}),
    });
    info(`Task "${sanitizeTerminalText(task.name)}" has been requeued.`);
    return true;
  } finally {
    cleanupInteractiveResultAttachments(retryResult);
  }
}
