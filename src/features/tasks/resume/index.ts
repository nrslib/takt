import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { readRunContextOrderContent } from '../../../core/workflow/run/order-content.js';
import { trimResumePointStackForWorkflow } from '../../../core/workflow/run/resume-point.js';
import type { WorkflowConfig, WorkflowResumePoint } from '../../../core/models/index.js';
import {
  getWorkflowDescription,
  loadWorkflowByIdentifier,
  resolveWorkflowConfigValue,
} from '../../../infra/config/index.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/loaders/workflowCallResolver.js';
import { selectOption } from '../../../shared/prompt/index.js';
import { blankLine, header, info } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import {
  formatRunSessionForPrompt,
  loadRunSessionContext,
  runDirectRetryMode,
  type RetryContext,
  type RetryRunInfo,
  type WorkflowContext,
} from '../../interactive/index.js';
import { executeTaskWithResult } from '../execute/taskExecution.js';
import type { DirectResumeMetadata } from '../execute/runMeta.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import { buildTraceTaskMetadata } from '../execute/traceTaskMetadata.js';
import { runDirectInstructMode } from './directInstructMode.js';
import { findLatestResumableDirectRun, type ResumableDirectRun } from './directRunFinder.js';

type DirectRunResumeAction = 'requeue' | 'retry' | 'instruct' | 'view_reports' | 'cancel';

interface DirectRunResumeExecutionContext {
  readonly run: ResumableDirectRun;
  readonly taskContent: string;
  readonly previousOrderContent: string | null;
  readonly startStep: string | undefined;
  readonly resumePoint: WorkflowResumePoint | undefined;
  readonly workflowContext: WorkflowContext;
}

const DIRECT_RUN_ACTIONS: readonly { label: string; value: DirectRunResumeAction }[] = [
  { label: 'Requeue', value: 'requeue' },
  { label: 'Retry', value: 'retry' },
  { label: 'Instruct', value: 'instruct' },
  { label: 'View reports', value: 'view_reports' },
  { label: 'Cancel', value: 'cancel' },
];

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'N/A';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return sanitizeTerminalText(value);
  }
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function formatIteration(meta: ResumableDirectRun['meta']): string {
  if (meta.currentIteration === undefined || meta.iterations === undefined) {
    return 'N/A';
  }
  return `${meta.currentIteration}/${meta.iterations}`;
}

function displayRunSummary(run: ResumableDirectRun): void {
  const { meta, slug } = run;

  header('Direct run');
  blankLine();
  info(`Status: ${sanitizeTerminalText(meta.status)}`);
  info(`Workflow: ${sanitizeTerminalText(meta.workflow)}`);
  info(`Step: ${sanitizeTerminalText(meta.currentStep ?? 'N/A')}`);
  info(`Iteration: ${sanitizeTerminalText(formatIteration(meta))}`);
  info(`Run: ${sanitizeTerminalText(slug)}`);
  info(`Path: .takt/runs/${sanitizeTerminalText(slug)}`);
  info(`Started: ${formatTimestamp(meta.startTime)}`);
  info(`Updated: ${formatTimestamp(meta.updatedAt)}`);
  blankLine();
}

interface ResolvedTaskContent {
  readonly taskContent: string;
  readonly previousOrderContent: string | null;
}

function resolveTaskContent(projectDir: string, run: ResumableDirectRun): ResolvedTaskContent {
  const orderContent = readRunContextOrderContent(projectDir, run.slug)?.trim();
  if (orderContent) {
    return {
      taskContent: orderContent,
      previousOrderContent: orderContent,
    };
  }
  const metaTask = run.meta.task.trim();
  if (!metaTask) {
    throw new Error(`Direct run "${sanitizeTerminalText(run.slug)}" does not contain task instructions.`);
  }
  return {
    taskContent: metaTask,
    previousOrderContent: null,
  };
}

function resolveResumePoint(
  projectDir: string,
  workflowConfig: WorkflowConfig,
  run: ResumableDirectRun,
): WorkflowResumePoint | undefined {
  return trimResumePointStackForWorkflow({
    workflow: workflowConfig,
    resumePoint: run.meta.resumePoint,
    resolveWorkflowCall: (parentWorkflow, step) =>
      resolveWorkflowCallTarget(parentWorkflow, step.call, step.name, projectDir, projectDir),
  });
}

function resolveStartStep(
  workflowConfig: WorkflowConfig,
  run: ResumableDirectRun,
  resumePoint: WorkflowResumePoint | undefined,
): string | undefined {
  const resumeStep = resumePoint?.stack[0]?.step;
  if (resumeStep && workflowConfig.steps.some((step) => step.name === resumeStep)) {
    return resumeStep;
  }

  const currentStep = run.meta.currentStep?.trim();
  if (currentStep && workflowConfig.steps.some((step) => step.name === currentStep)) {
    return currentStep;
  }

  return undefined;
}

function loadWorkflow(projectDir: string, run: ResumableDirectRun): WorkflowConfig {
  const workflowConfig = loadWorkflowByIdentifier(run.meta.workflow, projectDir, { lookupCwd: projectDir });
  if (!workflowConfig) {
    throw new Error(`Workflow "${sanitizeTerminalText(run.meta.workflow)}" not found for direct run "${sanitizeTerminalText(run.slug)}".`);
  }
  return workflowConfig;
}

function buildWorkflowContext(projectDir: string, workflowIdentifier: string): WorkflowContext {
  const previewCount = resolveWorkflowConfigValue(projectDir, 'interactivePreviewSteps');
  const workflowDesc = getWorkflowDescription(workflowIdentifier, projectDir, previewCount, projectDir);
  return {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
  };
}

