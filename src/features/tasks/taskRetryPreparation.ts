import {
  type TaskFailure,
  type TaskListItem,
  resolveTaskWorkflowValue,
} from '../../infra/task/index.js';
import { loadWorkflowByIdentifier } from '../../infra/config/index.js';
import type {
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowResumePoint,
} from '../../core/models/index.js';
import { readRunMetaBySlug, type RunMeta } from '../../core/workflow/run/run-meta.js';
import { workflowEntryMatchesWorkflow } from '../../core/workflow/workflow-reference.js';
import { warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { resolveTaskOrderContent } from './orderRevision.js';
import { assertReusableWorktreePath } from './execute/reusedWorktree.js';
import { findRunForTask } from '../interactive/runSessionReader.js';
import { resolveSelectedWorkflowOverride } from './list/requeueHelpers.js';
import {
  buildTaskRetryStartOptions,
  resolveTaskRetryStartOption,
  resolveTaskRetryStartOwnership,
  type TaskRetryStartOptionsModel,
  type SelectTaskRetryStartOptions,
} from './list/taskRetryStartSelection.js';

export interface FailedTaskRetryPreparation {
  readonly worktreePath: string;
  readonly failure: TaskFailure;
  readonly failedStep: string | undefined;
  readonly matchedRunSlug: string | null;
  readonly runMeta: RunMeta | null;
  readonly previousWorkflow: string | undefined;
  readonly previousOrderContent: string;
  readonly resumePoint: WorkflowResumePoint | undefined;
}

export interface FailedTaskRetryStartContext {
  readonly workflowName: string;
  readonly workflowConfig: WorkflowConfig;
  readonly workflowOverride: string | undefined;
  readonly options: SelectTaskRetryStartOptions;
  readonly startOptions: TaskRetryStartOptionsModel;
}

export interface ResolvedFailedTaskRetryStart {
  readonly label: string;
  readonly startStep: string | undefined;
  readonly resumePoint: WorkflowResumePoint | undefined;
  readonly restartPoint: WorkflowRestartPoint | undefined;
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

function resolveWorktreePath(projectDir: string, task: TaskListItem): string {
  if (!task.worktreePath) {
    throw new Error(`Worktree path is not set for task: ${task.name}`);
  }
  assertReusableWorktreePath(projectDir, task.worktreePath);
  return task.worktreePath;
}

function resolveRetryRunSlug(task: TaskListItem, worktreePath: string): string | null {
  return task.runSlug ?? findRunForTask(worktreePath, task.content);
}

function readRetryRunMeta(worktreePath: string, runSlug: string | null): RunMeta | null {
  if (!runSlug) {
    return null;
  }
  return readRunMetaBySlug(worktreePath, runSlug, warn);
}

function resolveRetryResumePoint(
  task: TaskListItem,
  runMeta: RunMeta | null,
): WorkflowResumePoint | undefined {
  return runMeta?.resumePoint ?? task.data?.resume_point;
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
  const runFailureStep = runMeta?.failure?.step.trim();
  if (runFailureStep) {
    return runFailureStep;
  }
  const currentStep = runMeta?.currentStep?.trim();
  if (currentStep) {
    return currentStep;
  }
  const resumeStep = resumePoint?.stack[0]?.step.trim();
  return resumeStep || undefined;
}

export function prepareFailedTaskRetry(
  task: TaskListItem,
  projectDir: string,
): FailedTaskRetryPreparation {
  if (task.kind !== 'failed') {
    throw new Error(`Failed task retry action requires failed task. received: ${task.kind}`);
  }

  const failure = requireFailedTaskFailure(task);
  const worktreePath = resolveWorktreePath(projectDir, task);
  const previousOrderContent = resolveTaskOrderContent(
    projectDir,
    task.taskDir,
    task.data?.task ?? task.content,
  );
  const matchedRunSlug = resolveRetryRunSlug(task, worktreePath);
  const runMeta = readRetryRunMeta(worktreePath, matchedRunSlug);
  const resumePoint = resolveRetryResumePoint(task, runMeta);
  const previousWorkflow = task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;

  return {
    worktreePath,
    failure,
    failedStep: resolveFailureStepForRequeueNote(failure, runMeta, resumePoint),
    matchedRunSlug,
    runMeta,
    previousWorkflow,
    previousOrderContent,
    resumePoint,
  };
}

function resolvePreferredRootStep(
  workflowConfig: WorkflowConfig,
  failure: TaskFailure,
  resumePoint: WorkflowResumePoint | undefined,
): string | undefined {
  const rootEntry = resumePoint?.stack[0];
  if (
    rootEntry
    && workflowEntryMatchesWorkflow(rootEntry, workflowConfig)
    && workflowConfig.steps.some((step) => step.name === rootEntry.step)
  ) {
    return rootEntry.step;
  }
  return failure.step;
}

export function buildFailedTaskRetryStartContext(
  preparation: FailedTaskRetryPreparation,
  projectDir: string,
  workflowName: string,
): FailedTaskRetryStartContext {
  const workflowConfig = loadWorkflowByIdentifier(
    workflowName,
    projectDir,
    { lookupCwd: preparation.worktreePath },
  );
  if (!workflowConfig) {
    throw new Error(`Workflow "${sanitizeTerminalText(workflowName)}" not found.`);
  }

  const preferredRootStep = resolvePreferredRootStep(
    workflowConfig,
    preparation.failure,
    preparation.resumePoint,
  );
  const options: SelectTaskRetryStartOptions = {
    projectCwd: projectDir,
    lookupCwd: preparation.worktreePath,
    ...(preparation.resumePoint === undefined ? {} : { resumePoint: preparation.resumePoint }),
    ...(preferredRootStep === undefined ? {} : { preferredRootStep }),
  };

  return {
    workflowName,
    workflowConfig,
    workflowOverride: resolveSelectedWorkflowOverride(preparation.previousWorkflow, workflowName),
    options,
    startOptions: buildTaskRetryStartOptions(workflowConfig, options),
  };
}

export function resolveFailedTaskRetryStart(
  context: FailedTaskRetryStartContext,
  startOptionId: string,
): ResolvedFailedTaskRetryStart {
  const selected = resolveTaskRetryStartOption(
    context.workflowConfig,
    context.options,
    startOptionId,
  );
  const ownership = resolveTaskRetryStartOwnership(selected.selection, context.workflowConfig);
  return {
    label: selected.label,
    startStep: ownership.startStep,
    resumePoint: ownership.resumePoint,
    restartPoint: ownership.restartPoint,
  };
}
