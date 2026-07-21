/**
 * Retry actions for failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and direct re-execution.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import * as fs from 'node:fs';
import type { TaskFailure, TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner, resolveTaskWorkflowValue } from '../../../infra/task/index.js';
import { loadWorkflowByIdentifier, resolveWorkflowConfigValue, getWorkflowDescription } from '../../../infra/config/index.js';
import { selectOptionWithDefault } from '../../../shared/prompt/index.js';
import { info, header, blankLine, status, warn } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { WorkflowConfig, WorkflowResumePoint } from '../../../core/models/index.js';
import { readRunMetaBySlug, type RunMeta } from '../../../core/workflow/run/run-meta.js';
import {
  findRunForTask,
  loadRunSessionContext,
  getRunPaths,
  formatRunSessionForPrompt,
  runTaskRetryMode,
  findPreviousOrderContent,
  type RetryContext,
  type RetryFailureInfo,
  type RetryRunInfo,
} from '../../interactive/index.js';
import { cleanupInteractiveResultAttachments } from '../../interactive/imageAttachments.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import {
  appendRetryNote,
  buildAutoRequeueNote,
  DEPRECATED_PROVIDER_CONFIG_WARNING,
  hasDeprecatedProviderConfig,
  resolveSelectedWorkflowOverride,
  selectWorkflowWithOptionalReuse,
} from './requeueHelpers.js';
import { prepareTaskForExecution } from './prepareTaskForExecution.js';
import {
  cleanupPreparedRetryTaskSpec,
  prepareRetryTaskSpecWithAttachments,
} from '../retryTaskSpecAttachments.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { workflowEntryMatchesWorkflow } from '../../../core/workflow/workflow-reference.js';

const log = createLogger('list-tasks');

interface FailedTaskRetrySelection {
  worktreePath: string;
  failure: TaskFailure;
  failedStep: string | undefined;
  matchedSlug: string | null;
  runMeta: RunMeta | null;
  selectedWorkflow: string;
  previousOrderContent: string | null;
  startStep: string | undefined;
  selectedResumePoint: WorkflowResumePoint | undefined;
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

function resolveRetryRunSlug(task: TaskListItem, worktreePath: string): string | null {
  return task.runSlug ?? findRunForTask(worktreePath, task.content);
}

function readRetryRunMeta(worktreePath: string, runSlug: string | null): RunMeta | null {
  if (!runSlug) {
    return null;
  }

  return readRunMetaBySlug(worktreePath, runSlug, (warningMessage) => {
    warn(warningMessage);
  });
}

function resolveRetryResumePoint(
  task: TaskListItem,
  runMeta: RunMeta | null,
): WorkflowResumePoint | undefined {
  const metaResumePoint = runMeta?.resumePoint;
  if (metaResumePoint) {
    return metaResumePoint;
  }

  return task.data?.resume_point;
}

function resolveRetryDefaultStep(
  workflowConfig: WorkflowConfig,
  failure: TaskFailure,
  resumePoint: WorkflowResumePoint | undefined,
): string | null {
  const rootEntry = resumePoint?.stack[0];
  if (
    rootEntry
    && workflowEntryMatchesWorkflow(rootEntry, workflowConfig)
    && workflowConfig.steps.some((step) => step.name === rootEntry.step)
  ) {
    return rootEntry.step;
  }

  return failure.step ?? null;
}

function resolveFailureStepForRequeueNote(
  failure: TaskFailure,
  runMeta: RunMeta | null,
  resumePoint: WorkflowResumePoint | undefined,
): string | undefined {
  const failureStep = failure.step?.trim();
  if (failureStep) {
    return failureStep;
  }

  const currentStep = runMeta?.currentStep?.trim();
  if (currentStep) {
    return currentStep;
  }

  const resumeStep = resumePoint?.stack[0]?.step.trim();
  if (resumeStep) {
    return resumeStep;
  }

  return undefined;
}

function requireFailedStepForRequeueNote(failedStep: string | undefined): string {
  if (!failedStep) {
    throw new Error('Failed task step name could not be resolved for auto requeue note.');
  }
  return failedStep;
}

function shouldResumeFromSelectedStep(
  workflowConfig: WorkflowConfig,
  selectedStep: string,
  resumePoint: WorkflowResumePoint | undefined,
): resumePoint is WorkflowResumePoint {
  const rootEntry = resumePoint?.stack[0];
  if (!rootEntry) {
    return false;
  }

  return workflowEntryMatchesWorkflow(rootEntry, workflowConfig)
    && rootEntry.step === selectedStep
    && workflowConfig.steps.some((step) => step.name === rootEntry.step);
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

function requireFailedTaskFailure(task: TaskListItem): TaskFailure {
  if (!task.failure) {
    throw new Error(`Failed task "${sanitizeTerminalText(task.name)}" is missing failure details.`);
  }
  if (task.failure.error.trim() === '') {
    throw new Error(`Failed task "${sanitizeTerminalText(task.name)}" has empty failure.error.`);
  }
  return task.failure;
}

async function prepareFailedTaskRetrySelection(
  task: TaskListItem,
  projectDir: string,
): Promise<FailedTaskRetrySelection | null> {
  if (task.kind !== 'failed') {
    throw new Error(`Failed task retry action requires failed task. received: ${task.kind}`);
  }

  const failure = requireFailedTaskFailure(task);
  const worktreePath = resolveWorktreePath(task);

  displayFailureInfo(task, failure);

  const matchedSlug = resolveRetryRunSlug(task, worktreePath);
  const runMeta = readRetryRunMeta(worktreePath, matchedSlug);
  const previousWorkflow = task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;

  const selectedWorkflow = await selectWorkflowWithOptionalReuse(
    projectDir,
    previousWorkflow,
    worktreePath,
  );
  if (!selectedWorkflow) {
    info('Cancelled');
    return null;
  }

  const workflowConfig = loadWorkflowByIdentifier(selectedWorkflow, projectDir, { lookupCwd: worktreePath });
  if (!workflowConfig) {
    throw new Error(`Workflow "${sanitizeTerminalText(selectedWorkflow)}" not found after selection.`);
  }

  const resumePoint = resolveRetryResumePoint(task, runMeta);
  const failedStep = resolveFailureStepForRequeueNote(failure, runMeta, resumePoint);
  const selectedStep = await selectStartStep(
    workflowConfig,
    resolveRetryDefaultStep(workflowConfig, failure, resumePoint),
  );
  if (selectedStep === null) {
    return null;
  }

  const previousOrderContent = findPreviousOrderContent(worktreePath, matchedSlug);
  if (hasDeprecatedProviderConfig(previousOrderContent)) {
    warn(DEPRECATED_PROVIDER_CONFIG_WARNING);
  }

  const startStep = selectedStep !== workflowConfig.initialStep
    ? selectedStep
    : undefined;
  const selectedResumePoint = shouldResumeFromSelectedStep(workflowConfig, selectedStep, resumePoint)
    ? resumePoint
    : undefined;
  const selectedWorkflowOverride = resolveSelectedWorkflowOverride(previousWorkflow, selectedWorkflow);

  return {
    worktreePath,
    failure,
    failedStep,
    matchedSlug,
    runMeta,
    selectedWorkflow,
    previousOrderContent,
    startStep,
    selectedResumePoint,
    selectedWorkflowOverride,
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
      step: requireFailedStepForRequeueNote(selection.failedStep),
    }),
  );
  const runner = new TaskRunner(projectDir);

  runner.requeueTask(
    task.name,
    ['failed'],
    selection.startStep,
    retryNote,
    selection.selectedResumePoint,
    selection.selectedWorkflowOverride,
    undefined,
    selection.matchedSlug ?? undefined,
  );

  info(`Task "${sanitizeTerminalText(task.name)}" has been requeued.`);
  return true;
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
  const selection = await prepareFailedTaskRetrySelection(task, projectDir);
  if (!selection) {
    return false;
  }
  const runInfo = selection.matchedSlug && selection.runMeta
    ? buildRetryRunInfo(selection.worktreePath, selection.matchedSlug)
    : null;
  const previewCount = resolveWorkflowConfigValue(projectDir, 'interactivePreviewSteps');
  const workflowDesc = getWorkflowDescription(selection.selectedWorkflow, projectDir, previewCount, selection.worktreePath);
  const workflowContext = {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
  };

  blankLine();
  const retryContext: RetryContext = {
    failure: buildRetryFailureInfo(task, selection.failure),
    subject: {
      kind: 'branch',
      value: task.branch ?? task.name,
    },
    workflowContext,
    run: runInfo,
    previousOrderContent: selection.previousOrderContent,
  };

  const retryResult = await runTaskRetryMode(selection.worktreePath, retryContext);
  try {
    if (retryResult.action === 'cancel') {
      return false;
    }

    const retryNote = appendRetryNote(task.data?.retry_note, retryResult.task);
    const preparedSpec = prepareRetryTaskSpecWithAttachments(projectDir, task.content, retryNote, retryResult.attachments, task.taskDir);
    const executionRetryNote = preparedSpec ? preparedSpec.retryNote : retryNote;
    const taskDir = preparedSpec?.taskDirRelative;
    const runner = new TaskRunner(projectDir);

    if (retryResult.action === 'save_task') {
      try {
        runner.requeueTask(
          task.name,
          ['failed'],
          selection.startStep,
          executionRetryNote,
          selection.selectedResumePoint,
          selection.selectedWorkflowOverride,
          taskDir,
          selection.matchedSlug ?? undefined,
        );
      } catch (error) {
        cleanupPreparedRetryTaskSpec(preparedSpec);
        throw error;
      }
      info(`Task "${sanitizeTerminalText(task.name)}" has been requeued.`);
      return true;
    }

    let taskInfo: ReturnType<TaskRunner['startReExecution']>;
    try {
      taskInfo = runner.startReExecution(
        task.name,
        ['failed'],
        'retry',
        selection.startStep,
        executionRetryNote,
        selection.selectedResumePoint,
        selection.selectedWorkflowOverride,
        taskDir,
        selection.matchedSlug ?? undefined,
      );
    } catch (error) {
      cleanupPreparedRetryTaskSpec(preparedSpec);
      throw error;
    }
    const taskForExecution = prepareTaskForExecution(taskInfo, selection.selectedWorkflow);

    log.info('Starting re-execution of failed task', {
      name: task.name,
      worktreePath: selection.worktreePath,
      startStep: selection.startStep,
    });

    return executeAndCompleteTask(taskForExecution, runner, projectDir);
  } finally {
    cleanupInteractiveResultAttachments(retryResult);
  }
}
