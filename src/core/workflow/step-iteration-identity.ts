import type {
  WorkflowConfig,
  WorkflowResumePointEntry,
} from '../models/types.js';
import { workflowEntryMatchesWorkflow } from './workflow-reference.js';

export function buildScopedStepIterationIdentity(
  stepName: string,
  ancestorStepNames: readonly string[],
): string {
  if (ancestorStepNames.length === 0) {
    return stepName;
  }
  return JSON.stringify({
    ancestors: ancestorStepNames,
    step: stepName,
  });
}

export function buildWorkflowStackStepIterationIdentity(
  workflow: WorkflowConfig,
  stepName: string,
  stack: readonly WorkflowResumePointEntry[],
): string {
  let ancestorStart = stack.length;
  while (
    ancestorStart > 0
    && workflowEntryMatchesWorkflow(stack[ancestorStart - 1]!, workflow)
  ) {
    ancestorStart--;
  }
  return buildScopedStepIterationIdentity(
    stepName,
    stack.slice(ancestorStart).map((entry) => entry.step),
  );
}
