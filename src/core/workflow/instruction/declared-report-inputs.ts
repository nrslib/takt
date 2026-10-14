import { basename } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { getAllParallelSubSteps } from '../../models/types.js';
import { isWorkflowCallStep } from '../step-kind.js';
import type { WorkflowCallResolver, WorkflowSharedRuntimeState } from '../types.js';
import {
  createReviewReportDiscoveryContext,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { snapshotWorkflowCallInvocationEvidence } from '../workflow-call-invocation-index.js';
import { buildWorkflowStackStepIterationIdentity } from '../step-iteration-identity.js';
import { getReportFiles } from '../output-contract-files.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../workflow-call-depth.js';
import { parseWorkflowCallNamespaceSegment } from '../workflow-call-namespace.js';
import { getWorkflowReference } from '../workflow-reference.js';
import { resolveReportReferenceDetailed } from './report-reference.js';
import type { DeclaredReportInputs } from './prepared-instruction.js';

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

function collectPotentialReportNames(
  step: WorkflowStep,
  workflow: WorkflowConfig,
  context: DeclaredReportInputContext,
  workflowReferences: ReadonlySet<string>,
  depth: number,
): readonly string[] {
  const names = [
    ...getReportFiles(step.outputContracts),
    ...(step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel).flatMap((child) =>
      collectPotentialReportNames(child, workflow, context, workflowReferences, depth))),
  ];
  if (!isWorkflowCallStep(step)) return names;
  const child = context.workflowCallResolver?.({
    parentWorkflow: workflow,
    step,
    projectCwd: context.projectCwd,
    lookupCwd: context.lookupCwd,
  });
  if (child == null) throw new Error(`Report input source workflow "${step.call}" could not be resolved`);
  const childReference = getWorkflowReference(child);
  if (workflowReferences.has(childReference) || depth + 1 > MAX_WORKFLOW_CALL_DEPTH) {
    throw new Error(`Report input source workflow "${step.call}" is recursive or exceeds call depth`);
  }
  const childReferences = new Set([...workflowReferences, childReference]);
  return [
    ...names,
    ...child.steps.flatMap((childStep) =>
      collectPotentialReportNames(childStep, child, context, childReferences, depth + 1)),
  ];
}

function logicalProducer(sourceName: string, reportPath: string): string {
  const parts = reportPath.split('/');
  const steps = [sourceName];
  let isFirstCallFrame = true;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] !== 'subworkflows') continue;
    const callStep = parseWorkflowCallNamespaceSegment(parts[index + 1]!)?.stepName;
    if (callStep === undefined) throw new Error(`Report input "${reportPath}" has an invalid producer identity`);
    if (!isFirstCallFrame || callStep !== sourceName) steps.push(callStep);
    isFirstCallFrame = false;
    index += 1;
  }
  return steps.join(' / ');
}

/** Resolve only the declared producer's completed execution and contracted reports. */
export function resolveDeclaredReportInputs(
  consumer: WorkflowStep,
  context: DeclaredReportInputContext,
): DeclaredReportInputs | undefined {
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
    if (!hasSourceEvidence) {
      return {
        declaredNames: declaration.reports === 'all'
          ? [...new Set(collectPotentialReportNames(
              source,
              context.workflow,
              context,
              new Set([getWorkflowReference(context.workflow)]),
              context.resumeStackPrefix.length + 1,
            ).map((name) => basename(name)))]
          : declaration.reports,
        reports: [],
      };
    }
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
  const reports = selected.map((report) => {
    const resolved = resolveReportReferenceDetailed(context.reportDir, report, {
      stepName: consumer.name,
      reportsRootDir: context.reportDir,
    });
    if (resolved.scope === 'missing') {
      throw new Error(`Report input "${report}" from "${declaration.fromStep}" is missing`);
    }
    return {
      reference: basename(report),
      scope: 'declared-producer' as const,
      content: resolved.content,
      producer: logicalProducer(source.name, report),
    };
  });
  return { declaredNames: reports.map(({ reference }) => reference), reports };
}
