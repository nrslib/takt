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
  callInstance?: number,
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
    ...(callInstance === undefined ? {} : { call_instance: callInstance }),
  };
}

export function getResumePointWorkflowReference(entry: WorkflowResumePointEntry): string {
  return entry.workflow_ref;
}

export function normalizeWorkflowResumePointEntry(
  entry: WorkflowResumePointEntry,
): WorkflowResumePointEntry {
  if (entry.call_instance !== undefined) {
    return entry;
  }
  const callInstance = entry.step_iterations?.[entry.step];
  if (callInstance === undefined) {
    return entry;
  }
  return { ...entry, call_instance: callInstance };
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
  const normalizedLeft = normalizeWorkflowResumePointEntry(left);
  const normalizedRight = normalizeWorkflowResumePointEntry(right);
  if (normalizedLeft.call_instance !== normalizedRight.call_instance) {
    return false;
  }
  return normalizedLeft.workflow_ref === normalizedRight.workflow_ref;
}
