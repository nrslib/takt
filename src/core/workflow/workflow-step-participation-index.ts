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
  parseWorkflowExecutionOwnerIdentity,
  serializeWorkflowExecutionOwnerIdentity,
} from '../models/workflow-resume-contract.js';

export function buildWorkflowStepParticipationIdentity(
  workflowReference: string,
  stepName: string,
  ownerPath: readonly WorkflowResumePointEntry[],
): string {
  return serializeWorkflowExecutionOwnerIdentity({
    workflow: workflowReference,
    step: stepName,
    owners: ownerPath.map((rawEntry) => {
      const entry = normalizeWorkflowResumePointEntry(rawEntry);
      if (entry.kind !== 'workflow_call') {
        return {
          workflow: getResumePointWorkflowReference(entry),
          step: entry.step,
          kind: entry.kind,
        };
      }
      if (entry.call_instance === undefined) {
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
      if (parseWorkflowExecutionOwnerIdentity(identity) === undefined) {
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
    ownerPath: readonly WorkflowResumePointEntry[],
    reportNames: readonly string[],
  ): void {
    const identity = buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      stepName,
      ownerPath,
    );
    const previous = this.records.get(identity);
    this.records.set(identity, {
      report_names: [...new Set([...(previous?.report_names ?? []), ...reportNames])],
    });
  }

  get(
    workflow: WorkflowConfig,
    stepName: string,
    ownerPath: readonly WorkflowResumePointEntry[],
  ): WorkflowStepParticipationRecord | undefined {
    const record = this.records.get(buildWorkflowStepParticipationIdentity(
      getWorkflowReference(workflow),
      stepName,
      ownerPath,
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
