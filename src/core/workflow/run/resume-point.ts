import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from '../../models/types.js';
import { isWorkflowCallStep } from '../step-kind.js';
import { workflowEntriesMatch, workflowEntryMatchesWorkflow } from '../workflow-reference.js';

export interface ResumePointStepResolver {
  (parentWorkflow: WorkflowConfig, step: WorkflowCallStep): WorkflowConfig | null;
}

interface TrimResumePointStackOptions {
  workflow: WorkflowConfig;
  resumePoint: WorkflowResumePoint | undefined;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  resolveWorkflowCall: ResumePointStepResolver;
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
