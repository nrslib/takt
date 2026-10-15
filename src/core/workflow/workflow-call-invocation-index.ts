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
  parseWorkflowCallInvocationIdentity,
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
      const instance = entry.kind === 'workflow_call'
        ? entry.call_instance
        : entry.occurrence;
      if (instance === undefined || instance < 1) {
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
        instance,
      };
    }),
  });
}

function parseIdentity(identity: string): WorkflowExecutionIdentity {
  const parsedIdentity = parseWorkflowCallInvocationIdentity(identity);
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
    for (const [identity, record] of this.records) {
      this.assertNamespaceAvailable(identity, record.report_namespace_segment);
    }
  }

  private assertNamespaceAvailable(identity: string, namespace: string): void {
    const collision = [...this.records.entries()].find(
      ([existingIdentity, record]) => existingIdentity !== identity
        && record.report_namespace_segment === namespace,
    );
    if (collision !== undefined) {
      throw new Error('Workflow-call report namespace is already assigned to another invocation');
    }
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
    const identity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(workflow),
      stepName,
      workflowCallPath,
    );
    this.assertNamespaceAvailable(identity, record.report_namespace_segment);
    this.records.set(identity, { ...record });
  }

  replace(
    workflow: WorkflowConfig,
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
    record: WorkflowCallInvocationRecord,
  ): void {
    const identity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(workflow),
      stepName,
      workflowCallPath,
    );
    if (!this.records.has(identity)) {
      throw new Error(`Workflow-call step "${stepName}" has no invocation record to replace`);
    }
    if (!Number.isInteger(record.call_instance) || record.call_instance < 1) {
      throw new Error(`Workflow-call step "${stepName}" requires a positive invocation instance`);
    }
    const namespace = parseWorkflowCallNamespaceSegment(record.report_namespace_segment);
    if (
      namespace === undefined
      || namespace.iteration === '*'
      || !workflowCallNamespaceSegmentMatchesInvocation(
        record.report_namespace_segment,
        stepName,
        namespace.workflowName,
      )
    ) {
      throw new Error(`Workflow-call step "${stepName}" requires a valid report namespace segment`);
    }
    this.assertNamespaceAvailable(identity, record.report_namespace_segment);
    this.records.set(identity, { ...record });
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

  clearPreviousParallelChildInvocations(
    workflow: WorkflowConfig,
    parentStepName: string,
    childStepNames: readonly string[],
    workflowCallPath: readonly WorkflowResumePointEntry[],
    currentParentOccurrence: number,
  ): void {
    if (childStepNames.length === 0) return;
    const workflowReference = getWorkflowReference(workflow);
    const expectedCalls = parseIdentity(buildWorkflowCallInvocationIdentity(
      workflowReference,
      parentStepName,
      workflowCallPath,
    )).calls;
    const childNames = new Set(childStepNames);
    for (const identity of this.records.keys()) {
      const parsed = parseIdentity(identity);
      const parentFrame = parsed.calls.at(-1);
      if (
        parsed.workflow !== workflowReference
        || !childNames.has(parsed.step)
        || parsed.calls.length !== expectedCalls.length + 1
        || parentFrame?.workflow !== workflowReference
        || parentFrame.step !== parentStepName
        || parentFrame.kind !== 'parallel'
        || parentFrame.instance === currentParentOccurrence
        || !expectedCalls.every((expected, index) => {
          const actual = parsed.calls[index];
          return actual?.workflow === expected.workflow
            && actual.step === expected.step
            && actual.kind === expected.kind
            && actual.instance === expected.instance;
        })
      ) {
        continue;
      }
      this.records.delete(identity);
    }
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
