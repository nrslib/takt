import type { WorkflowConfig, WorkflowResumePointEntry } from '../../models/types.js';
import {
  getResumePointWorkflowReference,
  getWorkflowReference,
  normalizeWorkflowResumePointEntry,
} from '../workflow-reference.js';
import {
  serializeWorkflowExecutionIdentity,
} from '../workflow-execution-identity-codec.js';

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
      const instance = entry.kind === 'workflow_call'
        ? entry.call_instance
        : entry.occurrence;
      if (instance === undefined || instance < 1) {
        throw new Error(`Dynamic parallel identity requires a positive frame instance for "${entry.step}"`);
      }
      const entryWorkflow = getResumePointWorkflowReference(entry);
      if (entryWorkflow.length === 0 || entry.step.length === 0) {
        throw new Error('Dynamic parallel identity requires non-empty workflow-call path values');
      }
      return {
        workflow: entryWorkflow,
        step: entry.step,
        kind: entry.kind,
        instance,
      };
    }),
  });
}
