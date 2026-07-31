import type { WorkflowConfig, WorkflowResumePointEntry, WorkflowStepKind } from '../models/types.js';

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
  kind: WorkflowStepKind,
  stepIterations?: ReadonlyMap<string, number>,
  callInstance?: number,
): WorkflowResumePointEntry {
  const workflowRef = getWorkflowReference(workflow);
  return {
    workflow: workflow.name,
    ...(workflowRef !== workflow.name ? { workflow_ref: workflowRef } : {}),
    step,
    kind,
    ...(stepIterations !== undefined
      ? { step_iterations: Object.fromEntries(stepIterations) }
      : {}),
    ...(callInstance === undefined ? {} : { call_instance: callInstance }),
  };
}

export function getResumePointWorkflowReference(entry: WorkflowResumePointEntry): string {
  return entry.workflow_ref ?? entry.workflow;
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
  if (entry.workflow_ref !== undefined) {
    return entry.workflow_ref === getWorkflowReference(workflow);
  }
  return entry.workflow === workflow.name;
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
  if (normalizedLeft.workflow_ref !== undefined && normalizedRight.workflow_ref !== undefined) {
    return normalizedLeft.workflow_ref === normalizedRight.workflow_ref;
  }
  return normalizedLeft.workflow === normalizedRight.workflow;
}
