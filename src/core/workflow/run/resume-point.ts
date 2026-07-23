import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowStepKind,
} from '../../models/types.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../step-kind.js';
import {
  getWorkflowReference,
  workflowEntriesMatch,
  workflowEntryMatchesWorkflow,
} from '../workflow-reference.js';

export interface ResumePointStepResolver {
  (parentWorkflow: WorkflowConfig, step: WorkflowCallStep): WorkflowConfig | null;
}

interface TrimResumePointStackOptions {
  workflow: WorkflowConfig;
  resumePoint: WorkflowResumePoint | undefined;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  resolveWorkflowCall: ResumePointStepResolver;
}

interface ResolveWorkflowCallContinuationOptions {
  workflow: WorkflowConfig;
  resumePoint: WorkflowResumePoint | undefined;
  invocationRunId: string;
  resolveWorkflowCall: ResumePointStepResolver;
}

export interface WorkflowCallContinuation {
  readonly invocationRunId: string;
  readonly [WORKFLOW_CALL_CONTINUATION_BRAND]: true;
}

declare const WORKFLOW_CALL_CONTINUATION_BRAND: unique symbol;

interface WorkflowCallContinuationFrameBinding {
  readonly parentWorkflowRef: string;
  readonly callStepName: string;
  readonly persistedIteration: number;
  readonly childWorkflowRef: string;
  readonly childStepName: string;
  readonly childStepKind: WorkflowStepKind;
}

interface WorkflowCallContinuationBinding {
  readonly invocationRunId: string;
  readonly frames: readonly WorkflowCallContinuationFrameBinding[];
}

interface WorkflowCallContinuationMatch {
  continuation: WorkflowCallContinuation;
  frameIndex: number;
  parentWorkflowRef: string;
  callStepName: string;
  persistedIteration: number | undefined;
  childWorkflowRef: string;
  childStepName: string;
  childStepKind: WorkflowStepKind;
  resolvedChildWorkflowRef?: string;
  resolvedChildStepKind?: WorkflowStepKind;
}

const workflowCallContinuationBindings =
  new WeakMap<WorkflowCallContinuation, WorkflowCallContinuationBinding>();

function createWorkflowCallContinuation(
  invocationRunId: string,
  frames: readonly WorkflowCallContinuationFrameBinding[],
): WorkflowCallContinuation {
  const continuation = Object.freeze({ invocationRunId }) as WorkflowCallContinuation;
  const binding = Object.freeze({
    invocationRunId,
    frames: Object.freeze(frames.map((frame) => Object.freeze({ ...frame }))),
  });
  workflowCallContinuationBindings.set(continuation, binding);
  return continuation;
}

export function getWorkflowCallContinuationInvocationRunId(
  continuation: WorkflowCallContinuation,
): string | undefined {
  return workflowCallContinuationBindings.get(continuation)?.invocationRunId;
}

export function workflowCallContinuationMatches(
  match: WorkflowCallContinuationMatch,
): boolean {
  const frame = workflowCallContinuationBindings.get(match.continuation)?.frames[match.frameIndex];
  return frame !== undefined
    && frame.parentWorkflowRef === match.parentWorkflowRef
    && frame.callStepName === match.callStepName
    && frame.persistedIteration === match.persistedIteration
    && frame.childWorkflowRef === match.childWorkflowRef
    && frame.childStepName === match.childStepName
    && frame.childStepKind === match.childStepKind
    && (
      match.resolvedChildWorkflowRef === undefined
      || frame.childWorkflowRef === match.resolvedChildWorkflowRef
    )
    && (
      match.resolvedChildStepKind === undefined
      || frame.childStepKind === match.resolvedChildStepKind
    );
}

function matchesResumeStackPrefix(
  stack: readonly WorkflowResumePointEntry[],
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
): boolean {
  if (stack.length <= resumeStackPrefix.length) {
    return false;
  }

  return resumeStackPrefix.every((entry, index) => {
    const candidate = stack[index];
    return candidate !== undefined
      && workflowEntriesMatch(candidate, entry)
      && candidate.step === entry.step
      && candidate.kind === entry.kind;
  });
}

