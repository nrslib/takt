import {
  getAllParallelSubSteps,
  type WorkflowConfig,
  type WorkflowResumePoint,
  type WorkflowResumePointEntry,
  type WorkflowStepParticipationRecord,
} from '../models/types.js';
import {
  getResumePointWorkflowReference,
  getWorkflowReference,
  normalizeWorkflowResumePointEntry,
} from './workflow-reference.js';
import {
  parseWorkflowExecutionIdentity,
  serializeWorkflowExecutionIdentity,
} from './workflow-execution-identity-codec.js';

export function buildWorkflowStepParticipationIdentity(
  workflowReference: string,
  stepName: string,
  workflowCallPath: readonly WorkflowResumePointEntry[],
  parallelParentStepName?: string,
): string {
  return serializeWorkflowExecutionIdentity({
    workflow: workflowReference,
    step: stepName,
    ...(parallelParentStepName === undefined ? {} : { parallel_parent: parallelParentStepName }),
    calls: workflowCallPath.map((rawEntry) => {
      const entry = normalizeWorkflowResumePointEntry(rawEntry);
      const instance = entry.kind === 'workflow_call'
        ? entry.call_instance
        : entry.occurrence;
      if (instance === undefined) {
        throw new Error(`Workflow step participation requires an exact frame instance for "${entry.step}"`);
      }
      return {
        workflow: getResumePointWorkflowReference(entry),
        step: entry.step,
        kind: entry.kind,
        instance,
      };
    }),
  });
}

export function findWorkflowStepParticipationRecord(
  records: ReadonlyMap<string, WorkflowStepParticipationRecord>,
  workflow: WorkflowConfig,
  stepName: string,
  workflowCallPath: readonly WorkflowResumePointEntry[],
  parallelParentStepName?: string,
): WorkflowStepParticipationRecord | undefined {
  const workflowReference = getWorkflowReference(workflow);
  const identity = buildWorkflowStepParticipationIdentity(
    workflowReference,
    stepName,
    workflowCallPath,
    parallelParentStepName,
  );
  const legacyIdentity = parallelParentStepName === undefined
    ? undefined
    : buildWorkflowStepParticipationIdentity(
        workflowReference,
        stepName,
        workflowCallPath,
      );
  const qualifiedRecord = records.get(identity);
  const record = qualifiedRecord === undefined && legacyIdentity !== undefined
    && parallelParentStepName !== undefined
    && hasUniqueLegacyParallelScope(workflow, stepName, parallelParentStepName)
    ? records.get(legacyIdentity)
    : qualifiedRecord;
  return record === undefined ? undefined : { report_names: [...record.report_names] };
}

function hasUniqueLegacyParallelScope(
  workflow: WorkflowConfig,
  stepName: string,
  parallelParentStepName: string,
): boolean {
  if (workflow.steps.some((step) => step.name === stepName)) {
    return false;
  }
  const parents = workflow.steps.filter((step) =>
    step.name === parallelParentStepName
      && step.parallel !== undefined
      && getAllParallelSubSteps(step.parallel).some((subStep) => subStep.name === stepName),
  );
  if (parents.length !== 1) {
    return false;
  }
  return workflow.steps.filter((step) =>
    step.parallel !== undefined
      && getAllParallelSubSteps(step.parallel).some((subStep) => subStep.name === stepName),
  ).length === 1;
}

export class WorkflowStepParticipationIndex {
  private readonly records: Map<string, WorkflowStepParticipationRecord>;

  constructor(initial: ReadonlyMap<string, WorkflowStepParticipationRecord>) {
    this.records = new Map([...initial].map(([identity, record]) => {
      if (parseWorkflowExecutionIdentity(identity) === undefined) {
        throw new Error(`Invalid workflow step participation identity "${identity}"`);
      }
      return [identity, {
        report_names: [...new Set(record.report_names)],
      }];
    }));
  }

  record(
    workflow: WorkflowConfig,
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
    reportNames: readonly string[],
    parallelParentStepName?: string,
  ): void {
    const identity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      stepName,
      workflowCallPath,
      parallelParentStepName,
    );
    const previous = this.records.get(identity);
    this.records.set(identity, {
      report_names: [...new Set([...(previous?.report_names ?? []), ...reportNames])],
    });
  }

  get(
    workflow: WorkflowConfig,
    stepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
    parallelParentStepName?: string,
  ): WorkflowStepParticipationRecord | undefined {
    return findWorkflowStepParticipationRecord(
      this.records,
      workflow,
      stepName,
      workflowCallPath,
      parallelParentStepName,
    );
  }

  clearParallelParticipants(
    workflow: WorkflowConfig,
    parallelParentStepName: string,
    workflowCallPath: readonly WorkflowResumePointEntry[],
  ): void {
    const workflowReference = getWorkflowReference(workflow);
    for (const [identity] of this.records) {
      const parsed = parseWorkflowExecutionIdentity(identity);
      if (parsed?.workflow !== workflowReference) {
        continue;
      }
      const qualifiedIdentity = buildWorkflowStepParticipationIdentity(
        workflowReference,
        parsed.step,
        workflowCallPath,
        parallelParentStepName,
      );
      if (identity === qualifiedIdentity) {
        this.records.delete(identity);
        continue;
      }
      if (parsed.parallel_parent !== undefined) {
        continue;
      }
      const legacyIdentity = buildWorkflowStepParticipationIdentity(
        workflowReference,
        parsed.step,
        workflowCallPath,
      );
      if (
        identity === legacyIdentity
        && hasUniqueLegacyParallelScope(workflow, parsed.step, parallelParentStepName)
      ) {
        this.records.delete(identity);
      }
    }
  }

  snapshot(): ReadonlyMap<string, WorkflowStepParticipationRecord> {
    return new Map([...this.records].map(([identity, record]) => [
      identity,
      { report_names: [...record.report_names] },
    ]));
  }

  serialized(): Record<string, WorkflowStepParticipationRecord> {
    return Object.fromEntries(this.snapshot());
  }
}

export function restoreWorkflowStepParticipationIndex(
  resumePoint: WorkflowResumePoint | undefined,
): WorkflowStepParticipationIndex {
  const records = resumePoint === undefined
    ? new Map<string, WorkflowStepParticipationRecord>()
    : new Map(Object.entries(resumePoint.workflow_step_participations));
  return new WorkflowStepParticipationIndex(records);
}
