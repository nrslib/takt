import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowStep,
} from '../../models/types.js';
import { getWorkflowResumeFrameKind, isWorkflowCallStep } from '../step-kind.js';
import { workflowEntriesMatch, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
import {
  parseCanonicalWorkflowResumeFrame,
} from '../../../shared/types/workflow-resume.js';

export interface ResumePointStepResolver {
  (parentWorkflow: WorkflowConfig, step: WorkflowCallStep): WorkflowConfig | null;
}

export function requireWorkflowResumeStackSnapshot(
  stack: readonly WorkflowResumePointEntry[] | undefined,
): WorkflowResumePointEntry[] {
  if (stack === undefined || stack.length === 0) {
    throw new Error('Step event requires an active workflow resume stack');
  }
  return stack.map((entry, index) => {
    const frame = parseCanonicalWorkflowResumeFrame(
      entry,
      `workflow resume stack[${index}]`,
    );
    return {
      ...frame,
      ...(entry.step_iterations !== undefined
        ? {
            step_iterations: validateStepIterations(
              entry.step_iterations,
              index,
            ),
          }
        : {}),
    };
  });
}

function validateStepIterations(
  value: Readonly<Record<string, number>>,
  frameIndex: number,
): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const [step, occurrence] of Object.entries(value)) {
    if (
      step.length === 0
      || !Number.isSafeInteger(occurrence)
      || occurrence <= 0
    ) {
      throw new Error(
        `workflow resume stack[${frameIndex}].step_iterations is invalid`,
      );
    }
    snapshot[step] = occurrence;
  }
  return snapshot;
}

interface TrimResumePointStackOptions {
  workflow: WorkflowConfig;
  resumePoint: WorkflowResumePoint | undefined;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  resolveWorkflowCall: ResumePointStepResolver;
}

export function matchesResumeStackPrefix(
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
      && candidate.kind === entry.kind
      && candidate.occurrence === entry.occurrence;
  });
}

function resolveUniqueStep(
  steps: readonly WorkflowStep[],
  entry: WorkflowResumePointEntry,
): WorkflowStep | undefined {
  const matches = steps.filter((candidate) => candidate.name === entry.step);
  if (matches.length > 1) {
    throw new Error(
      `Workflow resume step "${entry.workflow}/${entry.step}" is ambiguous`,
    );
  }
  const step = matches[0];
  if (step === undefined || getWorkflowResumeFrameKind(step) !== entry.kind) {
    return undefined;
  }
  return step;
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
  let candidateSteps: readonly WorkflowStep[] = currentWorkflow.steps;
  for (let index = 0; index < stackSuffix.length; index += 1) {
    const entry = stackSuffix[index]!;
    if (!workflowEntryMatchesWorkflow(entry, currentWorkflow)) {
      return false;
    }

    const step = resolveUniqueStep(candidateSteps, entry);
    if (step === undefined) {
      return false;
    }

    if (index === stackSuffix.length - 1) {
      return true;
    }

    if (isWorkflowCallStep(step)) {
      const childWorkflow = resolveWorkflowCall(currentWorkflow, step);
      if (!childWorkflow) {
        return false;
      }
      currentWorkflow = childWorkflow;
      candidateSteps = childWorkflow.steps;
      continue;
    }
    if (step.parallel === undefined || step.parallel.length === 0) {
      return false;
    }
    candidateSteps = step.parallel;
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
