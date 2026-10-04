import {
  isDynamicParallelSubSteps,
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowRestartPointEntry,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../../core/models/index.js';
import { WorkflowRestartNavigator } from '../../core/workflow/engine/WorkflowRestartNavigator.js';
import { getWorkflowResumeFrameError } from '../../core/workflow/run/resume-point.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../../core/workflow/step-kind.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../../core/workflow/workflow-call-depth.js';
import { isWorkflowRestartTarget } from '../../core/workflow/workflow-restart-target.js';
import {
  buildWorkflowRestartPointEntry,
  getWorkflowReference,
  workflowRestartEntryMatchesWorkflow,
} from '../../core/workflow/workflow-reference.js';
import { resolveWorkflowCallTarget } from '../../infra/config/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

const TASK_RETRY_PATH_SEPARATOR = ' > ';

export interface TaskRetryStartPathContext {
  projectCwd: string;
  lookupCwd: string;
}

type TaskRetryPathSegment = string | { callStep: string; workflow: string };

export interface ResolvedTaskRetryPath {
  segments: TaskRetryPathSegment[];
}

export type TaskRetryPathResolution = ResolvedTaskRetryPath | { reason: string };

/** A selectable authored leaf step in the restart tree. */
export interface TaskRetryRestartTreeLeaf {
  kind: 'leaf';
  step: WorkflowStep;
  /** Nesting depth (root steps are 0, children of a workflow_call are +1). */
  depth: number;
  /** Unique position path within the tree, used to derive a stable row value. */
  id: string;
  restartPoint: WorkflowRestartPoint;
}

/** A non-selectable workflow_call heading that expands its child steps. */
export interface TaskRetryRestartTreeHeading {
  kind: 'heading';
  step: WorkflowStep;
  depth: number;
  id: string;
  children: TaskRetryRestartTreeNode[];
  /** Reason the branch could not be expanded (degraded rendering). */
  note?: string;
}

export type TaskRetryRestartTreeNode =
  | TaskRetryRestartTreeLeaf
  | TaskRetryRestartTreeHeading;

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
  return sanitizeTerminalText(JSON.stringify(segment));
}

export function formatTaskRetryPath(segments: readonly TaskRetryPathSegment[]): string {
  return segments
    .map((segment) => typeof segment === 'string'
      ? serializeTaskRetryPathSegment(segment)
      : `${serializeTaskRetryPathSegment(segment.callStep)} → ${serializeTaskRetryPathSegment(segment.workflow)}`)
    .join(TASK_RETRY_PATH_SEPARATOR);
}

interface TaskRetryTreeLevelContext {
  workflow: WorkflowConfig;
  stack: readonly WorkflowRestartPointEntry[];
  ancestors: readonly string[];
  depth: number;
  idPrefix: string;
}

/**
 * Expand a workflow into a restart tree: authored non-call steps become
 * selectable leaves carrying their cumulative restart stack, and each
 * workflow_call step becomes a heading that recursively expands its callee.
 * A branch that cannot be resolved (unknown/non-callable/cycle/depth) is kept
 * as a heading annotated with the reason instead of aborting the whole tree.
 * Headings that expand to no selectable descendant are pruned.
 */
export function buildTaskRetryRestartTree(
  rootWorkflow: WorkflowConfig,
  context: TaskRetryStartPathContext,
): TaskRetryRestartTreeNode[] {
  return buildTaskRetryTreeLevel(
    {
      workflow: rootWorkflow,
      stack: [],
      ancestors: [getWorkflowReference(rootWorkflow)],
      depth: 0,
      idPrefix: '',
    },
    context,
  );
}

function buildTaskRetryTreeLevel(
  level: TaskRetryTreeLevelContext,
  context: TaskRetryStartPathContext,
): TaskRetryRestartTreeNode[] {
  const nodes: TaskRetryRestartTreeNode[] = [];
  level.workflow.steps.forEach((step, index) => {
    if (!isWorkflowRestartTarget(step)) {
      return;
    }
    const id = level.idPrefix === '' ? String(index) : `${level.idPrefix}.${index}`;
    const entry = createRestartEntry(level.workflow, step);
    if (isWorkflowCallStep(step)) {
      const heading = buildTaskRetryHeadingNode(level, step, entry, id, context);
      if (heading !== undefined) {
        nodes.push(heading);
      }
      return;
    }
    nodes.push({
      kind: 'leaf',
      step,
      depth: level.depth,
      id,
      restartPoint: { stack: [...level.stack, entry] },
    });
  });
  return nodes;
}

