import type {
  WorkflowCallInvocationRecord,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from '../models/types.js';
import { getWorkflowReference } from './workflow-reference.js';
import {
  buildWorkflowExecutionOwnerIdentity,
  serializeWorkflowExecutionOwnerIdentity,
  validateWorkflowCallInvocationRecord,
  validateWorkflowResumePointInvocationSemantics,
} from '../models/workflow-resume-contract.js';
import { buildWorkflowCallNamespaceSegment } from './workflow-call-namespace.js';

export function buildWorkflowCallInvocationIdentity(
  workflowReference: string,
  stepName: string,
  ownerPath: readonly WorkflowResumePointEntry[],
): string {
  if (workflowReference.length === 0 || stepName.length === 0) {
    throw new Error('Workflow-call invocation identity requires non-empty workflow and step values');
  }
  return serializeWorkflowExecutionOwnerIdentity(
    buildWorkflowExecutionOwnerIdentity(workflowReference, stepName, ownerPath),
  );
}

export class WorkflowCallInvocationIndex {
  private readonly records: Map<string, WorkflowCallInvocationRecord>;
  private readonly storageKeyOwners = new Map<string, string>();

  constructor(initial: ReadonlyMap<string, WorkflowCallInvocationRecord>) {
    this.records = new Map();
    for (const [identity, record] of initial) {
      if (!Number.isInteger(record.call_instance) || record.call_instance < 1) {
        throw new Error(`Workflow-call invocation "${identity}" requires a positive instance`);
      }
      validateWorkflowCallInvocationRecord(identity, record);
      this.assign(identity, record);
    }
  }

  private storageKey(identity: string, record: WorkflowCallInvocationRecord): string {
    return buildWorkflowCallNamespaceSegment(
      identity,
      record.child_workflow_ref,
      record.call_instance,
    );
  }

  private assign(identity: string, record: WorkflowCallInvocationRecord): void {
    const storageKey = this.storageKey(identity, record);
    const existingOwner = this.storageKeyOwners.get(storageKey);
    if (existingOwner !== undefined && existingOwner !== identity) {
      throw new Error(`Workflow-call storage key is already assigned to invocation "${existingOwner}"`);
    }
    const previous = this.records.get(identity);
    if (previous !== undefined) {
      this.storageKeyOwners.delete(this.storageKey(identity, previous));
    }
    this.records.set(identity, { ...record });
    this.storageKeyOwners.set(storageKey, identity);
  }

  record(
    workflow: WorkflowConfig,
    stepName: string,
    ownerPath: readonly WorkflowResumePointEntry[],
    record: WorkflowCallInvocationRecord,
  ): void {
    if (!Number.isInteger(record.call_instance) || record.call_instance < 1) {
      throw new Error(`Workflow-call step "${stepName}" requires a positive invocation instance`);
    }
    const identity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(workflow),
      stepName,
      ownerPath,
    );
    validateWorkflowCallInvocationRecord(identity, record);
    this.assign(identity, record);
  }

  get(
    workflow: WorkflowConfig,
    stepName: string,
    ownerPath: readonly WorkflowResumePointEntry[],
  ): WorkflowCallInvocationRecord | undefined {
    const record = this.records.get(
      buildWorkflowCallInvocationIdentity(getWorkflowReference(workflow), stepName, ownerPath),
    );
    return record === undefined ? undefined : { ...record };
  }

  snapshot(): ReadonlyMap<string, WorkflowCallInvocationRecord> {
    return new Map([...this.records].map(([identity, record]) => [identity, { ...record }]));
  }

  serialized(): Record<string, WorkflowCallInvocationRecord> {
    return Object.fromEntries([...this.records].map(([identity, record]) => [identity, { ...record }]));
  }

  validateResumePoint(resumePoint: WorkflowResumePoint | undefined): void {
    if (resumePoint === undefined) {
      return;
    }
    validateWorkflowResumePointInvocationSemantics(resumePoint);
  }
}

export interface WorkflowCallInvocationEvidence {
  readonly kind: 'exact';
  readonly index: WorkflowCallInvocationIndex;
}

export interface WorkflowCallInvocationEvidenceSnapshot {
  readonly kind: WorkflowCallInvocationEvidence['kind'];
  readonly records: ReadonlyMap<string, WorkflowCallInvocationRecord>;
}

export function restoreWorkflowCallInvocationEvidence(
  resumePoint: WorkflowResumePoint | undefined,
): WorkflowCallInvocationEvidence {
  const records = resumePoint === undefined
    ? new Map<string, WorkflowCallInvocationRecord>()
    : new Map(Object.entries(resumePoint.workflow_call_invocations));
  const index = new WorkflowCallInvocationIndex(records);
  return { kind: 'exact', index };
}

export function snapshotWorkflowCallInvocationEvidence(
  evidence: WorkflowCallInvocationEvidence,
): WorkflowCallInvocationEvidenceSnapshot {
  return {
    kind: evidence.kind,
    records: evidence.index.snapshot(),
  };
}

export function serializeWorkflowCallInvocationEvidence(
  evidence: WorkflowCallInvocationEvidence,
): Record<string, WorkflowCallInvocationRecord> {
  return evidence.index.serialized();
}
