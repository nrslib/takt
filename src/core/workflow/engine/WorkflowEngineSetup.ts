import { existsSync, mkdirSync } from 'node:fs';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger } from '../../../shared/utils/index.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  AgentResponse,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import type { FindingManagerAuthority } from '../../models/finding-types.js';
import { prepareRuntimeEnvironment } from '../../runtime/runtime-environment.js';
import type { RunPaths } from '../run/run-paths.js';
import type {
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
  WorkflowStepFailureSummary,
} from '../types.js';
import { createRunFailure } from '../run/run-failure.js';
import { ArpeggioRunner } from './ArpeggioRunner.js';
import { LoopMonitorJudgeRunner } from './LoopMonitorJudgeRunner.js';
import { OptionsBuilder } from './OptionsBuilder.js';
import { ParallelRunner } from './ParallelRunner.js';
import { DynamicParallelSelectorCoordinator } from '../dynamic-parallel/selector-coordinator.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import { StepExecutor } from './StepExecutor.js';
import { SystemStepExecutor } from './SystemStepExecutor.js';
import { TeamLeaderRunner } from './TeamLeaderRunner.js';
import { createWorkflowPhaseRelay } from './WorkflowEnginePhaseRelay.js';
import { WorkflowCallRunner } from './WorkflowCallRunner.js';
import { getWorkflowReference } from '../workflow-reference.js';
import type { WorkflowCallChildEngine } from '../types.js';
import type { StructuredOutputNormalizerRegistry } from './structured-output-normalizer.js';
import { runQualityGates } from '../quality-gates/qualityGateRunner.js';
import type { FindingLedgerStore } from '../findings/store.js';
import { createRawFindingsStructuredOutput } from '../findings/manager-runner.js';
import {
  ledgerHasDismissedFindings,
  ledgerHasOpenFindings,
  ledgerHasWaivedFindings,
  renderFindingLedgerInstructionSummary,
  renderFindingLedgerReportSummary,
} from '../findings/context.js';
import { renderLoopMonitorFindingsSummary } from '../findings/loop-monitor-summary.js';
import { computeReviewScopeSnapshotId } from '../findings/snapshot.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
  listFindingReviewPublications,
  type RestatementRequestV1,
} from '../findings/review-publication.js';
import { RAW_FINDING_LIMITS } from '../findings/raw-finding-limits.js';
import type { FindingTarget } from '../../models/finding-types.js';
import type {
  FindingContractInstructionContext,
  FindingContractReviewerOutputStrategy,
} from '../instruction/instruction-context.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
import { resolveFindingIntakeNormalizeConfig } from '../findings/intake-normalize-policy.js';
import {
  createReviewReportDiscoveryContext,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { DynamicParallelSelectionStore } from '../dynamic-parallel/selection-store.js';
import {
  restoreWorkflowCallInvocationEvidence,
  snapshotWorkflowCallInvocationEvidence,
  type WorkflowCallInvocationEvidence,
} from '../workflow-call-invocation-index.js';
import { SelectorInputReader } from '../dynamic-parallel/selector-input-reader.js';
import { restoreWorkflowStepParticipationIndex } from '../workflow-step-participation-index.js';

const log = createLogger('workflow-engine');

export class FindingReviewCapacityError extends Error {
  readonly failure: WorkflowStepFailureSummary;

  constructor(input: {
    stepName: string;
    anomalyIds: readonly string[];
    classificationAuthorityIds: readonly string[];
    requiredInvocations: number;
    remainingCapacity: number;
  }) {
    const unpresentedIds = [...input.anomalyIds].sort(compareBinaryStrings);
    const reason = `Finding review presentation capacity is insufficient: ${input.requiredInvocations} invocation(s) required, ${input.remainingCapacity} remaining`;
    super(reason);
    this.name = 'FindingReviewCapacityError';
    this.failure = createRunFailure({
      kind: 'review_integrity_unresolved',
      step: input.stepName,
      reason,
      error: reason,
      details: {
        reviewIntegrity: {
          code: 'review_integrity_unresolved_unpresented',
          anomalyIds: unpresentedIds,
          unpresentedIds,
          classificationAuthorityIds: [...input.classificationAuthorityIds].sort(compareBinaryStrings),
          publicationIds: [],
        },
      },
    });
  }
}

interface WorkflowEngineSetupParams {
  config: WorkflowConfig;
  state: WorkflowState;
  task: string;
  projectCwd: string;
  getCwd: () => string;
  getReportDir: () => string;
  getRunPaths: () => RunPaths;
  getMaxSteps: () => WorkflowMaxSteps;
  options: WorkflowEngineOptions & { structuredOutputNormalizers: StructuredOutputNormalizerRegistry };
  structuredCaller: StructuredCaller;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: readonly WorkflowResumePointEntry[];
  getCurrentWorkflowStack: () => WorkflowResumePointEntry[] | undefined;
  runPaths: RunPaths;
  updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  claimStepOccurrence: (
    step: WorkflowStep,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => number;
  consumeWorkflowCallContinuation: (
    step: WorkflowStep,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => WorkflowResumePointEntry | undefined;
  setActiveResumePoint: (
    step: WorkflowStep,
    iteration: number,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => void;
  persistDynamicParallelSelection: (
    step: WorkflowStep,
    iteration: number,
    identity: string,
    selection: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ) => Promise<void>;
  refreshFindingsState: () => void;
  /** 自前 or workflow_call 親から継承した、この engine で有効な Finding Contract。 */
  findingContract?: FindingContractConfig;
  findingManagerAuthority: FindingManagerAuthority;
  findingLedgerStore?: FindingLedgerStore;
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  resolveNextStepFromDone: (step: WorkflowStep, response: AgentResponse) => string;
  resetCycleDetector: () => void;
  emitEvent: (event: string, ...args: unknown[]) => void;
  createEngine: (
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) => WorkflowCallChildEngine;
}

export interface WorkflowEngineServices {
  optionsBuilder: OptionsBuilder;
  stepExecutor: StepExecutor;
  parallelRunner: ParallelRunner;
  arpeggioRunner: ArpeggioRunner;
  teamLeaderRunner: TeamLeaderRunner;
  systemStepExecutor: SystemStepExecutor;
  loopMonitorJudgeRunner: LoopMonitorJudgeRunner;
  workflowCallRunner: WorkflowCallRunner;
}

export function assertTaskPrefixPair(taskPrefix: string | undefined, taskColorIndex: number | undefined): void {
  const hasTaskPrefix = taskPrefix != null;
  const hasTaskColorIndex = taskColorIndex != null;
  if (hasTaskPrefix !== hasTaskColorIndex) {
    throw new Error('taskPrefix and taskColorIndex must be provided together');
  }
}

export function createSharedRuntime(
  resumePoint: WorkflowResumePoint | undefined,
  maxSteps: WorkflowMaxSteps,
): WorkflowSharedRuntimeState {
  const now = Date.now();
  return {
    startedAtMs: resumePoint ? now - resumePoint.elapsed_ms : now,
    maxSteps,
    dynamicParallelSelectionStore: new DynamicParallelSelectionStore(
      new Map(Object.entries(resumePoint?.dynamic_parallel_selections ?? {})),
    ),
    workflowCallInvocationEvidence: restoreWorkflowCallInvocationEvidence(resumePoint),
    workflowStepParticipationIndex: restoreWorkflowStepParticipationIndex(resumePoint),
  };
}

export function ensureRunDirsExist(runPaths: RunPaths): void {
  for (const dir of [
    runPaths.runRootAbs,
    runPaths.reportsAbs,
    runPaths.contextAbs,
    runPaths.contextKnowledgeAbs,
    runPaths.contextPolicyAbs,
    runPaths.contextPreviousResponsesAbs,
    runPaths.logsAbs,
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function applyRuntimeEnvironment(
  cwd: string,
  config: WorkflowConfig,
  stage: 'init' | 'step',
): void {
  const prepared = prepareRuntimeEnvironment(cwd, config.runtime);
  if (!prepared) {
    return;
  }

  log.info('Runtime environment prepared', {
    stage,
    runtimeRoot: prepared.runtimeRoot,
    envFile: prepared.envFile,
    prepare: prepared.prepare,
    tmpdir: prepared.injectedEnv.TMPDIR,
    gradleUserHome: prepared.injectedEnv.GRADLE_USER_HOME,
    npmCache: prepared.injectedEnv.npm_config_cache,
  });
}

export function assertFindingReviewPresentationCapacity(input: {
  ledger: ReturnType<FindingLedgerStore['loadLedger']>;
  presentationCounts: ReadonlyMap<string, number>;
  maxSteps: WorkflowMaxSteps;
  currentIteration: number;
  stepName: string;
}): void {
  const unpresented = (input.ledger.reviewerAnomalies ?? []).filter((anomaly) => {
    const defect = anomaly.intakeContract;
    const presentedCount = input.presentationCounts.get(anomaly.id) ?? 0;
    return anomaly.kind === 'intake-contract-incomplete'
      && defect !== undefined
      && anomaly.promotedFindingId === undefined
      && anomaly.settlement === undefined
      && defect.terminalDisposition === undefined
      && presentedCount === 0;
  });
  if (unpresented.length === 0) {
    return;
  }
  const countsByOwner = new Map<string, number>();
  for (const anomaly of unpresented) {
    const owner = anomaly.intakeContract!.presentationOwnerReviewer;
    countsByOwner.set(owner, (countsByOwner.get(owner) ?? 0) + 1);
  }
  const total = unpresented.length;
  const ownerInvocationCount = Math.max(
    ...Array.from(countsByOwner.values(), (count) => Math.ceil(count / 64)),
  );
  const requiredInvocations = Math.max(ownerInvocationCount, Math.ceil(total / 128));
  const remainingCapacity = typeof input.maxSteps === 'number'
    ? Math.max(0, input.maxSteps - input.currentIteration + (input.currentIteration > 0 ? 1 : 0))
    : 0;
  if (requiredInvocations <= remainingCapacity) {
    return;
  }
  throw new FindingReviewCapacityError({
    stepName: input.stepName,
    anomalyIds: unpresented.map(({ id }) => id),
    classificationAuthorityIds: unpresented.map(
      ({ intakeContract }) => intakeContract!.classificationAuthorityId,
    ),
    requiredInvocations,
    remainingCapacity,
  });
}

function targetPathsForRestatementRequest(target: FindingTarget): string[] {
  const sortedUniquePaths = (paths: readonly string[]): string[] => (
    [...new Set(paths)].sort(compareBinaryStrings)
  );
  switch (target.kind) {
    case 'code':
      return sortedUniquePaths(target.paths);
    case 'structure':
      return sortedUniquePaths([...target.scope.roots, ...target.manifestTargets]);
    case 'absence':
      return target.predicate.kind === 'path_state'
        ? [target.predicate.path]
        : sortedUniquePaths(target.predicate.roots);
    case 'review_scope':
      return [];
  }
}

function boundedRestatementClaimExcerpt(
  anomaly: NonNullable<ReturnType<FindingLedgerStore['loadLedger']>['reviewerAnomalies']>[number],
  raw: NonNullable<ReturnType<FindingLedgerStore['loadLedger']>['rawFindings']>[number],
): string {
  return (anomaly.claimedExcerpt ?? raw.description ?? raw.rawExcerpt ?? '')
    .slice(0, RAW_FINDING_LIMITS.maxDescriptionChars);
}

export function createWorkflowEngineServices(params: WorkflowEngineSetupParams): WorkflowEngineServices {
  const phaseRelay = createWorkflowPhaseRelay(
    (event, ...args) => params.emitEvent(event, ...args),
    params.getCurrentWorkflowStack,
  );
  const intakeNormalize = resolveFindingIntakeNormalizeConfig(
    params.options.findingContractConfig?.intakeNormalize,
    params.findingContract,
  );
  let frozenParallelFindingContractInput: {
    contextKey: string;
    ledger: ReturnType<FindingLedgerStore['loadLedger']>;
    presentationCounts: Map<string, number>;
    contexts: Map<string, FindingContractInstructionContext>;
    allocatedRequestCount: number;
  } | undefined;
  const buildFindingContractInstructionContext = (
    step: WorkflowStep,
    strategy: FindingContractReviewerOutputStrategy | undefined,
    sharedReviewScopeSnapshotId?: string,
    parallelContextKey?: string,
  ): FindingContractInstructionContext | undefined => {
    if (!params.findingContract) {
      return undefined;
    }
    if (!params.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }

    let ledger: ReturnType<FindingLedgerStore['loadLedger']>;
    let presentationCounts: Map<string, number>;
    let frozenContexts: Map<string, FindingContractInstructionContext> | undefined;
    let allocatedRequestCount = 0;
    if (
      sharedReviewScopeSnapshotId !== undefined
      && parallelContextKey !== undefined
      && frozenParallelFindingContractInput?.contextKey === parallelContextKey
    ) {
      ({ ledger, presentationCounts, contexts: frozenContexts, allocatedRequestCount } = frozenParallelFindingContractInput);
    } else {
      ledger = params.findingLedgerStore.loadLedger();
      presentationCounts = new Map<string, number>();
      for (const publication of listFindingReviewPublications(params.getReportDir())) {
        if (publication.presentationContext?.revision !== 2) {
          continue;
        }
        for (const anomalyId of publication.presentationContext.presentedReviewerAnomalyIds) {
          presentationCounts.set(anomalyId, (presentationCounts.get(anomalyId) ?? 0) + 1);
        }
      }
      if (parallelContextKey !== undefined) {
        frozenParallelFindingContractInput = {
          contextKey: parallelContextKey,
          ledger,
          presentationCounts,
          contexts: new Map(),
          allocatedRequestCount: 0,
        };
        frozenContexts = frozenParallelFindingContractInput.contexts;
      }
    }
    if (frozenContexts !== undefined && strategy !== undefined) {
      const frozenContext = frozenContexts.get(step.name);
      if (frozenContext !== undefined) {
        return frozenContext;
      }
    }
    let reviewer: FindingContractInstructionContext['reviewer'];
    if (strategy !== undefined) {
      const reviewScopeSnapshotId = sharedReviewScopeSnapshotId
        ?? computeReviewScopeSnapshotId(params.getCwd());
      assertFindingReviewPresentationCapacity({
        ledger,
        presentationCounts,
        maxSteps: params.getMaxSteps(),
        currentIteration: params.state.iteration,
        stepName: step.name,
      });
      const requests = (ledger.reviewerAnomalies ?? [])
        .filter((anomaly) => (
          anomaly.kind === 'intake-contract-incomplete'
          && anomaly.intakeContract !== undefined
          && anomaly.intakeContract.presentationOwnerReviewer === step.name
          && anomaly.promotedFindingId === undefined
          && anomaly.settlement === undefined
        ))
        .map((anomaly) => ({
          anomaly,
          presentedCount: presentationCounts.get(anomaly.id) ?? 0,
        }))
        .filter(({ anomaly, presentedCount }) => (
          presentedCount < anomaly.intakeContract!.presentationLimit
        ))
        .sort((left, right) => (
          left.presentedCount - right.presentedCount
          || compareBinaryStrings(left.anomaly.firstObserved.timestamp, right.anomaly.firstObserved.timestamp)
          || compareBinaryStrings(left.anomaly.id, right.anomaly.id)
        ))
        .slice(0, Math.min(64, Math.max(0, 128 - allocatedRequestCount)));
      const restatementRequests: RestatementRequestV1[] = requests.flatMap(({ anomaly, presentedCount }) => {
        const raw = anomaly.sourceRawFindingIds
          .map((rawId) => ledger.rawFindings.find((candidate) => candidate.rawFindingId === rawId))
          .find((candidate) => candidate !== undefined);
        if (raw === undefined) {
          return [];
        }
        const requestWithoutId = {
          anomalyId: anomaly.id,
          reviewer: step.name,
          presentationOrdinal: presentedCount + 1,
          reviewScopeSnapshotId,
          sourceExcerptDigest: raw.sourceBinding.excerptDigest,
          claimedExcerpt: boundedRestatementClaimExcerpt(anomaly, raw),
          targetPaths: targetPathsForRestatementRequest(raw.target),
          missingRequirements: anomaly.intakeContract!.missingRequirements,
          expectedRelation: 'new' as const,
          expectedTargetFindingId: null,
          expectedTargetPreconditionClass: 'absent' as const,
        };
        return [{
          ...requestWithoutId,
          restatementRequestId: computeRestatementRequestId(requestWithoutId),
        }];
      });
      const presentationContext = createFindingReviewPresentationContextV2({
        reviewScopeSnapshotId,
        restatementRequests,
      });
      reviewer = strategy.reportGeneration === 'structured'
        ? {
            mode: 'structured',
            rawFindingsStructuredOutput: createRawFindingsStructuredOutput(),
            reviewScopeSnapshotId,
            presentationContext,
          }
        : {
            mode: strategy.kind,
            reviewScopeSnapshotId,
            presentationContext,
          };
      if (frozenContexts !== undefined && parallelContextKey !== undefined) {
        frozenContexts.set(step.name, {
          ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
          reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
          hasOpenFindings: ledgerHasOpenFindings(ledger),
          hasWaivedFindings: ledgerHasWaivedFindings(ledger),
          hasDismissedFindings: ledgerHasDismissedFindings(ledger),
          ...(reviewer !== undefined ? { reviewer } : {}),
        });
        frozenParallelFindingContractInput = {
          contextKey: parallelContextKey,
          ledger,
          presentationCounts,
          contexts: frozenContexts,
          allocatedRequestCount: allocatedRequestCount + restatementRequests.length,
        };
      }
    }
    const context = {
      ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
      reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
      hasOpenFindings: ledgerHasOpenFindings(ledger),
      hasWaivedFindings: ledgerHasWaivedFindings(ledger),
      hasDismissedFindings: ledgerHasDismissedFindings(ledger),
      ...(reviewer !== undefined ? { reviewer } : {}),
    };
    return context;
  };

  const optionsBuilder = new OptionsBuilder(
    params.options,
    params.getCwd,
    () => params.projectCwd,
    (persona) => params.state.personaSessions.get(persona),
    params.getReportDir,
    () => params.options.language,
    () => params.config.steps.map((step) => ({ name: step.name, description: step.description })),
    () => params.config.name,
    () => params.config.description,
    params.getCurrentWorkflowStack,
    buildFindingContractInstructionContext,
    () => params.task,
  );

  const stepExecutor = new StepExecutor({
    optionsBuilder,
    getCwd: params.getCwd,
    getProjectCwd: () => params.projectCwd,
    getReportDir: params.getReportDir,
    getRunPaths: params.getRunPaths,
    getLanguage: () => params.options.language,
    getInteractive: () => params.options.interactive === true,
    getWorkflowSteps: () => params.config.steps.map((step) => ({ name: step.name, description: step.description })),
    getWorkflowName: () => params.config.name,
    getTask: () => params.task,
    getWorkflowDescription: () => params.config.description,
    getWorkflowCallVars: () => params.options.workflowCallVars,
    getRetryNote: () => params.options.retryNote,
    getPrContext: () => params.options.prContext,
    getObservabilityRunId: () => params.options.observabilityRunId,
    observabilityEnabled: () => params.options.observability?.enabled === true,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    structuredOutputNormalizers: params.options.structuredOutputNormalizers,
    structuredCaller: params.structuredCaller,
    intakeNormalize,
    abortSignal: params.options.abortSignal,
    findingContract: params.findingContract,
    findingManagerAuthority: params.findingManagerAuthority,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
    executionProvider: params.options.provider,
    executionModel: params.options.model,
    findingLedgerStore: params.findingLedgerStore,
    refreshFindingsState: params.refreshFindingsState,
    emitEvent: params.emitEvent,
    recordSynthesizedAgentUsage: (stepName, providerInfo, success, usage) =>
      recordAgentUsageEvent(params.options, stepName, 'normal', providerInfo, success, usage),
    getRunId: () => params.runPaths.slug,
    getFindingCallNamespace: () => params.options.findingCallNamespace ?? '',
    ...phaseRelay,
  });

  const workflowCallRunner = new WorkflowCallRunner({
    getConfig: () => params.config,
    getMaxSteps: params.getMaxSteps,
    updateMaxSteps: params.updateMaxSteps,
    state: params.state as never,
    projectCwd: params.projectCwd,
    getCwd: params.getCwd,
    task: params.task,
    getOptions: () => params.options,
    sharedRuntime: params.sharedRuntime,
    resumeStackPrefix: [...(params.resumeStackPrefix ?? [])],
    consumeWorkflowCallContinuation: params.consumeWorkflowCallContinuation,
    runPaths: params.runPaths,
    setActiveResumePoint: params.setActiveResumePoint,
    emit: params.emitEvent,
    resolveWorkflowCall: (request) => params.options.workflowCallResolver!(request),
    createEngine: params.createEngine,
    findingContract: params.findingContract,
    findingLedgerStore: params.findingLedgerStore,
    refreshFindingsState: params.refreshFindingsState,
  });

  const dynamicParallelSelector = new DynamicParallelSelectorCoordinator({
    engineOptions: params.options,
    selectionStore: params.sharedRuntime.dynamicParallelSelectionStore!,
    getCwd: params.getCwd,
    getReportDirectory: () => params.runPaths.reportsAbs,
    getReportNames: (_step, state) => getSelectorReportNames(
      params.config,
      state,
      params.resumeStackPrefix,
      params.options.workflowCallResolver,
      params.projectCwd,
      params.getCwd(),
      params.sharedRuntime.workflowCallInvocationEvidence!,
      params.sharedRuntime.workflowStepParticipationIndex!,
    ),
    getWorkflowReference: () => getWorkflowReference(params.config),
    workflowCallPath: params.resumeStackPrefix,
    commitSelection: params.persistDynamicParallelSelection,
    ...(params.options.selectorGitCommandRunner === undefined
      ? {}
      : { inputReader: new SelectorInputReader(params.options.selectorGitCommandRunner) }),
  });

  const parallelRunner = new ParallelRunner({
    optionsBuilder,
    stepExecutor,
    engineOptions: params.options,
    getCwd: params.getCwd,
    dynamicParallelSelector,
    getWorkflowName: () => params.config.name,
    getTask: () => params.task,
    getInteractive: () => params.options.interactive === true,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    refreshFindingsState: params.refreshFindingsState,
    emitEvent: params.emitEvent,
    findingContract: params.findingContract,
    intakeNormalize,
    findingManagerAuthority: params.findingManagerAuthority,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
    findingLedgerStore: params.findingLedgerStore,
    getWorkflowCallRunner: () => workflowCallRunner,
    claimStepOccurrence: params.claimStepOccurrence,
    updateMaxSteps: params.updateMaxSteps,
    setActiveResumePoint: (step, iteration, occurrence) => params.setActiveResumePoint(
      step,
      iteration,
      occurrence,
      params.resumeStackPrefix,
    ),
    getRunId: () => params.runPaths.slug,
    reviewPublicationDir: params.runPaths.reportsAbs,
    getFindingCallNamespace: () => params.options.findingCallNamespace ?? '',
    runQualityGates,
    ...phaseRelay,
  });

  const arpeggioRunner = new ArpeggioRunner({
    optionsBuilder,
    stepExecutor,
    getCwd: params.getCwd,
    getWorkflowName: () => params.config.name,
    getInteractive: () => params.options.interactive === true,
    childProcessEnv: params.options.childProcessEnv,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    onPhaseStart: phaseRelay.onPhaseStart,
    onPhaseComplete: phaseRelay.onPhaseComplete,
  });

  const teamLeaderRunner = new TeamLeaderRunner({
    optionsBuilder,
    stepExecutor,
    engineOptions: params.options,
    getCwd: params.getCwd,
    getTask: () => params.task,
    getState: () => params.state,
    getWorkflowName: () => params.config.name,
    getInteractive: () => params.options.interactive === true,
    getRunPaths: params.getRunPaths,
    findingContract: params.findingContract,
    findingLedgerStore: params.findingLedgerStore,
    operationJournal: params.options.operationJournal,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    onPhaseStart: phaseRelay.onPhaseStart,
    onPhaseComplete: phaseRelay.onPhaseComplete,
    emitEvent: params.emitEvent,
  });

  const systemStepExecutor = new SystemStepExecutor({
    task: params.task,
    projectCwd: params.projectCwd,
    getCwd: params.getCwd,
    taskContext: params.options.currentTask,
    getRuleContext: () => {
      return {
        interactive: params.options.interactive === true,
      };
    },
    getStatusJudgmentContext: (step, state, lastResponse, runtime) => optionsBuilder.buildPhaseRunnerContext(
      step,
      state,
      lastResponse,
      params.updatePersonaSession,
      phaseRelay.onPhaseStart,
      phaseRelay.onPhaseComplete,
      phaseRelay.onJudgeStage,
      state.iteration,
      runtime,
    ),
    systemStepServicesFactory: params.options.systemStepServicesFactory,
  });

  const loopMonitorJudgeRunner = new LoopMonitorJudgeRunner({
    optionsBuilder,
    stepExecutor,
    state: params.state as never,
    task: params.task,
    getMaxSteps: params.getMaxSteps,
    language: params.options.language,
    updatePersonaSession: params.updatePersonaSession,
    resolveNextStepFromDone: params.resolveNextStepFromDone as never,
    onStepStart: (step, iteration, instruction, providerInfo, resumeStepName, stepIteration) => {
      const workflowStack = requireWorkflowResumeStackSnapshot(
        params.getCurrentWorkflowStack(),
      );
      params.emitEvent(
        'step:start',
        step,
        iteration,
        instruction,
        providerInfo,
        params.config.name,
        resumeStepName,
        stepIteration,
        workflowStack,
        params.findingLedgerStore?.ledgerIdentity,
        params.findingLedgerStore
          ?.loadLedger()
          .findings
          .map((finding) => finding.id),
      );
      return workflowStack;
    },
    onStepComplete: (step, response, instruction, resumeStepName, workflowStack) => {
      params.emitEvent(
        'step:complete',
        step,
        response,
        instruction,
        resumeStepName,
        workflowStack,
      );
    },
    emitCollectedReports: () => {
      for (const {
        step,
        filePath,
        fileName,
        context,
      } of stepExecutor.drainReportFiles()) {
        params.emitEvent(
          'step:report',
          step,
          filePath,
          fileName,
          context,
        );
      }
    },
    resetCycleDetector: params.resetCycleDetector,
    ...(params.findingContract && params.findingLedgerStore
      ? {
          getFindingsSummaryForJudge: () =>
            renderLoopMonitorFindingsSummary(params.findingLedgerStore!.loadLedger(), params.findingContract!),
        }
      : {}),
  });

  return {
    optionsBuilder,
    stepExecutor,
    parallelRunner,
    arpeggioRunner,
    teamLeaderRunner,
    systemStepExecutor,
    loopMonitorJudgeRunner,
    workflowCallRunner,
  };
}

function getSelectorReportNames(
  config: WorkflowConfig,
  state: WorkflowState,
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
  workflowCallResolver: WorkflowEngineOptions['workflowCallResolver'],
  projectCwd: string,
  lookupCwd: string,
  workflowCallInvocationEvidence: WorkflowCallInvocationEvidence,
  workflowStepParticipationIndex: import('../workflow-step-participation-index.js').WorkflowStepParticipationIndex,
): readonly string[] {
  const results = config.steps
    .map((step) => resolveWorkflowStepReportNamesWithDiagnostics(step, createReviewReportDiscoveryContext({
      step,
      workflow: config,
      workflowCallResolver,
      projectCwd,
      lookupCwd,
      resumeStackPrefix,
      stepOutputNames: new Set(state.stepOutputs.keys()),
      restoredStepIterationNames: state.restoredStepIterationNames,
      dynamicParallelSelections: state.dynamicParallelSelections,
      workflowCallInvocations: snapshotWorkflowCallInvocationEvidence(
        workflowCallInvocationEvidence,
      ),
      workflowStepParticipations: workflowStepParticipationIndex.snapshot(),
    })));
  const failures = results.flatMap((result) => result.failures);
  if (failures.length > 0) {
    throw new Error(
      `Unable to resolve dynamic selector report inputs: ${failures.map((failure) => failure.reason).join('; ')}`,
    );
  }
  return results.flatMap((result) => result.reportNames);
}
