import type { WorkflowConfig, WorkflowResumePointEntry, WorkflowStepKind } from '../models/types.js';
import { getWorkflowOpaqueRef } from './reviewer-anomaly-capability.js';

export function getWorkflowReference(workflow: WorkflowConfig): string {
  return getWorkflowOpaqueRef(workflow) ?? workflow.name;
}

export function buildWorkflowResumePointEntry(
  workflow: WorkflowConfig,
  step: string,
  kind: WorkflowStepKind,
  stepIterations?: ReadonlyMap<string, number>,
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
  };
}

export function getResumePointWorkflowReference(entry: WorkflowResumePointEntry): string {
  return entry.workflow_ref ?? entry.workflow;
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
  if (left.workflow_ref !== undefined && right.workflow_ref !== undefined) {
    return left.workflow_ref === right.workflow_ref;
  }
  return left.workflow === right.workflow;
}
