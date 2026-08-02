import { existsSync, mkdirSync } from 'node:fs';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger } from '../../../shared/utils/index.js';
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
import { prepareRuntimeEnvironment } from '../../runtime/runtime-environment.js';
import type { RunPaths } from '../run/run-paths.js';
import type { WorkflowEngineOptions, WorkflowSharedRuntimeState } from '../types.js';
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
import type { FindingContractInstructionContext } from '../instruction/instruction-context.js';
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
import { WorkflowStepBudget } from '../workflow-step-budget.js';
import {
  snapshotWorkflowExecutionScope,
  workflowOwnerPathFromStack,
} from '../workflow-execution-scope.js';
import { WorkflowCallProgressTracker } from '../workflow-call-progress-tracker.js';
import type { WorkflowCallProgressLease } from '../workflow-call-progress-tracker.js';

const log = createLogger('workflow-engine');

interface WorkflowEngineSetupParams {
  config: WorkflowConfig;
  state: WorkflowState;
  task: string;
  projectCwd: string;
  getCwd: () => string;
  getReportDir: () => string;
  getRunPaths: () => RunPaths;
  stepBudget: WorkflowStepBudget;
  interruptRequested: () => boolean;
  options: WorkflowEngineOptions & { structuredOutputNormalizers: StructuredOutputNormalizerRegistry };
  structuredCaller: StructuredCaller;
  sharedRuntime: WorkflowSharedRuntimeState;
  progressLease: WorkflowCallProgressLease;
  resumeStackPrefix: readonly WorkflowResumePointEntry[];
  runPaths: RunPaths;
  setActiveResumePoint: (step: WorkflowStep, iteration: number) => void;
  setActiveResumeStack: (stack: readonly WorkflowResumePointEntry[], iteration: number) => void;
  adoptResumeCheckpoint: (resumePoint: WorkflowResumePoint, iteration: number) => void;
  getActiveResumePoint: () => import('../../models/types.js').WorkflowResumePoint | undefined;
  buildStepExecutionScope: (step: WorkflowStep, iteration: number) => import('../workflow-execution-scope.js').WorkflowExecutionScope;
  setPendingLoopJudge: (
    triggeringStep: WorkflowStep,
    pending: import('../../models/types.js').WorkflowPendingLoopJudge,
    iteration: number,
  ) => void;
  startPendingLoopJudge: (
    judgeStep: WorkflowStep,
    pending: import('../../models/types.js').WorkflowPendingLoopJudgeStarted,
    iteration: number,
  ) => void;
  clearPendingLoopJudge: (triggeringStep: WorkflowStep, iteration: number) => void;
  syncMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  persistDynamicParallelSelection: (
    step: WorkflowStep,
    iteration: number,
    identity: string,
    selection: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ) => Promise<void>;
  refreshFindingsState: () => void;
  /** 自前 or workflow_call 親から継承した、この engine で有効な Finding Contract。 */
  findingContract?: FindingContractConfig;
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
    stepBudget: new WorkflowStepBudget(maxSteps),
    workflowCallProgressTracker: new WorkflowCallProgressTracker(),
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

export function createWorkflowEngineServices(params: WorkflowEngineSetupParams): WorkflowEngineServices {
  const phaseRelay = createWorkflowPhaseRelay((event, ...args) => params.emitEvent(event, ...args));
  const getCurrentWorkflowStack = () => params.getActiveResumePoint()?.stack;
  const buildFindingContractInstructionContext = (
    _step: WorkflowStep,
    includeRawFindingsSchema: boolean,
  ): FindingContractInstructionContext | undefined => {
    if (!params.findingContract) {
      return undefined;
    }
    if (!params.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }

    const ledger = params.findingLedgerStore.loadLedger();
    let reviewerContext: Pick<
      FindingContractInstructionContext,
      'rawFindingsStructuredOutput' | 'reviewScopeSnapshotId'
    > | undefined;
    if (includeRawFindingsSchema) {
      const reviewScopeSnapshotId = computeReviewScopeSnapshotId(params.getCwd());
      reviewerContext = {
        rawFindingsStructuredOutput: createRawFindingsStructuredOutput(reviewScopeSnapshotId),
        reviewScopeSnapshotId,
      };
    }
    return {
      ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
      reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
      hasOpenFindings: ledgerHasOpenFindings(ledger),
      hasWaivedFindings: ledgerHasWaivedFindings(ledger),
      hasDismissedFindings: ledgerHasDismissedFindings(ledger),
      ...reviewerContext,
    };
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
    getCurrentWorkflowStack,
    buildFindingContractInstructionContext,
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
    getWorkflowDescription: () => params.config.description,
    getWorkflowCallVars: () => params.options.workflowCallVars,
    getRetryNote: () => params.options.retryNote,
    getPrContext: () => params.options.prContext,
    getObservabilityRunId: () => params.options.observabilityRunId,
    observabilityEnabled: () => params.options.observability?.enabled === true,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack,
    structuredCaller: params.structuredCaller,
    structuredOutputNormalizers: params.options.structuredOutputNormalizers,
    findingContract: params.findingContract,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
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
    state: params.state as never,
    projectCwd: params.projectCwd,
    getCwd: params.getCwd,
    task: params.task,
    getOptions: () => params.options,
    sharedRuntime: params.sharedRuntime,
    progressLease: params.progressLease,
    resumeStackPrefix: [...params.resumeStackPrefix],
    runPaths: params.runPaths,
    setActiveResumePoint: params.setActiveResumePoint as never,
    setActiveResumeStack: params.setActiveResumeStack,
    adoptResumeCheckpoint: params.adoptResumeCheckpoint,
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
      workflowOwnerPathFromStack(params.resumeStackPrefix),
      params.options.workflowCallResolver,
      params.projectCwd,
      params.getCwd(),
      params.sharedRuntime.workflowCallInvocationEvidence!,
      params.sharedRuntime.workflowStepParticipationIndex!,
    ),
    getWorkflowReference: () => getWorkflowReference(params.config),
    ownerPath: workflowOwnerPathFromStack(params.resumeStackPrefix),
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
    getReportDir: () => params.runPaths.reportsAbs,
    dynamicParallelSelector,
    getWorkflowName: () => params.config.name,
    getInteractive: () => params.options.interactive === true,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack,
    refreshFindingsState: params.refreshFindingsState,
    emitEvent: params.emitEvent,
    findingContract: params.findingContract,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
    findingLedgerStore: params.findingLedgerStore,
    getWorkflowCallRunner: () => workflowCallRunner,
    setActiveResumePoint: params.setActiveResumePoint,
    setActiveResumeStack: params.setActiveResumeStack,
    adoptResumeCheckpoint: params.adoptResumeCheckpoint,
    getRunId: () => params.runPaths.slug,
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
    getCurrentWorkflowStack,
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
    getCurrentWorkflowStack,
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
    getStatusJudgmentContext: (step, state, lastResponse, executionScope, runtime) => optionsBuilder.buildPhaseRunnerContext(
      step,
      state,
      lastResponse,
      params.updatePersonaSession,
      {
        eventAttribution: { iteration: state.iteration, scope: executionScope },
        runtime,
        onPhaseStart: phaseRelay.onPhaseStart,
        onPhaseComplete: phaseRelay.onPhaseComplete,
        onJudgeStage: phaseRelay.onJudgeStage,
      },
    ),
    systemStepServicesFactory: params.options.systemStepServicesFactory,
  });

  const loopMonitorJudgeRunner = new LoopMonitorJudgeRunner({
    optionsBuilder,
    stepExecutor,
    state: params.state as never,
    task: params.task,
    stepBudget: params.stepBudget,
    recordCountableProgress: () => params.progressLease.recordCountableProgress(),
    interruptRequested: params.interruptRequested,
    ignoreIterationLimit: params.options.ignoreIterationLimit === true,
    requestIterationLimitExtension: params.options.onIterationLimit,
    setPendingLoopJudge: params.setPendingLoopJudge,
    startPendingLoopJudge: params.startPendingLoopJudge,
    clearPendingLoopJudge: params.clearPendingLoopJudge,
    syncMaxSteps: params.syncMaxSteps,
    getExecutionScope: () => snapshotWorkflowExecutionScope(params.getActiveResumePoint()?.stack),
    getLimitExecutionScope: params.buildStepExecutionScope,
    emitIterationLimit: (iteration, maxSteps, currentStep, scope) => {
      params.emitEvent('iteration:limit', iteration, maxSteps, currentStep, scope);
    },
    language: params.options.language,
    updatePersonaSession: params.updatePersonaSession,
    resolveNextStepFromDone: params.resolveNextStepFromDone as never,
    onStepStart: (step, iteration, instruction, providerInfo, resumeStepName, stepIteration, maxSteps, scope) => {
      params.emitEvent(
        'step:start',
        step,
        iteration,
        instruction,
        providerInfo,
        params.config.name,
        resumeStepName,
        stepIteration,
        maxSteps,
        scope,
      );
    },
    onStepComplete: (step, response, instruction, resumeStepName, scope) => {
      params.emitEvent('step:complete', step, response, instruction, resumeStepName, scope);
    },
    emitCollectedReports: (iteration, scope) => {
      for (const { step, filePath, fileName } of stepExecutor.drainReportFiles()) {
        params.emitEvent('step:report', step, filePath, fileName, iteration, scope);
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
