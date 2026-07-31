import type {
  WorkflowCallInvocationRecord,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from '../models/types.js';
import {
  getResumePointWorkflowReference,
  getWorkflowReference,
  normalizeWorkflowResumePointEntry,
} from './workflow-reference.js';
import {
  parseWorkflowCallNamespaceSegment,
  workflowCallNamespaceSegmentMatchesInvocation,
} from './workflow-call-namespace.js';
import {
  parseWorkflowExecutionIdentity,
  serializeWorkflowExecutionIdentity,
  type WorkflowExecutionIdentity,
} from './workflow-execution-identity-codec.js';

export function buildWorkflowCallInvocationIdentity(
  workflowReference: string,
  stepName: string,
  workflowCallPath: readonly WorkflowResumePointEntry[],
): string {
  if (workflowReference.length === 0 || stepName.length === 0) {
    throw new Error('Workflow-call invocation identity requires non-empty workflow and step values');
  }
  return serializeWorkflowExecutionIdentity({
    workflow: workflowReference,
    step: stepName,
    calls: workflowCallPath.map((rawEntry) => {
      const entry = normalizeWorkflowResumePointEntry(rawEntry);
      if (entry.kind !== 'workflow_call' || entry.call_instance === undefined || entry.call_instance < 1) {
        throw new Error(`Workflow-call invocation requires a positive instance for "${entry.step}"`);
      }
      const entryWorkflow = getResumePointWorkflowReference(entry);
      if (entryWorkflow.length === 0 || entry.step.length === 0) {
        throw new Error('Workflow-call invocation identity requires non-empty workflow-call path values');
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

function parseIdentity(identity: string): WorkflowExecutionIdentity {
  const parsedIdentity = parseWorkflowExecutionIdentity(identity);
  if (parsedIdentity === undefined) {
    throw new Error(`Invalid workflow-call invocation identity "${identity}"`);
  }
  return parsedIdentity;
}

export class WorkflowCallInvocationIndex {
  private readonly records: Map<string, WorkflowCallInvocationRecord>;

  constructor(initial: ReadonlyMap<string, WorkflowCallInvocationRecord>) {
    this.records = new Map([...initial].map(([identity, record]) => {
      const parsedIdentity = parseIdentity(identity);
      if (!Number.isInteger(record.call_instance) || record.call_instance < 1) {
        throw new Error(`Workflow-call invocation "${identity}" requires a positive instance`);
      }
      const namespace = parseWorkflowCallNamespaceSegment(record.report_namespace_segment);
      if (namespace === undefined || namespace.iteration === '*') {
        throw new Error(`Workflow-call invocation "${identity}" has an invalid report namespace segment`);
      }
      if (namespace.stepName !== parsedIdentity.step) {
        throw new Error(`Workflow-call invocation "${identity}" report namespace does not match its step`);
      }
      return [identity, { ...record }];
    }));
  }

  record(
    workflow: WorkflowConfig,
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
    record: WorkflowCallInvocationRecord,
  ): void {
    if (!Number.isInteger(record.call_instance) || record.call_instance < 1) {
      throw new Error(`Workflow-call step "${stepName}" requires a positive invocation instance`);
    }
    const namespace = parseWorkflowCallNamespaceSegment(record.report_namespace_segment);
    if (namespace === undefined || namespace.iteration === '*') {
      throw new Error(`Workflow-call step "${stepName}" requires a valid report namespace segment`);
    }
    if (!workflowCallNamespaceSegmentMatchesInvocation(
      record.report_namespace_segment,
      stepName,
      namespace.workflowName,
    )) {
      throw new Error(`Workflow-call step "${stepName}" report namespace does not match its invocation`);
    }
    this.records.set(
      buildWorkflowCallInvocationIdentity(getWorkflowReference(workflow), stepName, workflowCallPath),
      { ...record },
    );
  }

  get(
    workflow: WorkflowConfig,
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
  ): WorkflowCallInvocationRecord | undefined {
    const record = this.records.get(
      buildWorkflowCallInvocationIdentity(getWorkflowReference(workflow), stepName, workflowCallPath),
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
    resumePoint.stack.forEach((rawEntry, index) => {
      const entry = normalizeWorkflowResumePointEntry(rawEntry);
      if (entry.kind !== 'workflow_call') {
        return;
      }
      if (entry.call_instance === undefined) {
        throw new Error(`Workflow-call resume entry "${entry.step}" requires a positive call_instance`);
      }
      const identity = buildWorkflowCallInvocationIdentity(
        getResumePointWorkflowReference(entry),
        entry.step,
        resumePoint.stack.slice(0, index),
      );
      if (this.records.get(identity)?.call_instance !== entry.call_instance) {
        throw new Error(`Workflow-call invocation identity does not match resume entry "${entry.step}"`);
      }
    });
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
