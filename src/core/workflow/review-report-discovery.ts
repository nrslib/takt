import {
  getAllParallelSubSteps,
  type DynamicParallelSelectionSnapshot,
  type WorkflowConfig,
  type WorkflowCallStep,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../models/types.js';
import type { WorkflowCallResolver } from './types.js';
import { getReportFiles } from './output-contract-files.js';
import { MAX_WORKFLOW_CALL_DEPTH } from './workflow-call-depth.js';
import { buildWorkflowResumePointEntry, getWorkflowReference } from './workflow-reference.js';
import { workflowCallNamespaceSegmentMatchesInvocation } from './workflow-call-namespace.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import {
  resolveReviewReportStepParticipation,
  type ReviewReportParticipationEvidence,
  type ReviewReportStepParticipation,
  type WorkflowCallReportParticipation,
} from './review-report-participation.js';

const REPORT_PATH_SEPARATOR = '/';

export interface InheritedReviewReportNamesResult {
  readonly reportNames: readonly string[];
  readonly failures: readonly ReviewReportDiscoveryFailure[];
}

export type ReviewReportDiscoveryFailure =
  | { readonly kind: 'recoverable'; readonly reason: string }
  | { readonly kind: 'fatal'; readonly reason: string };

export interface InheritedReportSourceResolverContext {
  readonly step: WorkflowStep;
  readonly workflow: WorkflowConfig;
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
  readonly participation: ReviewReportParticipationEvidence;
}

export interface ReviewReportDiscoveryContextOptions {
  readonly step: WorkflowStep;
  readonly workflow: WorkflowConfig;
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
  readonly resumeStackPrefix: readonly WorkflowResumePointEntry[];
  readonly stepOutputNames: ReadonlySet<string>;
  readonly restoredStepIterationNames: ReadonlySet<string>;
  readonly dynamicParallelSelections: ReadonlyMap<string, DynamicParallelSelectionSnapshot>;
  readonly workflowCallInvocations: ReviewReportParticipationEvidence['workflowCallInvocations'];
  readonly workflowStepParticipations?: ReviewReportParticipationEvidence['workflowStepParticipations'];
}

export function createReviewReportDiscoveryContext(
  options: ReviewReportDiscoveryContextOptions,
): InheritedReportSourceResolverContext {
  return {
    step: options.step,
    workflow: options.workflow,
    workflowCallResolver: options.workflowCallResolver,
    projectCwd: options.projectCwd,
    lookupCwd: options.lookupCwd,
    resumeStackPrefix: options.resumeStackPrefix,
    participation: {
      activeWorkflowReference: getWorkflowReference(options.workflow),
      stepOutputNames: options.stepOutputNames,
      restoredStepIterationNames: options.restoredStepIterationNames,
      dynamicParallelSelections: options.dynamicParallelSelections,
      workflowCallInvocations: options.workflowCallInvocations,
      workflowStepParticipations: options.workflowStepParticipations ?? new Map(),
    },
  };
}