function buildTaskRetryHeadingNode(
  level: TaskRetryTreeLevelContext,
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
  entry: WorkflowRestartPointEntry,
  id: string,
  context: TaskRetryStartPathContext,
): TaskRetryRestartTreeHeading | undefined {
  let children: TaskRetryRestartTreeNode[] = [];
  let note: string | undefined;
  try {
    const child = resolveCallableChild(level.workflow, step, context);
    assertCallableChildBoundary(child, level.ancestors);
    children = buildTaskRetryTreeLevel(
      {
        workflow: child,
        stack: [...level.stack, entry],
        ancestors: [...level.ancestors, getWorkflowReference(child)],
        depth: level.depth + 1,
        idPrefix: id,
      },
      context,
    );
  } catch (error) {
    note = error instanceof Error ? error.message : String(error);
  }
  if (children.length === 0 && note === undefined) {
    return undefined;
  }
  return {
    kind: 'heading',
    step,
    depth: level.depth,
    id,
    children,
    ...(note === undefined ? {} : { note }),
  };
}

function resolveTaskRetryStackPathWithOptions(
  rootWorkflow: WorkflowConfig,
  stack: readonly (WorkflowResumePointEntry | WorkflowRestartPointEntry)[],
  context: TaskRetryStartPathContext,
  options: ResolveTaskRetryStackOptions,
): TaskRetryPathResolution {
  let workflow = rootWorkflow;
  let steps = rootWorkflow.steps;
  const ancestors = [getWorkflowReference(rootWorkflow)];
  const segments: TaskRetryPathSegment[] = [rootWorkflow.name];
  for (let index = 0; index < stack.length; index += 1) {
    const entry = stack[index]!;
    const reason = options.requireRestartIdentity
      ? (workflowRestartEntryMatchesWorkflow(entry as WorkflowRestartPointEntry, workflow)
        ? undefined
        : `Saved restart position ${formatTaskRetryPath([entry.workflow, entry.step])} has a workflow identity mismatch`)
      : getWorkflowResumeFrameError(workflow, entry as WorkflowResumePointEntry, steps);
    if (reason !== undefined) {
      return { reason };
    }
    const step = steps.find((candidate) => candidate.name === entry.step);
    if (step === undefined || (options.requireRestartIdentity && getWorkflowStepKind(step) !== entry.kind)) {
      return { reason: `Saved restart position ${formatTaskRetryPath([entry.workflow, entry.step])} has a missing step or step kind mismatch` };
    }
    const isTerminalEntry = index === stack.length - 1;
    if (isTerminalEntry && options.requireRestartTarget && !isWorkflowRestartTarget(step)) {
      return { reason: `Step ${formatTaskRetryPath([step.name])} is not a restart target` };
    }
    if (isWorkflowCallStep(step)) {
      let child: WorkflowConfig;
      try {
        child = resolveCallableChild(workflow, step, context);
        assertCallableChildBoundary(child, ancestors);
      } catch (error) {
        return { reason: `Saved resume position ${formatTaskRetryPath(segments)} cannot resolve child workflow: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (isTerminalEntry) {
        segments.push(step.name);
        return { segments };
      }
      segments.push({ callStep: step.name, workflow: child.name });
      workflow = child;
      steps = child.steps;
      ancestors.push(getWorkflowReference(child));
      continue;
    }
    segments.push(step.name);
    if (isTerminalEntry) {
      return { segments };
    }
    if (
      !options.allowParallelEntries
      || step.parallel === undefined
      || isDynamicParallelSubSteps(step.parallel)
    ) {
      return { reason: `Saved resume position ${formatTaskRetryPath(segments)} cannot resolve the next frame` };
    }
    steps = step.parallel;
  }
  return { reason: 'Saved resume position cannot be used: stack is empty' };
}

export function resolveTaskRetryStackPath(
  rootWorkflow: WorkflowConfig,
  stack: readonly WorkflowResumePointEntry[],
  context: TaskRetryStartPathContext,
): TaskRetryPathResolution {
  return resolveTaskRetryStackPathWithOptions(rootWorkflow, stack, context, {
    allowParallelEntries: true,
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
  if ('segments' in resolved) {
    return;
  }
  const terminalStep = restartPoint.stack.at(-1)?.step;
  throw new Error(
    `Task retry restart path cannot be resolved${terminalStep ? ` at step "${terminalStep}"` : ''}: ${resolved.reason}`,
  );
}
