import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  type DynamicParallelSelectionSnapshot,
  type WorkflowCallInvocationRecord,
  type WorkflowConfig,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../models/types.js';
import { buildDynamicParallelSelectionIdentity } from './dynamic-parallel/identity.js';
import {
  buildWorkflowCallInvocationIdentity,
  type WorkflowCallInvocationEvidenceSnapshot,
} from './workflow-call-invocation-index.js';
import { getWorkflowReference } from './workflow-reference.js';
import { buildWorkflowStepParticipationIdentity } from './workflow-step-participation-index.js';

export interface ReviewReportParticipationEvidence {
  readonly activeWorkflowReference: string;
  readonly stepOutputNames: ReadonlySet<string>;
  readonly restoredStepIterationNames: ReadonlySet<string>;
  readonly dynamicParallelSelections: ReadonlyMap<string, DynamicParallelSelectionSnapshot>;
  readonly workflowCallInvocations: WorkflowCallInvocationEvidenceSnapshot;
  readonly workflowStepParticipations: ReadonlyMap<string, import('../models/types.js').WorkflowStepParticipationRecord>;
}

export interface WorkflowCallReportParticipation {
  readonly kind: 'exact';
  readonly invocation: WorkflowCallInvocationRecord;
}

export type ReviewReportStepParticipation =
  | { readonly kind: 'not-participated' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
    readonly kind: 'participated';
    readonly parallelParticipants: readonly WorkflowStep[];
    readonly reportNames: readonly string[];
    readonly workflowCallReport?: WorkflowCallReportParticipation;
  };

export function resolveReviewReportStepParticipation(
  step: WorkflowStep,
  workflow: WorkflowConfig,
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
  evidence: ReviewReportParticipationEvidence,
): ReviewReportStepParticipation {
  const activeScope = getWorkflowReference(workflow) === evidence.activeWorkflowReference;
  const participationIdentity = buildWorkflowStepParticipationIdentity(
    getWorkflowReference(workflow),
    step.name,
    resumeStackPrefix,
  );
  const participationRecord = evidence.workflowStepParticipations.get(participationIdentity);
  const runtimeParticipation = participationRecord !== undefined
    || activeScope && (
      evidence.stepOutputNames.has(step.name)
      || evidence.restoredStepIterationNames.has(step.name)
    );

  if (step.parallel !== undefined && isDynamicParallelSubSteps(step.parallel)) {
    const identity = buildDynamicParallelSelectionIdentity(workflow, step.name, resumeStackPrefix);
    const snapshot = evidence.dynamicParallelSelections.get(identity);
    if (snapshot === undefined) {
      return runtimeParticipation
        ? {
            kind: 'invalid',
            reason: 'dynamic_parallel_report_identity_unresolved:'
              + `Dynamic parallel report selection snapshot is missing for identity "${identity}"`,
          }
        : { kind: 'not-participated' };
    }
    if (!runtimeParticipation) {
      return { kind: 'not-participated' };
    }
    const selected = new Set(snapshot.effective_selection_ids);
    return {
      kind: 'participated',
      parallelParticipants: getAllParallelSubSteps(step.parallel)
        .filter((subStep) => selected.has(subStep.name)),
      reportNames: participationRecord?.report_names ?? [],
    };
  }

  if (step.kind === 'workflow_call') {
    const identity = buildWorkflowCallInvocationIdentity(
      getWorkflowReference(workflow),
      step.name,
      resumeStackPrefix,
    );
    const invocation = evidence.workflowCallInvocations.records.get(identity);
    if (invocation === undefined) {
      return runtimeParticipation
        ? {
            kind: 'invalid',
            reason: `workflow_call_invocation_missing:${step.name}`,
          }
        : { kind: 'not-participated' };
    }
    return {
      kind: 'participated',
      parallelParticipants: [],
      reportNames: participationRecord?.report_names ?? [],
      workflowCallReport: { kind: 'exact', invocation },
    };
  }

  if (!runtimeParticipation) {
    return { kind: 'not-participated' };
  }
  return {
    kind: 'participated',
    reportNames: participationRecord?.report_names ?? [],
    parallelParticipants: step.parallel === undefined
      ? []
      : getAllParallelSubSteps(step.parallel),
  };
}
