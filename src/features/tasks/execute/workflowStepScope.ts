import type {
  CanonicalWorkflowResumeFrame,
} from '../../../shared/types/workflow-resume.js';
import {
  parseCanonicalWorkflowResumeFrame,
} from '../../../shared/types/workflow-resume.js';

export type WorkflowStepScopeEntry = CanonicalWorkflowResumeFrame;

function normalizeWorkflowStepScope(
  stack: ReadonlyArray<WorkflowStepScopeEntry> | undefined,
): WorkflowStepScopeEntry[] {
  return (stack ?? []).map((entry, index) => (
    parseCanonicalWorkflowResumeFrame(
      entry,
      `workflow step scope[${index}]`,
    )
  ));
}

export function buildWorkflowStepScopeKey(
  step: string,
  stack: ReadonlyArray<WorkflowStepScopeEntry> | undefined,
): string {
  return JSON.stringify({
    step,
    stack: normalizeWorkflowStepScope(stack),
  });
}

export function buildWorkflowScopeIdentity(
  workflowName: string,
  stack: ReadonlyArray<WorkflowStepScopeEntry> | undefined,
): string {
  return JSON.stringify({
    workflow: workflowName,
    stack: normalizeWorkflowStepScope(stack),
  });
}
