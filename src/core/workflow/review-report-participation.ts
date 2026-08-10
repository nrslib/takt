import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  type DynamicParallelSelectionSnapshot,
  type WorkflowCallInvocationRecord,
  type WorkflowConfig,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../models/types.js';
import {
  buildWorkflowCallInvocationIdentity,
  type WorkflowCallInvocationEvidenceSnapshot,
} from './workflow-call-invocation-index.js';
import { buildDynamicParallelSelectionIdentity } from './dynamic-parallel/identity.js';
import {
  getResumePointWorkflowReference,
  getWorkflowReference,
  normalizeWorkflowResumePointEntry,
} from './workflow-reference.js';
import {
  parseWorkflowCallInvocationIdentity,
  type WorkflowExecutionCallIdentity,
} from './workflow-execution-identity-codec.js';
import {
  findWorkflowStepParticipationRecord,
} from './workflow-step-participation-index.js';

export interface ReviewReportParticipationEvidence {
  readonly activeWorkflowReference: string;
  readonly stepOutputNames: ReadonlySet<string>;
  readonly restoredStepIterationNames: ReadonlySet<string>;
  readonly workflowCallInvocations: WorkflowCallInvocationEvidenceSnapshot;
  readonly workflowStepParticipations: ReadonlyMap<string, import('../models/types.js').WorkflowStepParticipationRecord>;
  readonly dynamicParallelSelections: ReadonlyMap<string, DynamicParallelSelectionSnapshot>;
}

export interface WorkflowCallReportParticipation {
  readonly kind: 'exact';
  readonly invocation: WorkflowCallInvocationRecord;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
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
  parallelParentStepName?: string,
): ReviewReportStepParticipation {
  const activeScope = getWorkflowReference(workflow) === evidence.activeWorkflowReference;
  const participationRecord = findWorkflowStepParticipationRecord(
    evidence.workflowStepParticipations,
    workflow,
    step.name,
    resumeStackPrefix,
    parallelParentStepName,
  );
  const runtimeParticipation = participationRecord !== undefined
    || parallelParentStepName === undefined && activeScope && (
      evidence.stepOutputNames.has(step.name)
      || evidence.restoredStepIterationNames.has(step.name)
    );

  if (step.parallel !== undefined && isDynamicParallelSubSteps(step.parallel)) {
    if (!runtimeParticipation) {
      return { kind: 'not-participated' };
    }
    const currentSelection = evidence.dynamicParallelSelections.get(
      buildDynamicParallelSelectionIdentity(workflow, step.name, resumeStackPrefix),
    );
    const currentEffectiveSelection = currentSelection === undefined
      ? undefined
      : new Set(currentSelection.effective_selection_ids);
    return {
      kind: 'participated',
      parallelParticipants: getAllParallelSubSteps(step.parallel)
        .filter((subStep) => {
          const subStepParticipation = findWorkflowStepParticipationRecord(
            evidence.workflowStepParticipations,
            workflow,
            subStep.name,
            resumeStackPrefix,
            step.name,
          );
          return subStepParticipation !== undefined
            && (currentEffectiveSelection === undefined || currentEffectiveSelection.has(subStep.name));
        }),
      reportNames: participationRecord?.report_names ?? [],
    };
  }

  if (step.kind === 'workflow_call') {
    const resolvedInvocation = resolveWorkflowCallInvocation(
      workflow,
      step.name,
      resumeStackPrefix,
      parallelParentStepName,
      evidence.workflowCallInvocations.records,
    );
    if (resolvedInvocation === undefined) {
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
      workflowCallReport: {
        kind: 'exact',
        invocation: resolvedInvocation.invocation,
        resumeStackPrefix: resolvedInvocation.resumeStackPrefix,
      },
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

interface ResolvedWorkflowCallInvocation {
  readonly invocation: WorkflowCallInvocationRecord;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
}

function resolveWorkflowCallInvocation(
  workflow: WorkflowConfig,
  stepName: string,
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
  parallelParentStepName: string | undefined,
  records: ReadonlyMap<string, WorkflowCallInvocationRecord>,
): ResolvedWorkflowCallInvocation | undefined {
  const directIdentity = buildWorkflowCallInvocationIdentity(
    getWorkflowReference(workflow),
    stepName,
    resumeStackPrefix,
  );
  const directInvocation = records.get(directIdentity);
  if (parallelParentStepName === undefined) {
    return directInvocation === undefined
      ? undefined
      : { invocation: directInvocation, resumeStackPrefix };
  }

  const candidates = [...records.entries()].filter(([identity]) => {
    const parsed = parseWorkflowCallInvocationIdentity(identity);
    if (
      parsed === undefined
      || parsed.workflow !== getWorkflowReference(workflow)
      || parsed.step !== stepName
      || parsed.calls.length !== resumeStackPrefix.length + 1
    ) {
      return false;
    }
    const parentCall = parsed.calls.at(-1);
    return parentCall?.workflow === getWorkflowReference(workflow)
      && parentCall.step === parallelParentStepName
      && parentCall.kind === 'parallel'
      && parsed.calls.slice(0, -1).every((call, index) =>
        workflowExecutionCallMatchesEntry(call, resumeStackPrefix[index]!));
  });
  if (candidates.length !== 1) {
    return undefined;
  }
  const parsed = parseWorkflowCallInvocationIdentity(candidates[0]![0]);
  if (parsed === undefined) {
    return undefined;
  }
  return {
    invocation: candidates[0]![1],
    resumeStackPrefix: parsed.calls.map(workflowExecutionCallToResumePointEntry),
  };
}

function workflowExecutionCallMatchesEntry(
  call: WorkflowExecutionCallIdentity,
  rawEntry: WorkflowResumePointEntry,
): boolean {
  const entry = normalizeWorkflowResumePointEntry(rawEntry);
  const instance = entry.kind === 'workflow_call' ? entry.call_instance : entry.occurrence;
  return instance !== undefined
    && call.workflow === getResumePointWorkflowReference(entry)
    && call.step === entry.step
    && call.kind === entry.kind
    && call.instance === instance;
}

function workflowExecutionCallToResumePointEntry(
  call: WorkflowExecutionCallIdentity,
): WorkflowResumePointEntry {
  return {
    workflow: call.workflow,
    workflow_ref: call.workflow,
    step: call.step,
    kind: call.kind,
    occurrence: call.instance,
    ...(call.kind === 'workflow_call' ? { call_instance: call.instance } : {}),
  };
}