function buildExecutionContext(projectDir: string, run: ResumableDirectRun): DirectRunResumeExecutionContext {
  const workflowConfig = loadWorkflow(projectDir, run);
  const resumePoint = resolveResumePoint(projectDir, workflowConfig, run);
  const resolvedTask = resolveTaskContent(projectDir, run);
  return {
    run,
    taskContent: resolvedTask.taskContent,
    previousOrderContent: resolvedTask.previousOrderContent,
    startStep: resolveStartStep(workflowConfig, run, resumePoint),
    resumePoint,
    workflowContext: buildWorkflowContext(projectDir, run.meta.workflow),
  };
}

function buildDirectResumeMetadata(
  run: ResumableDirectRun,
  resumeMode: DirectResumeMetadata['resumeMode'],
): DirectResumeMetadata {
  return {
    sourceRunSlug: run.slug,
    resumeMode,
  };
}

async function executeDirectResume(
  projectDir: string,
  context: DirectRunResumeExecutionContext,
  resumeMode: DirectResumeMetadata['resumeMode'],
  agentOverrides: TaskExecutionOptions | undefined,
  retryNote?: string,
): Promise<boolean> {
  const result = await executeTaskWithResult({
    task: context.taskContent,
    cwd: projectDir,
    projectCwd: projectDir,
    workflowIdentifier: context.run.meta.workflow,
    agentOverrides,
    startStep: context.startStep,
    retryNote,
    resumePoint: context.resumePoint,
    directResume: buildDirectResumeMetadata(context.run, resumeMode),
    traceTaskMetadata: buildTraceTaskMetadata({
      taskContent: context.taskContent,
      taskSlug: context.run.slug,
    }),
  });
  return result.success;
}

function requireConversationNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed === '') {
    throw new Error('Direct run resume instruction is empty.');
  }
  return trimmed;
}

function buildRetryRunInfo(projectDir: string, run: ResumableDirectRun): RetryRunInfo {
  const paths = buildRunPaths(projectDir, run.slug);
  const formatted = formatRunSessionForPrompt(loadRunSessionContext(projectDir, run.slug));
  return {
    logsDir: paths.logsAbs,
    reportsDir: paths.reportsAbs,
    task: formatted.runTask,
    workflow: formatted.runWorkflow,
    status: formatted.runStatus,
    stepLogs: formatted.runStepLogs,
    reports: formatted.runReports,
  };
}

function buildRetryContext(
  projectDir: string,
  context: DirectRunResumeExecutionContext,
): RetryContext {
  const failedStep = context.run.meta.currentStep ?? context.resumePoint?.stack[0]?.step ?? '';
  return {
    failure: {
      taskName: context.run.slug,
      taskContent: context.taskContent,
      createdAt: context.run.meta.startTime,
      failedStep,
      error: `Direct run ended with status: ${context.run.meta.status}`,
      lastMessage: '',
      retryNote: '',
    },
    subject: {
      kind: 'run',
      value: context.run.slug,
    },
    workflowContext: context.workflowContext,
    run: buildRetryRunInfo(projectDir, context.run),
    previousOrderContent: context.previousOrderContent,
  };
}

async function retryDirectRun(
  projectDir: string,
  context: DirectRunResumeExecutionContext,
  agentOverrides: TaskExecutionOptions | undefined,
): Promise<boolean> {
  const retryContext = buildRetryContext(projectDir, context);
  const retryResult = await runDirectRetryMode(projectDir, retryContext);
  if (retryResult.action === 'cancel') {
    return false;
  }
  return executeDirectResume(
    projectDir,
    context,
    'retry',
    agentOverrides,
    requireConversationNote(retryResult.task),
  );
}

async function instructDirectRun(
  projectDir: string,
  context: DirectRunResumeExecutionContext,
  agentOverrides: TaskExecutionOptions | undefined,
): Promise<boolean> {
  const result = await runDirectInstructMode({
    cwd: projectDir,
    runSlug: context.run.slug,
    taskContent: context.taskContent,
    workflowContext: context.workflowContext,
    runSessionContext: loadRunSessionContext(projectDir, context.run.slug),
    previousOrderContent: context.previousOrderContent,
  });
  if (result.action === 'cancel') {
    return false;
  }
  return executeDirectResume(
    projectDir,
    context,
    'instruct',
    agentOverrides,
    requireConversationNote(result.task),
  );
}

function showRunPaths(projectDir: string, run: ResumableDirectRun): void {
  const paths = buildRunPaths(projectDir, run.slug);
  info(`Run: ${paths.runRootRel}`);
  info(`Reports: ${paths.reportsRel}`);
  info(`Logs: ${paths.logsRel}`);
  info(`Meta: ${paths.metaRel}`);
}

export async function resumeDirectRun(
  projectDir: string,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  const run = findLatestResumableDirectRun(projectDir);
  if (!run) {
    info('No resumable direct run found. Use `takt list` for queued tasks.');
    return false;
  }

  displayRunSummary(run);
  const action = await selectOption<DirectRunResumeAction>('Select action:', [...DIRECT_RUN_ACTIONS]);
  if (action === null || action === 'cancel') {
    return false;
  }
  if (action === 'view_reports') {
    showRunPaths(projectDir, run);
    return true;
  }

  const context = buildExecutionContext(projectDir, run);
  if (action === 'requeue') {
    return executeDirectResume(projectDir, context, 'requeue', agentOverrides);
  }
  if (action === 'retry') {
    return retryDirectRun(projectDir, context, agentOverrides);
  }
  return instructDirectRun(projectDir, context, agentOverrides);
}
