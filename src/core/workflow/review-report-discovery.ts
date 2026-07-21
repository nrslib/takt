import type { WorkflowConfig, WorkflowCallStep, WorkflowResumePointEntry, WorkflowStep } from '../models/types.js';
import type { WorkflowCallResolver } from './types.js';
import { getReportFiles } from './evaluation/rule-utils.js';
import { MAX_WORKFLOW_CALL_DEPTH } from './workflow-call-depth.js';
import { buildWorkflowCallNamespaceSegment } from './workflow-call-namespace.js';
import { getWorkflowReference } from './workflow-reference.js';
import { getErrorMessage } from '../../shared/utils/index.js';

const REPORT_PATH_SEPARATOR = '/';

export interface InheritedReviewReportNamesResult {
  readonly reportNames: readonly string[];
  readonly failures: readonly string[];
}

export interface InheritedReportSourceResolverContext {
  readonly step: WorkflowStep;
  readonly workflow: WorkflowConfig;
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
}

export function resolveInheritedReviewReportNamesWithDiagnostics(
  context: InheritedReportSourceResolverContext,
): InheritedReviewReportNamesResult {
  const failures: string[] = [];
  for (const sources of resolveReviewReportSourceStepGroups(context.step, context.workflow.steps)) {
    const result = combineReportNameResults(sources.map((source) => resolveWorkflowStepReportNames(
      source,
      context,
      [],
      new Set([getWorkflowReference(context.workflow)]),
      context.resumeStackPrefix.length + 1,
    )));
    failures.push(...result.failures);
    if (result.reportNames.length > 0) {
      return combineReportNameResults([
        { reportNames: result.reportNames, failures },
      ]);
    }
  }
  return combineReportNameResults([{ reportNames: [], failures }]);
}

export function resolveReviewReportSourceSteps(
  step: WorkflowStep,
  workflowSteps: ReadonlyArray<WorkflowStep>,
): WorkflowStep[] {
  return resolveReviewReportSourceStepGroups(step, workflowSteps)[0] ?? [];
}

function resolveReviewReportSourceStepGroups(
  step: WorkflowStep,
  workflowSteps: ReadonlyArray<WorkflowStep>,
): WorkflowStep[][] {
  const parallelParent = workflowSteps.find((candidate) =>
    candidate.parallel?.some((parallelStep) => parallelStep.name === step.name),
  );
  if (parallelParent?.parallel) {
    return [parallelParent.parallel.filter((peerStep) => peerStep.name !== step.name)];
  }

  const currentIndex = workflowSteps.findIndex((candidate) => candidate.name === step.name);
  if (currentIndex === -1) {
    return [];
  }

  const candidates: WorkflowStep[][] = [];
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = workflowSteps[index]!;
    const peerSteps = candidate.parallel?.filter(hasReportOutputs);
    if (peerSteps && peerSteps.length > 0) {
      candidates.push(peerSteps);
      break;
    }
    if (hasReportOutputs(candidate)) {
      candidates.push([candidate]);
      break;
    }
    if (candidate.kind === 'workflow_call') {
      candidates.push([candidate]);
    }
  }

  return candidates;
}

function resolveWorkflowCallReportNames(
  step: WorkflowCallStep,
  context: InheritedReportSourceResolverContext,
  namespace: readonly string[],
  workflowReferences: ReadonlySet<string>,
  depth: number,
): InheritedReviewReportNamesResult {
  let childWorkflow: WorkflowConfig | null | undefined;
  try {
    childWorkflow = context.workflowCallResolver?.({
      parentWorkflow: context.workflow,
      step,
      projectCwd: context.projectCwd,
      lookupCwd: context.lookupCwd,
    });
  } catch (error) {
    return { reportNames: [], failures: [`workflow_call_report_resolution_failed:${getErrorMessage(error)}`] };
  }
  if (!childWorkflow) {
    return { reportNames: [], failures: [`workflow_call_report_unknown:${step.call}`] };
  }
  const childWorkflowReference = getWorkflowReference(childWorkflow);
  if (workflowReferences.has(childWorkflowReference)) {
    return { reportNames: [], failures: [`workflow_call_report_cycle:${childWorkflow.name}`] };
  }
  const nextDepth = depth + 1;
  if (nextDepth > MAX_WORKFLOW_CALL_DEPTH) {
    return { reportNames: [], failures: [`workflow_call_report_depth_exceeded:${MAX_WORKFLOW_CALL_DEPTH}`] };
  }
  const childNamespace = [
    ...namespace,
    'subworkflows',
    buildWorkflowCallNamespaceSegment(step.name, childWorkflow.name, '*'),
  ];
  return combineReportNameResults(childWorkflow.steps.map((childStep) => resolveWorkflowStepReportNames(
    childStep,
    { ...context, workflow: childWorkflow },
    childNamespace,
    new Set([...workflowReferences, childWorkflowReference]),
    nextDepth,
  )));
}

function resolveWorkflowStepReportNames(
  step: WorkflowStep,
  context: InheritedReportSourceResolverContext,
  namespace: readonly string[],
  workflowReferences: ReadonlySet<string>,
  depth: number,
): InheritedReviewReportNamesResult {
  const reportNames = getReportFiles(step.outputContracts)
    .map((fileName) => [...namespace, fileName].join(REPORT_PATH_SEPARATOR));
  const parallelResults = step.parallel?.map((parallelStep) => resolveWorkflowStepReportNames(
    parallelStep,
    context,
    namespace,
    workflowReferences,
    depth,
  )) ?? [];
  const nestedWorkflowCallResult = step.kind === 'workflow_call'
    ? resolveWorkflowCallReportNames(step, context, namespace, workflowReferences, depth)
    : { reportNames: [], failures: [] };
  return combineReportNameResults([
    { reportNames, failures: [] },
    ...parallelResults,
    nestedWorkflowCallResult,
  ]);
}

function combineReportNameResults(
  results: readonly InheritedReviewReportNamesResult[],
): InheritedReviewReportNamesResult {
  return {
    reportNames: [...new Set(results.flatMap((result) => result.reportNames))],
    failures: [...new Set(results.flatMap((result) => result.failures))],
  };
}

function hasReportOutputs(step: WorkflowStep): boolean {
  return getReportFiles(step.outputContracts).length > 0;
}