function canResolveResumePointSuffix(
  workflow: WorkflowConfig,
  stackSuffix: readonly WorkflowResumePointEntry[],
  resolveWorkflowCall: ResumePointStepResolver,
): boolean {
  if (stackSuffix.length === 0 || !workflowEntryMatchesWorkflow(stackSuffix[0]!, workflow)) {
    return false;
  }

  let currentWorkflow = workflow;
  for (let index = 0; index < stackSuffix.length; index += 1) {
    const entry = stackSuffix[index]!;
    if (!workflowEntryMatchesWorkflow(entry, currentWorkflow)) {
      return false;
    }

    const step = currentWorkflow.steps.find((candidate) => candidate.name === entry.step);
    if (!step) {
      return false;
    }

    if (index === stackSuffix.length - 1) {
      return true;
    }

    if (!isWorkflowCallStep(step)) {
      return false;
    }

    const childWorkflow = resolveWorkflowCall(currentWorkflow, step);
    if (!childWorkflow) {
      return false;
    }
    currentWorkflow = childWorkflow;
  }

  return true;
}

export function trimResumePointStackForWorkflow(
  options: TrimResumePointStackOptions,
): WorkflowResumePoint | undefined {
  const { workflow, resumePoint, resolveWorkflowCall } = options;
  const resumeStackPrefix = options.resumeStackPrefix ?? [];
  if (!resumePoint) {
    return undefined;
  }

  for (let stackLength = resumePoint.stack.length; stackLength > resumeStackPrefix.length; stackLength -= 1) {
    const candidateStack = resumePoint.stack.slice(0, stackLength);
    if (!matchesResumeStackPrefix(candidateStack, resumeStackPrefix)) {
      continue;
    }

    const stackSuffix = candidateStack.slice(resumeStackPrefix.length);
    if (!canResolveResumePointSuffix(workflow, stackSuffix, resolveWorkflowCall)) {
      continue;
    }

    return {
      ...resumePoint,
      stack: candidateStack,
    };
  }

  return undefined;
}

export function resolveWorkflowCallContinuation(
  options: ResolveWorkflowCallContinuationOptions,
): WorkflowCallContinuation | undefined {
  const stack = options.resumePoint?.stack;
  if (stack === undefined || stack.length < 2) {
    return undefined;
  }

  const frames: WorkflowCallContinuationFrameBinding[] = [];
  let parentWorkflow = options.workflow;
  for (let index = 0; index < stack.length - 1; index += 1) {
    const parentEntry = stack[index]!;
    const childEntry = stack[index + 1]!;
    const parentStep = parentWorkflow.steps.find((step) => step.name === parentEntry.step);
    const persistedIteration = parentEntry.step_iterations?.[parentEntry.step];
    if (
      parentStep === undefined
      || !isWorkflowCallStep(parentStep)
      || parentEntry.kind !== 'workflow_call'
      || !workflowEntryMatchesWorkflow(parentEntry, parentWorkflow)
      || !Number.isInteger(persistedIteration)
      || persistedIteration === undefined
      || persistedIteration <= 0
    ) {
      if (frames.length > 0) {
        throw new Error(
          `Persisted workflow_call continuation has an invalid parent frame at stack index ${index}`,
        );
      }
      return undefined;
    }

    const childWorkflow = options.resolveWorkflowCall(parentWorkflow, parentStep);
    if (childWorkflow === null) {
      throw new Error(
        `Persisted workflow_call continuation for step "${parentStep.name}" cannot resolve its child workflow`,
      );
    }
    if (childEntry.workflow !== childWorkflow.name) {
      throw new Error(
        `Persisted workflow_call continuation for step "${parentStep.name}" has child workflow name `
        + `"${childEntry.workflow}", but the resolver returned "${childWorkflow.name}"`,
      );
    }
    if (!workflowEntryMatchesWorkflow(childEntry, childWorkflow)) {
      throw new Error(
        `Persisted workflow_call continuation for step "${parentStep.name}" has a child workflow reference `
        + 'that does not match the resolved child',
      );
    }

    const childStep = childWorkflow.steps.find((step) => step.name === childEntry.step);
    if (childStep === undefined) {
      throw new Error(
        `Persisted workflow_call continuation for step "${parentStep.name}" references missing child step `
        + `"${childEntry.step}"`,
      );
    }
    const childStepKind = getWorkflowStepKind(childStep);
    if (childEntry.kind !== childStepKind) {
      throw new Error(
        `Persisted workflow_call continuation for step "${parentStep.name}" has child step kind `
        + `"${childEntry.kind}", but the resolved child step kind is "${childStepKind}"`,
      );
    }

    frames.push({
      parentWorkflowRef: getWorkflowReference(parentWorkflow),
      callStepName: parentStep.name,
      persistedIteration,
      childWorkflowRef: getWorkflowReference(childWorkflow),
      childStepName: childStep.name,
      childStepKind,
    });
    parentWorkflow = childWorkflow;
  }

  return createWorkflowCallContinuation(options.invocationRunId, frames);
}
