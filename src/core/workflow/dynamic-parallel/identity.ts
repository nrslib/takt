import type { WorkflowConfig, WorkflowResumePointEntry } from '../../models/types.js';
import {
  getResumePointWorkflowReference,
  getWorkflowReference,
  normalizeWorkflowResumePointEntry,
} from '../workflow-reference.js';
import {
  parseWorkflowExecutionIdentity,
  serializeWorkflowExecutionIdentity,
  type WorkflowExecutionIdentity,
} from '../workflow-execution-identity-codec.js';

export type DynamicParallelSelectionIdentity = WorkflowExecutionIdentity;

export function buildDynamicParallelSelectionIdentity(
  workflow: WorkflowConfig,
  stepName: string,
  workflowCallPath: readonly WorkflowResumePointEntry[],
): string {
  return buildDynamicParallelSelectionIdentityFromPath(
    getWorkflowReference(workflow),
    stepName,
    workflowCallPath,
  );
}

export function buildDynamicParallelSelectionIdentityFromPath(
  workflowReference: string,
  stepName: string,
  workflowCallPath: readonly WorkflowResumePointEntry[],
): string {
  if (workflowReference.length === 0 || stepName.length === 0) {
    throw new Error('Dynamic parallel identity requires non-empty workflow and step values');
  }
  return serializeWorkflowExecutionIdentity({
    workflow: workflowReference,
    step: stepName,
    calls: workflowCallPath.map((rawEntry) => {
      const entry = normalizeWorkflowResumePointEntry(rawEntry);
      if (entry.kind !== 'workflow_call' || entry.call_instance === undefined || entry.call_instance < 1) {
        throw new Error(`Dynamic parallel identity requires a positive workflow_call instance for "${entry.step}"`);
      }
      const entryWorkflow = getResumePointWorkflowReference(entry);
      if (entryWorkflow.length === 0 || entry.step.length === 0) {
        throw new Error('Dynamic parallel identity requires non-empty workflow-call path values');
      }
      return {
        workflow: entryWorkflow,
        step: entry.step,
        kind: entry.kind,
        instance: entry.call_instance,
      };
    }),
  });
}

export function parseDynamicParallelSelectionIdentity(
  identity: string,
): DynamicParallelSelectionIdentity | undefined {
  return parseWorkflowExecutionIdentity(identity);
}

export function isWithinDynamicParallelSelectionScope(
  identity: string,
  prefix: readonly WorkflowResumePointEntry[],
): boolean {
  const parsed = parseDynamicParallelSelectionIdentity(identity);
  if (!parsed || parsed.calls.length < prefix.length) return false;
  return prefix.every((entry, index) => {
    const call = parsed.calls[index];
    return call !== undefined
      && call.workflow === getResumePointWorkflowReference(entry)
      && call.step === entry.step
      && call.kind === entry.kind
      && entry.call_instance !== undefined
      && call.instance === entry.call_instance;
  });
}
