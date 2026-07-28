import type {
  WorkflowConfig,
  WorkflowResumeFrameKind,
  WorkflowResumePointEntry,
} from '../models/types.js';

const WORKFLOW_OPAQUE_REF = Symbol.for('takt.workflowOpaqueRef');

type WorkflowConfigWithOpaqueRef = WorkflowConfig & {
  [WORKFLOW_OPAQUE_REF]?: string;
};

export function getWorkflowReference(workflow: WorkflowConfig): string {
  return (workflow as WorkflowConfigWithOpaqueRef)[WORKFLOW_OPAQUE_REF] ?? workflow.name;
}

export function buildWorkflowResumePointEntry(
  workflow: WorkflowConfig,
  step: string,
  kind: WorkflowResumeFrameKind,
  occurrence: number,
  stepIterations?: ReadonlyMap<string, number>,
): WorkflowResumePointEntry {
  if (!Number.isSafeInteger(occurrence) || occurrence <= 0) {
    throw new Error(`Workflow resume frame "${workflow.name}/${step}" occurrence is invalid`);
  }
  const workflowRef = getWorkflowReference(workflow);
  return {
    workflow: workflow.name,
    workflow_ref: workflowRef,
    step,
    kind,
    occurrence,
    ...(stepIterations !== undefined
      ? { step_iterations: Object.fromEntries(stepIterations) }
      : {}),
  };
}

export function getResumePointWorkflowReference(entry: WorkflowResumePointEntry): string {
  return entry.workflow_ref;
}

export function workflowEntryMatchesWorkflow(
  entry: WorkflowResumePointEntry,
  workflow: WorkflowConfig,
): boolean {
  return entry.workflow_ref === getWorkflowReference(workflow);
}

export function workflowEntriesMatch(
  left: WorkflowResumePointEntry,
  right: WorkflowResumePointEntry,
): boolean {
  return left.workflow_ref === right.workflow_ref;
}