export function resolveInheritedReviewReportNamesWithDiagnostics(
  context: InheritedReportSourceResolverContext,
): InheritedReviewReportNamesResult {
  const sourceResolution = resolveReviewReportSourceStepGroups(
    context.step,
    context.workflow.steps,
    context,
  );
  const failures = [...sourceResolution.failures];
  for (const sources of sourceResolution.groups) {
    const result = combineReportNameResults(sources.map((source) => resolveParticipatedWorkflowStepReportNames(
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

export function resolveWorkflowStepReportNamesWithDiagnostics(
  step: WorkflowStep,
  context: InheritedReportSourceResolverContext,
): InheritedReviewReportNamesResult {
  return resolveWorkflowStepReportNames(
    step,
    context,
    [],
    new Set([getWorkflowReference(context.workflow)]),
    context.resumeStackPrefix.length + 1,
  );
}

interface ReviewReportSourceStepGroups {
  readonly groups: WorkflowStep[][];
  readonly failures: ReviewReportDiscoveryFailure[];
}

function resolveReviewReportSourceStepGroups(
  step: WorkflowStep,
  workflowSteps: ReadonlyArray<WorkflowStep>,
  context: InheritedReportSourceResolverContext,
): ReviewReportSourceStepGroups {
  const parallelParent = workflowSteps.find((candidate) =>
    candidate.parallel !== undefined
      && getAllParallelSubSteps(candidate.parallel)
        .some((parallelStep) => parallelStep.name === step.name),
  );
  if (parallelParent?.parallel) {
    const participation = resolveParticipation(parallelParent, context);
    if (participation.kind === 'invalid') {
      return {
        groups: [],
        failures: [{ kind: 'fatal', reason: participation.reason }],
      };
    }
    if (participation.kind === 'not-participated') {
      return { groups: [], failures: [] };
    }
    return {
      groups: [[
        ...participation.parallelParticipants
          .filter((peerStep) => peerStep.name !== step.name),
      ]],
      failures: [],
    };
  }

  const currentIndex = workflowSteps.findIndex((candidate) => candidate.name === step.name);
  if (currentIndex === -1) {
    return { groups: [], failures: [] };
  }

  const candidates: WorkflowStep[][] = [];
  const failures: ReviewReportDiscoveryFailure[] = [];
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = workflowSteps[index]!;
    const participation = resolveParticipation(candidate, context);
    if (participation.kind === 'not-participated') continue;
    if (participation.kind === 'invalid') {
      failures.push({ kind: 'fatal', reason: participation.reason });
      continue;
    }
    const peerSteps = candidate.parallel === undefined
      ? undefined
      : participation.parallelParticipants.filter(hasReportOutputs);
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

  return { groups: candidates, failures };
}

function resolveWorkflowCallReportNames(
  step: WorkflowCallStep,
  reportParticipation: WorkflowCallReportParticipation,
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
    return {
      reportNames: [],
      failures: [{
        kind: 'recoverable',
        reason: `workflow_call_report_resolution_failed:${getErrorMessage(error)}`,
      }],
    };
  }
  if (!childWorkflow) {
    return {
      reportNames: [],
      failures: [{ kind: 'recoverable', reason: `workflow_call_report_unknown:${step.call}` }],
    };
  }
  const childWorkflowReference = getWorkflowReference(childWorkflow);
  if (workflowReferences.has(childWorkflowReference)) {
    return {
      reportNames: [],
      failures: [{ kind: 'recoverable', reason: `workflow_call_report_cycle:${childWorkflow.name}` }],
    };
  }
  const nextDepth = depth + 1;
  if (nextDepth > MAX_WORKFLOW_CALL_DEPTH) {
    return {
      reportNames: [],
      failures: [{
        kind: 'recoverable',
        reason: `workflow_call_report_depth_exceeded:${MAX_WORKFLOW_CALL_DEPTH}`,
      }],
    };
  }
  if (!workflowCallNamespaceSegmentMatchesInvocation(
    reportParticipation.invocation.report_namespace_segment,
    step.name,
    childWorkflow.name,
  )) {
    return {
      reportNames: [],
      failures: [{
        kind: 'fatal',
        reason: `workflow_call_invocation_namespace_mismatch:${step.name}`,
      }],
    };
  }
  const namespaceSegment = reportParticipation.invocation.report_namespace_segment;
  const childNamespace = [
    ...namespace,
    'subworkflows',
    namespaceSegment,
  ];
  return combineReportNameResults(childWorkflow.steps.map((childStep) => resolveWorkflowStepReportNames(
    childStep,
    {
      ...context,
      workflow: childWorkflow,
      resumeStackPrefix: [
        ...context.resumeStackPrefix,
        buildWorkflowResumePointEntry(
          context.workflow,
          step.name,
          step.kind,
          undefined,
          reportParticipation.invocation.call_instance,
        ),
      ],
    },
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
  const participation = resolveParticipation(step, context);
  if (participation.kind === 'not-participated') {
    return { reportNames: [], failures: [] };
  }
  if (participation.kind === 'invalid') {
    return {
      reportNames: [],
      failures: [{ kind: 'fatal', reason: participation.reason }],
    };
  }
  const generatedReportNames = new Set(participation.reportNames);
  const reportNames = getReportFiles(step.outputContracts)
    .filter((fileName) => generatedReportNames.has(fileName))
    .map((fileName) => [...namespace, fileName].join(REPORT_PATH_SEPARATOR));
  const parallelResults = participation.parallelParticipants.map((parallelStep) =>
    resolveParticipatedWorkflowStepReportNames(
      parallelStep,
      context,
      namespace,
      workflowReferences,
      depth,
    ));
  const nestedWorkflowCallResult = step.kind === 'workflow_call'
    && participation.workflowCallReport !== undefined
    ? resolveWorkflowCallReportNames(
        step,
        participation.workflowCallReport,
        context,
        namespace,
        workflowReferences,
        depth,
      )
    : { reportNames: [], failures: [] };
  return combineReportNameResults([
    { reportNames, failures: [] },
    ...parallelResults,
    nestedWorkflowCallResult,
  ]);
}

function resolveParticipatedWorkflowStepReportNames(
  step: WorkflowStep,
  context: InheritedReportSourceResolverContext,
  namespace: readonly string[],
  workflowReferences: ReadonlySet<string>,
  depth: number,
): InheritedReviewReportNamesResult {
  return resolveWorkflowStepReportNames(
    step,
    context,
    namespace,
    workflowReferences,
    depth,
  );
}

function resolveParticipation(
  step: WorkflowStep,
  context: InheritedReportSourceResolverContext,
): ReviewReportStepParticipation {
  return resolveReviewReportStepParticipation(
    step,
    context.workflow,
    context.resumeStackPrefix,
    context.participation,
  );
}

function combineReportNameResults(
  results: readonly InheritedReviewReportNamesResult[],
): InheritedReviewReportNamesResult {
  const failures = new Map<string, ReviewReportDiscoveryFailure>();
  for (const failure of results.flatMap((result) => result.failures)) {
    failures.set(`${failure.kind}\0${failure.reason}`, failure);
  }
  return {
    reportNames: [...new Set(results.flatMap((result) => result.reportNames))],
    failures: [...failures.values()],
  };
}

function hasReportOutputs(step: WorkflowStep): boolean {
  return getReportFiles(step.outputContracts).length > 0;
}
