import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowStepParticipationRecord,
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
): string {
  return serializeWorkflowExecutionIdentity({
    workflow: workflowReference,
    step: stepName,
    calls: workflowCallPath.map((rawEntry) => {
      const entry = normalizeWorkflowResumePointEntry(rawEntry);
      if (entry.kind !== 'workflow_call' || entry.call_instance === undefined) {
        throw new Error(`Workflow step participation requires an exact workflow-call instance for "${entry.step}"`);
      }
      return {
        workflow: getResumePointWorkflowReference(entry),
        step: entry.step,
        kind: entry.kind,
        instance: entry.call_instance,
      };
    }),
  });
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
  ): void {
    const identity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      stepName,
      workflowCallPath,
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
  ): WorkflowStepParticipationRecord | undefined {
    const record = this.records.get(buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      stepName,
      workflowCallPath,
    ));
    return record === undefined ? undefined : { report_names: [...record.report_names] };
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
