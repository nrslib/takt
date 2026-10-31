import type {
  WorkflowCallInvocationRecord,
  WorkflowCallStep,
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
  private readonly restoredRecords: ReadonlyMap<string, WorkflowCallInvocationRecord>;

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
    this.restoredRecords = new Map(this.records);
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

  getSelectedRestartCallInstance(
    source: WorkflowResumePoint | undefined,
    workflow: WorkflowConfig,
    stepName: string,
    path: readonly WorkflowResumePointEntry[],
  ): number | undefined {
    return this.findSelectedRestartRecord(source, workflow, stepName, path)?.[1].call_instance;
  }

  private findSelectedRestartRecord(
    source: WorkflowResumePoint | undefined,
    workflow: WorkflowConfig,
    stepName: string,
    path: readonly WorkflowResumePointEntry[],
  ): readonly [string, WorkflowCallInvocationRecord] | undefined {
    if (source === undefined) return undefined;
    const root = source.stack[0];
    if (root === undefined || root.workflow !== (path[0]?.workflow ?? workflow.name)) return undefined;
    const candidates = [...this.restoredRecords].filter(([identity]) => {
      const parsed = parseIdentity(identity);
      if (parsed.step !== stepName || parsed.calls.length !== path.length) return false;
      if ((parsed.calls[0]?.workflow ?? parsed.workflow) !== root.workflow_ref) return false;
      return parsed.calls.every((call, index) => {
        const entry = normalizeWorkflowResumePointEntry(path[index]!);
        if (call.step !== entry.step || call.kind !== entry.kind) return false;
        const ancestorIdentity = serializeWorkflowExecutionIdentity({ workflow: call.workflow, step: call.step, calls: parsed.calls.slice(0, index) });
        const ancestor = this.restoredRecords.get(ancestorIdentity);
        const currentAncestorIdentity = buildWorkflowCallInvocationIdentity(entry.workflow_ref, entry.step, path.slice(0, index));
        const currentAncestor = this.records.get(currentAncestorIdentity);
        const namespace = ancestor === undefined ? undefined : parseWorkflowCallNamespaceSegment(ancestor.report_namespace_segment);
        const expectedChild = index + 1 < path.length ? path[index + 1]!.workflow : workflow.name;
        return ancestor?.call_instance === call.instance
          && currentAncestor?.call_instance === entry.call_instance
          && ancestor.report_namespace_segment === currentAncestor?.report_namespace_segment
          && namespace?.workflowName === expectedChild;
      });
    });
    if (candidates.length > 1) throw new Error(`Workflow-call step "${stepName}" has ambiguous saved invocation records`);
    return candidates[0];
  }

  rebindResumeInvocation(
    source: WorkflowResumePoint | undefined,
    workflow: WorkflowConfig,
    stepName: string,
    path: readonly WorkflowResumePointEntry[],
    occurrence: number,
    selectedRestart: boolean,
  ): { from: string; to: string; previousCallInstance: number; callInstance: number } | undefined {
    const frame = source?.stack[path.length];
    if (selectedRestart && source !== undefined) {
      const currentIdentity = buildWorkflowCallInvocationIdentity(getWorkflowReference(workflow), stepName, path);
      const candidate = this.findSelectedRestartRecord(source, workflow, stepName, path);
      if (candidate === undefined) return;
      const currentRecord = this.records.get(currentIdentity);
      if (candidate[0] !== currentIdentity && currentRecord !== undefined) {
        if (currentRecord.report_namespace_segment !== candidate[1].report_namespace_segment) {
          throw new Error(`Workflow-call step "${stepName}" has conflicting invocation records`);
        }
        this.moveInvocationAndDescendants(currentIdentity, currentIdentity, stepName, currentRecord, occurrence);
        return {
          from: currentIdentity,
          to: currentIdentity,
          previousCallInstance: currentRecord.call_instance,
          callInstance: occurrence,
        };
      }
      const savedEntry = this.records.has(candidate[0])
        ? [candidate[0], this.records.get(candidate[0])!] as const
        : [...this.records.entries()].find(([, record]) => (
            record.report_namespace_segment === candidate[1].report_namespace_segment
          ));
      if (savedEntry === undefined) throw new Error(`Workflow-call step "${stepName}" saved invocation was already rebound`);
      const [savedIdentity, savedRecord] = savedEntry;
      this.moveInvocationAndDescendants(savedIdentity, currentIdentity, stepName, savedRecord, occurrence);
      return {
        from: savedIdentity,
        to: currentIdentity,
        previousCallInstance: savedRecord.call_instance,
        callInstance: occurrence,
      };
    }
    if (frame === undefined || frame.workflow !== workflow.name) return;
    if (frame.step === stepName) {
      if (frame.kind !== 'workflow_call' || frame.call_instance !== occurrence) return;
    } else return;
    if (!path.every((entry, index) => {
      const saved = source!.stack[index];
      return saved !== undefined && saved.workflow === entry.workflow && saved.step === entry.step
        && saved.kind === entry.kind && saved.occurrence === entry.occurrence
        && normalizeWorkflowResumePointEntry(saved).call_instance === normalizeWorkflowResumePointEntry(entry).call_instance;
    })) return;
    const savedPath = source!.stack.slice(0, path.length);
    const savedIdentity = buildWorkflowCallInvocationIdentity(frame.workflow_ref, stepName, savedPath);
    const migratedIdentity = buildWorkflowCallInvocationIdentity(frame.workflow_ref, stepName, path);
    const newIdentity = buildWorkflowCallInvocationIdentity(getWorkflowReference(workflow), stepName, path);
    if (savedIdentity !== migratedIdentity && this.records.has(savedIdentity) && this.records.has(migratedIdentity)) {
      throw new Error(`Workflow-call step "${stepName}" has conflicting invocation records`);
    }
    const oldIdentity = this.records.has(savedIdentity) ? savedIdentity : migratedIdentity;
    if (oldIdentity === newIdentity) return;
    const record = this.records.get(oldIdentity);
    if (record === undefined || record.call_instance !== occurrence) return;
    this.moveInvocationAndDescendants(oldIdentity, newIdentity, stepName, record, record.call_instance);
    return {
      from: oldIdentity,
      to: newIdentity,
      previousCallInstance: record.call_instance,
      callInstance: record.call_instance,
    };
  }

  rebindResumeInvocationsForReportDiscovery(
    source: WorkflowResumePoint | undefined,
    workflow: WorkflowConfig,
    path: readonly WorkflowResumePointEntry[],
    resolveWorkflowCall: (step: WorkflowCallStep) => WorkflowConfig | null,
  ): Array<{ from: string; to: string; previousCallInstance: number; callInstance: number }> {
    if (source === undefined) return [];
    const frame = source.stack[path.length];
    if (frame === undefined || frame.workflow !== workflow.name) return [];
    if (!path.every((entry, index) => {
      const saved = source.stack[index];
      return saved !== undefined && saved.workflow === entry.workflow && saved.step === entry.step
        && saved.kind === entry.kind && saved.occurrence === entry.occurrence
        && normalizeWorkflowResumePointEntry(saved).call_instance === normalizeWorkflowResumePointEntry(entry).call_instance;
    })) return [];
    const savedPath = source.stack.slice(0, path.length);
    const rebinds: Array<{ from: string; to: string; previousCallInstance: number; callInstance: number }> = [];
    for (const step of workflow.steps) {
      if (step.kind !== 'workflow_call') continue;
      const savedIdentity = buildWorkflowCallInvocationIdentity(frame.workflow_ref, step.name, savedPath);
      const migratedIdentity = buildWorkflowCallInvocationIdentity(frame.workflow_ref, step.name, path);
      const newIdentity = buildWorkflowCallInvocationIdentity(getWorkflowReference(workflow), step.name, path);
      if (savedIdentity !== migratedIdentity && this.records.has(savedIdentity) && this.records.has(migratedIdentity)) {
        throw new Error(`Workflow-call step "${step.name}" has conflicting invocation records`);
      }
      const oldIdentity = this.records.has(savedIdentity) ? savedIdentity : migratedIdentity;
      const record = this.records.get(oldIdentity);
      if (record === undefined) continue;
      const childWorkflow = resolveWorkflowCall(step);
      if (
        childWorkflow !== null
        && !workflowCallNamespaceSegmentMatchesInvocation(
          record.report_namespace_segment,
          step.name,
          childWorkflow.name,
        )
      ) {
        continue;
      }
      if (oldIdentity === newIdentity) continue;
      this.moveInvocationAndDescendants(oldIdentity, newIdentity, step.name, record, record.call_instance);
      rebinds.push({
        from: oldIdentity,
        to: newIdentity,
        previousCallInstance: record.call_instance,
        callInstance: record.call_instance,
      });
    }
    return rebinds;
  }

  private moveInvocationAndDescendants(
    oldIdentity: string,
    newIdentity: string,
    stepName: string,
    record: WorkflowCallInvocationRecord,
    newCallInstance: number,
  ): void {
    const sourceIdentity = parseIdentity(oldIdentity);
    const targetIdentity = parseIdentity(newIdentity);
    const oldPrefix = [
      ...sourceIdentity.calls,
      { workflow: sourceIdentity.workflow, step: sourceIdentity.step, kind: 'workflow_call' as const, instance: record.call_instance },
    ];
    const newPrefix = [
      ...targetIdentity.calls,
      { workflow: targetIdentity.workflow, step: targetIdentity.step, kind: 'workflow_call' as const, instance: newCallInstance },
    ];
    const moves: Array<{ from: string; to: string; record: WorkflowCallInvocationRecord }> = [
      { from: oldIdentity, to: newIdentity, record: { ...record, call_instance: newCallInstance } },
    ];
    for (const [identity, descendant] of this.records) {
      const parsed = parseIdentity(identity);
      if (parsed.calls.length < oldPrefix.length || !oldPrefix.every((expected, index) => {
        const actual = parsed.calls[index];
        return actual?.workflow === expected.workflow && actual.step === expected.step
          && actual.kind === expected.kind && actual.instance === expected.instance;
      })) continue;
      moves.push({
        from: identity,
        to: serializeWorkflowExecutionIdentity({ ...parsed, calls: [...newPrefix, ...parsed.calls.slice(oldPrefix.length)] }),
        record: descendant,
      });
    }
    const movedIdentities = new Set(moves.map((move) => move.from));
    const destinations = new Set<string>();
    for (const move of moves) {
      if (destinations.has(move.to) || (this.records.has(move.to) && !movedIdentities.has(move.to))) {
        throw new Error(`Workflow-call step "${stepName}" has conflicting invocation records`);
      }
      destinations.add(move.to);
    }
    for (const move of moves) this.records.delete(move.from);
    for (const move of moves) this.records.set(move.to, move.record);
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
