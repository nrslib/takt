import { basename } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import type { WorkflowCallResolver, WorkflowSharedRuntimeState } from '../types.js';
import {
  createReviewReportDiscoveryContext,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { snapshotWorkflowCallInvocationEvidence } from '../workflow-call-invocation-index.js';
import { buildWorkflowStackStepIterationIdentity } from '../step-iteration-identity.js';
import { resolveReportReferenceDetailed } from './report-reference.js';

export interface DeclaredReportInputContext {
  readonly workflow: WorkflowConfig;
  readonly state: WorkflowState;
  readonly sharedRuntime: WorkflowSharedRuntimeState;
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
  readonly reportDir: string;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
}

/** Resolve only the declared producer's completed execution and contracted reports. */
export function resolveDeclaredReportInputs(
  consumer: WorkflowStep,
  context: DeclaredReportInputContext,
): string | undefined {
  const declaration = consumer.inputReports;
  if (declaration === undefined) return undefined;
  const source = context.workflow.steps.find((step) => step.name === declaration.fromStep);
  if (source === undefined) {
    throw new Error(`Report input source "${declaration.fromStep}" is not a step in this workflow`);
  }
  const invocationEvidence = context.sharedRuntime.workflowCallInvocationEvidence;
  const participationIndex = context.sharedRuntime.workflowStepParticipationIndex;
  if (invocationEvidence === undefined || participationIndex === undefined) {
    throw new Error(`Report input evidence is unavailable for "${declaration.fromStep}"`);
  }
  if (declaration.optionalIfUnrun === true) {
    const sourceOccurrence = context.state.stepIterations.get(
      buildWorkflowStackStepIterationIdentity(
        context.workflow,
        source.name,
        context.resumeStackPrefix,
      ),
    );
    const hasSourceEvidence = sourceOccurrence !== undefined
      || context.state.stepOutputs.has(source.name)
      || context.state.restoredStepIterationNames.has(source.name)
      || source.kind === 'workflow_call' && invocationEvidence.index.get(
        context.workflow,
        source.name,
        context.resumeStackPrefix,
      ) !== undefined;
    if (!hasSourceEvidence) return undefined;
  }
  const result = resolveWorkflowStepReportNamesWithDiagnostics(source, createReviewReportDiscoveryContext({
    step: source,
    workflow: context.workflow,
    workflowCallResolver: context.workflowCallResolver,
    projectCwd: context.projectCwd,
    lookupCwd: context.lookupCwd,
    resumeStackPrefix: context.resumeStackPrefix,
    stepOutputNames: new Set(context.state.stepOutputs.keys()),
    restoredStepIterationNames: context.state.restoredStepIterationNames,
    workflowCallInvocations: snapshotWorkflowCallInvocationEvidence(invocationEvidence),
    workflowStepParticipations: participationIndex.snapshot(),
    dynamicParallelSelections: context.state.dynamicParallelSelections,
    requireCompletedCalls: true,
  }));
  if (result.failures.length > 0) {
    throw new Error(`Report input from "${declaration.fromStep}" is incomplete: ${result.failures.map((failure) => failure.reason).join('; ')}`);
  }
  const selected = declaration.reports === 'all'
    ? result.reportNames
    : declaration.reports.map((report) => {
        const matches = result.reportNames.filter((name) => basename(name) === report);
        if (matches.length !== 1) {
          throw new Error(`Report input "${report}" from "${declaration.fromStep}" has ${matches.length} matching completed reports`);
        }
        return matches[0]!;
      });
  if (selected.length === 0) {
    throw new Error(`Report input from "${declaration.fromStep}" has no completed reports`);
  }
  return selected.map((report) => {
    const resolved = resolveReportReferenceDetailed(context.reportDir, report, {
      stepName: consumer.name,
      reportsRootDir: context.reportDir,
    });
    if (resolved.scope === 'missing') {
      throw new Error(`Report input "${report}" from "${declaration.fromStep}" is missing`);
    }
    return `### ${basename(report)}\n${resolved.content}`;
  }).join('\n\n');
}
