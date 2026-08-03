import {
  isDynamicParallelSubSteps,
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowRestartPointEntry,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../../core/models/index.js';
import { WorkflowRestartNavigator } from '../../core/workflow/engine/WorkflowRestartNavigator.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../../core/workflow/step-kind.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../../core/workflow/workflow-call-depth.js';
import { isWorkflowRestartTarget } from '../../core/workflow/workflow-restart-target.js';
import {
  buildWorkflowRestartPointEntry,
  getWorkflowReference,
  workflowEntryMatchesWorkflow,
  workflowRestartEntryMatchesWorkflow,
} from '../../core/workflow/workflow-reference.js';
import { resolveWorkflowCallTarget } from '../../infra/config/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

const TASK_RETRY_PATH_SEPARATOR = ' > ';
export const TASK_RETRY_START_PAGE_SIZE = 50;

export interface TaskRetryStartPathContext {
  projectCwd: string;
  lookupCwd: string;
}

export interface ResolvedTaskRetryPath {
  segments: string[];
}

export interface TaskRetryRestartLevel {
  workflow: WorkflowConfig;
  stack: WorkflowRestartPointEntry[];
  segments: string[];
  ancestors: string[];
}

export interface TaskRetryRestartPageItem {
  stepIndex: number;
  step: WorkflowStep;
  restartPoint: WorkflowRestartPoint;
  segments: string[];
}

export interface TaskRetryRestartPage {
  items: TaskRetryRestartPageItem[];
  pageNumber: number;
  pageCount: number;
  previousStartIndex?: number;
  nextStartIndex?: number;
}

interface ResolveTaskRetryStackOptions {
  allowParallelEntries: boolean;
  requireRestartTarget: boolean;
  requireRestartIdentity: boolean;
}

function resolveCallableChild(
  parent: WorkflowConfig,
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
  context: TaskRetryStartPathContext,
): WorkflowConfig {
  const child = resolveWorkflowCallTarget(
    parent,
    step,
    context.projectCwd,
    context.lookupCwd,
  );
  if (child === null) {
    throw new Error(
      `workflow_call step "${step.name}" in workflow "${parent.name}" references unknown workflow "${step.call}"`,
    );
  }
  if (child.subworkflow?.callable !== true) {
    throw new Error(`workflow "${child.name}" referenced by step "${step.name}" is not callable`);
  }
  return child;
}

function assertCallableChildBoundary(
  child: WorkflowConfig,
  ancestors: readonly string[],
): void {
  const childRef = getWorkflowReference(child);
  if (ancestors.includes(childRef)) {
    throw new Error(`Detected workflow_call cycle: ${[...ancestors, childRef].join(' -> ')}`);
  }
  if (ancestors.length + 1 > MAX_WORKFLOW_CALL_DEPTH) {
    throw new Error(
      `workflow_call depth exceeds limit (${MAX_WORKFLOW_CALL_DEPTH}): ${child.name}`,
    );
  }
}

function createRestartEntry(
  workflow: WorkflowConfig,
  step: WorkflowStep,
): WorkflowRestartPointEntry {
  return buildWorkflowRestartPointEntry(
    workflow,
    step.name,
    getWorkflowStepKind(step),
    isWorkflowCallStep(step) ? 1 : undefined,
  );
}

function serializeTaskRetryPathSegment(segment: string): string {
  const serialized = JSON.stringify(segment);
  if (serialized === undefined) {
    throw new Error('Task retry path segment could not be serialized');
  }
  return sanitizeTerminalText(serialized);
}

export function formatTaskRetryPath(segments: readonly string[]): string {
  return segments
    .map(serializeTaskRetryPathSegment)
    .join(TASK_RETRY_PATH_SEPARATOR);
}

export class TaskRetryRestartBrowser {
  private readonly context: TaskRetryStartPathContext;

  constructor(context: TaskRetryStartPathContext) {
    this.context = context;
  }

  createRootLevel(rootWorkflow: WorkflowConfig): TaskRetryRestartLevel {
    return {
      workflow: rootWorkflow,
      stack: [],
      segments: [rootWorkflow.name],
      ancestors: [getWorkflowReference(rootWorkflow)],
    };
  }

  getPage(level: TaskRetryRestartLevel, startIndex: number): TaskRetryRestartPage {
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= level.workflow.steps.length) {
      throw new Error(`Invalid task retry page start index: ${startIndex}`);
    }
    const pageCount = Math.ceil(level.workflow.steps.length / TASK_RETRY_START_PAGE_SIZE);
    const pageNumber = Math.floor(startIndex / TASK_RETRY_START_PAGE_SIZE) + 1;
    const normalizedStart = (pageNumber - 1) * TASK_RETRY_START_PAGE_SIZE;
    const pageSteps = level.workflow.steps.slice(
      normalizedStart,
      normalizedStart + TASK_RETRY_START_PAGE_SIZE,
    );
    const items = pageSteps.flatMap((step, offset): TaskRetryRestartPageItem[] => {
      if (!isWorkflowRestartTarget(step)) {
        return [];
      }
      const entry = createRestartEntry(level.workflow, step);
      return [{
        stepIndex: normalizedStart + offset,
        step,
        restartPoint: {
          stack: [...level.stack, entry],
        },
        segments: [...level.segments, step.name],
      }];
    });
    const previousStartIndex = normalizedStart === 0
      ? undefined
      : normalizedStart - TASK_RETRY_START_PAGE_SIZE;
    const nextStartIndex = pageNumber === pageCount
      ? undefined
      : normalizedStart + TASK_RETRY_START_PAGE_SIZE;
    return {
      items,
      pageNumber,
      pageCount,
      ...(previousStartIndex === undefined ? {} : { previousStartIndex }),
      ...(nextStartIndex === undefined ? {} : { nextStartIndex }),
    };
  }

  openChild(
    level: TaskRetryRestartLevel,
    item: TaskRetryRestartPageItem,
  ): TaskRetryRestartLevel {
    if (!isWorkflowCallStep(item.step)) {
      throw new Error(`Task retry path step "${item.step.name}" is not a workflow_call`);
    }
    const child = resolveCallableChild(level.workflow, item.step, this.context);
    assertCallableChildBoundary(child, level.ancestors);
    return {
      workflow: child,
      stack: item.restartPoint.stack,
      segments: [...item.segments, child.name],
      ancestors: [...level.ancestors, getWorkflowReference(child)],
    };
  }
}

