/**
 * Retry actions for failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and direct re-execution.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import * as fs from 'node:fs';
import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner, resolveTaskWorkflowValue } from '../../../infra/task/index.js';
import { loadWorkflowByIdentifier, resolveWorkflowConfigValue, getWorkflowDescription } from '../../../infra/config/index.js';
import { selectOptionWithDefault } from '../../../shared/prompt/index.js';
import { info, header, blankLine, status, warn } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import {
  findRunForTask,
  loadRunSessionContext,
  getRunPaths,
  formatRunSessionForPrompt,
  runRetryMode,
  findPreviousOrderContent,
  type RetryContext,
  type RetryFailureInfo,
  type RetryRunInfo,
} from '../../interactive/index.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import {
  appendRetryNote,
  DEPRECATED_PROVIDER_CONFIG_WARNING,
  hasDeprecatedProviderConfig,
  selectWorkflowWithOptionalReuse,
} from './requeueHelpers.js';
import { prepareTaskForExecution } from './prepareTaskForExecution.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';

const log = createLogger('list-tasks');

function displayFailureInfo(task: TaskListItem): void {
  header(`Failed Task: ${sanitizeTerminalText(task.name)}`);
  info(`  Failed at: ${task.createdAt}`);

  if (task.failure) {
    blankLine();
    if (task.failure.step) {
      status('Failed at', sanitizeTerminalText(task.failure.step), 'red');
    }
    status('Error', sanitizeTerminalText(task.failure.error), 'red');
    if (task.failure.last_message) {
      status('Last message', sanitizeTerminalText(task.failure.last_message));
    }
  }

  blankLine();
}

async function selectStartStep(
  workflowConfig: WorkflowConfig,
  defaultStep: string | null,
): Promise<string | null> {
  const steps = workflowConfig.steps.map((step) => step.name);

  const defaultIdx = defaultStep
    ? steps.indexOf(defaultStep)
    : 0;
  const effectiveDefault = defaultIdx >= 0 ? steps[defaultIdx] : steps[0];

  const options = steps.map((name) => ({
    label: sanitizeTerminalText(name),
    value: name,
    description: name === workflowConfig.initialStep ? 'Initial step' : undefined,
  }));

  return await selectOptionWithDefault<string>('Start from step:', options, effectiveDefault ?? steps[0]!);
}

function buildRetryFailureInfo(task: TaskListItem): RetryFailureInfo {
  return {
    taskName: task.name,
    taskContent: task.content,
    createdAt: task.createdAt,
    failedStep: task.failure?.step ?? '',
    error: task.failure?.error ?? '',
    lastMessage: task.failure?.last_message ?? '',
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

function resolveWorktreePath(task: TaskListItem): string {
  if (!task.worktreePath) {
    throw new Error(`Worktree path is not set for task: ${task.name}`);
  }
  if (!fs.existsSync(task.worktreePath)) {
    throw new Error(`Worktree directory does not exist: ${task.worktreePath}`);
  }
  return task.worktreePath;
}

/**
 * Retry a failed task.
 *
 * Runs the retry conversation in the existing worktree, then directly
 * re-executes the task there (auto-commit + push + status update).
 *
 * @returns true if task was re-executed successfully, false if cancelled or failed
 */
export async function retryFailedTask(
  task: TaskListItem,
  projectDir: string,
): Promise<boolean> {
  if (task.kind !== 'failed') {
    throw new Error(`retryFailedTask requires failed task. received: ${task.kind}`);
  }

  const worktreePath = resolveWorktreePath(task);

  displayFailureInfo(task);

  const matchedSlug = findRunForTask(worktreePath, task.content);
  const runInfo = matchedSlug ? buildRetryRunInfo(worktreePath, matchedSlug) : null;

  const selectedWorkflow = await selectWorkflowWithOptionalReuse(
    projectDir,
    task.data ? resolveTaskWorkflowValue(task.data as Record<string, unknown>) : undefined,
  );
  if (!selectedWorkflow) {
    info('Cancelled');
    return false;
  }

  const previewCount = resolveWorkflowConfigValue(projectDir, 'interactivePreviewSteps');
  const workflowConfig = loadWorkflowByIdentifier(selectedWorkflow, projectDir);

  if (!workflowConfig) {
    throw new Error(`Workflow "${sanitizeTerminalText(selectedWorkflow)}" not found after selection.`);
  }

  const selectedStep = await selectStartStep(workflowConfig, task.failure?.step ?? null);
  if (selectedStep === null) {
    return false;
  }

  const workflowDesc = getWorkflowDescription(selectedWorkflow, projectDir, previewCount);
  const workflowContext = {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
  };

  // Runs data lives in the worktree (written during previous execution)
  const previousOrderContent = findPreviousOrderContent(worktreePath, matchedSlug);
  if (hasDeprecatedProviderConfig(previousOrderContent)) {
    warn(DEPRECATED_PROVIDER_CONFIG_WARNING);
  }

  blankLine();
  const branchName = task.branch ?? task.name;
  const retryContext: RetryContext = {
    failure: buildRetryFailureInfo(task),
    branchName,
    workflowContext,
    run: runInfo,
    previousOrderContent,
  };

  const retryResult = await runRetryMode(worktreePath, retryContext, previousOrderContent);
  if (retryResult.action === 'cancel') {
    return false;
  }

  const startStep = selectedStep !== workflowConfig.initialStep
    ? selectedStep
    : undefined;
  const retryNote = appendRetryNote(task.data?.retry_note, retryResult.task);
  const runner = new TaskRunner(projectDir);

  if (retryResult.action === 'save_task') {
    runner.requeueTask(task.name, ['failed'], startStep, retryNote);
    info(`Task "${sanitizeTerminalText(task.name)}" has been requeued.`);
    return true;
  }

  const taskInfo = runner.startReExecution(task.name, ['failed'], startStep, retryNote);
  const taskForExecution = prepareTaskForExecution(taskInfo, selectedWorkflow);

  log.info('Starting re-execution of failed task', {
    name: task.name,
    worktreePath,
    startStep,
  });

  return executeAndCompleteTask(taskForExecution, runner, projectDir);
}
