import type { WorkflowConfig, WorkflowResumePointEntry } from '../../models/types.js';
import {
  getWorkflowReference,
} from '../workflow-reference.js';
import {
  buildWorkflowExecutionOwnerIdentity,
  parseWorkflowExecutionOwnerIdentity,
  serializeWorkflowExecutionOwnerIdentity,
  type WorkflowExecutionOwnerIdentity,
} from '../../models/workflow-resume-contract.js';

export type DynamicParallelSelectionIdentity = WorkflowExecutionOwnerIdentity;

export function buildDynamicParallelSelectionIdentity(
  workflow: WorkflowConfig,
  stepName: string,
  ownerPath: readonly WorkflowResumePointEntry[],
): string {
  return buildDynamicParallelSelectionIdentityFromPath(
    getWorkflowReference(workflow),
    stepName,
    ownerPath,
  );
}

export function buildDynamicParallelSelectionIdentityFromPath(
  workflowReference: string,
  stepName: string,
  ownerPath: readonly WorkflowResumePointEntry[],
): string {
  if (workflowReference.length === 0 || stepName.length === 0) {
    throw new Error('Dynamic parallel identity requires non-empty workflow and step values');
  }
  return serializeWorkflowExecutionOwnerIdentity(
    buildWorkflowExecutionOwnerIdentity(workflowReference, stepName, ownerPath),
  );
}

export function parseDynamicParallelSelectionIdentity(
  identity: string,
): DynamicParallelSelectionIdentity | undefined {
  return parseWorkflowExecutionOwnerIdentity(identity);
}

export function isWithinDynamicParallelSelectionScope(
  identity: string,
  prefix: readonly WorkflowResumePointEntry[],
): boolean {
  const parsed = parseDynamicParallelSelectionIdentity(identity);
  if (!parsed || parsed.owners.length < prefix.length) return false;
  const prefixOwners = buildWorkflowExecutionOwnerIdentity(
    parsed.workflow,
    parsed.step,
    prefix,
  ).owners;
  return prefixOwners.every((owner, index) => {
    const actual = parsed.owners[index];
    return actual !== undefined
      && actual.workflow === owner.workflow
      && actual.step === owner.step
      && actual.kind === owner.kind
      && (actual.kind !== 'workflow_call'
        || owner.kind === 'workflow_call' && actual.instance === owner.instance);
  });
}