function resolveTaskRetryStackPathWithOptions(
  rootWorkflow: WorkflowConfig,
  stack: readonly WorkflowResumePointEntry[],
  context: TaskRetryStartPathContext,
  options: ResolveTaskRetryStackOptions,
): ResolvedTaskRetryPath | undefined {
  let workflow = rootWorkflow;
  let steps = rootWorkflow.steps;
  const ancestors = [getWorkflowReference(rootWorkflow)];
  const segments = [rootWorkflow.name];
  for (let index = 0; index < stack.length; index += 1) {
    const entry = stack[index]!;
    const entryMatchesWorkflow = options.requireRestartIdentity
      ? workflowRestartEntryMatchesWorkflow(entry as WorkflowRestartPointEntry, workflow)
      : workflowEntryMatchesWorkflow(entry, workflow);
    if (!entryMatchesWorkflow) {
      return undefined;
    }
    const step = steps.find((candidate) => candidate.name === entry.step);
    if (step === undefined || getWorkflowStepKind(step) !== entry.kind) {
      return undefined;
    }
    segments.push(step.name);
    const isTerminalEntry = index === stack.length - 1;
    if (isTerminalEntry && options.requireRestartTarget && !isWorkflowRestartTarget(step)) {
      return undefined;
    }
    if (isWorkflowCallStep(step)) {
      const child = resolveCallableChild(workflow, step, context);
      assertCallableChildBoundary(child, ancestors);
      if (isTerminalEntry) {
        return { segments };
      }
      workflow = child;
      steps = child.steps;
      ancestors.push(getWorkflowReference(child));
      segments.push(child.name);
      continue;
    }
    if (isTerminalEntry) {
      return { segments };
    }
    if (
      !options.allowParallelEntries
      || step.parallel === undefined
      || isDynamicParallelSubSteps(step.parallel)
    ) {
      return undefined;
    }
    steps = step.parallel;
  }
  return undefined;
}

export function resolveTaskRetryStackPath(
  rootWorkflow: WorkflowConfig,
  stack: readonly WorkflowResumePointEntry[],
  context: TaskRetryStartPathContext,
  allowParallelEntries: boolean,
): ResolvedTaskRetryPath | undefined {
  return resolveTaskRetryStackPathWithOptions(rootWorkflow, stack, context, {
    allowParallelEntries,
    requireRestartTarget: false,
    requireRestartIdentity: false,
  });
}

export function validateTaskRetryRestartPoint(
  rootWorkflow: WorkflowConfig,
  restartPoint: WorkflowRestartPoint,
  context: TaskRetryStartPathContext,
): void {
  new WorkflowRestartNavigator(restartPoint).resolveRootStartStep(rootWorkflow, undefined);
  const resolved = resolveTaskRetryStackPathWithOptions(rootWorkflow, restartPoint.stack, context, {
    allowParallelEntries: false,
    requireRestartTarget: true,
    requireRestartIdentity: true,
  });
  if (resolved !== undefined) {
    return;
  }
  const terminalStep = restartPoint.stack.at(-1)?.step;
  throw new Error(
    `Task retry restart path cannot be resolved${terminalStep ? ` at step "${terminalStep}"` : ''}`,
  );
}
