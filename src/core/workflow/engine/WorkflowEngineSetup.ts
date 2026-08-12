import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { prepareRuntimeEnvironment } from '../../runtime/runtime-environment.js';
import type { RunPaths } from '../run/run-paths.js';
import type {
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';
import { ArpeggioRunner } from './ArpeggioRunner.js';
import { LoopMonitorJudgeRunner } from './LoopMonitorJudgeRunner.js';
import { OptionsBuilder } from './OptionsBuilder.js';
import { ParallelRunner } from './ParallelRunner.js';
import { DynamicParallelSelectorCoordinator } from '../dynamic-parallel/selector-coordinator.js';
import { DynamicFacetSelectorCoordinator } from '../dynamic-facets/dynamicFacetSelectorCoordinator.js';
import { DynamicFacetSelectionStore } from '../dynamic-facets/dynamicFacetSelectionStore.js';
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
import { createTaskReviewScopeResolver } from '../review-scope.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
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
import { CompanionReviewAuthority } from '../companion/review-state-store.js';

const log = createLogger('workflow-engine');

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
  commitDynamicParallelSelection: (
    identity: string,
    selection: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ) => Promise<void>;
  commitDynamicFacetSelection: (
    identity: string,
    selection: import('../../models/types.js').DynamicFacetSelectionSnapshot,
  ) => Promise<void>;
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
    dynamicParallelSelectionStore: new DynamicParallelSelectionStore(new Map()),
    dynamicFacetSelectionStore: new DynamicFacetSelectionStore(new Map()),
    workflowCallInvocationEvidence: restoreWorkflowCallInvocationEvidence(resumePoint),
    workflowStepParticipationIndex: restoreWorkflowStepParticipationIndex(resumePoint),
    companionReviewAuthority: new CompanionReviewAuthority(),
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
  const phaseRelay = createWorkflowPhaseRelay(
    (event, ...args) => params.emitEvent(event, ...args),
    params.getCurrentWorkflowStack,
  );
  // base の解決は ref 走査を伴うため、ラン境界で一度だけ解決して保持する。
  const getReviewScope = createTaskReviewScopeResolver({
    getCwd: params.getCwd,
    getPrContext: () => params.options.prContext,
  });
  const failureDir = join(params.runPaths.runRootAbs, 'failures');

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
    () => params.task,
    getReviewScope,
    () => failureDir,
  );

  const dynamicFacetSelector = new DynamicFacetSelectorCoordinator({
    engineOptions: params.options,
    failureDir,
    selectionStore: params.sharedRuntime.dynamicFacetSelectionStore!,
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
      params.sharedRuntime.dynamicParallelSelectionStore!.snapshot(),
    ),
    getWorkflowReference: () => getWorkflowReference(params.config),
    workflowCallPath: params.resumeStackPrefix,
    commitSelection: params.commitDynamicFacetSelection,
    ...(params.options.selectorGitCommandRunner === undefined
      ? {}
      : { inputReader: new SelectorInputReader(params.options.selectorGitCommandRunner) }),
  });
  const companionReviewAuthority = params.sharedRuntime.companionReviewAuthority;
  if (companionReviewAuthority === undefined) {
    throw new Error('Companion review authority is missing from shared workflow runtime');
  }
  const companionEnabled = params.options.companionEnabled ?? true;

  const stepExecutor = new StepExecutor({
    optionsBuilder,
    getFailureDir: () => failureDir,
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
    getReviewScope,
    getObservabilityRunId: () => params.options.observabilityRunId,
    observabilityEnabled: () => params.options.observability?.enabled === true,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    structuredOutputNormalizers: params.options.structuredOutputNormalizers,
    abortSignal: params.options.abortSignal,
    executionProvider: params.options.provider,
    executionModel: params.options.model,
    internalAgentSeats: params.options.internalAgentSeats,
    emitEvent: params.emitEvent,
    recordSynthesizedAgentUsage: (stepName, providerInfo, success, usage) =>
      recordAgentUsageEvent(params.options, stepName, 'normal', providerInfo, success, usage),
    getRunId: () => params.runPaths.slug,
    getRunPathNamespace: () => params.options.runPathNamespace ?? [],
    companionEnabled,
    companionDefinitions: params.config.companions,
    companionProviders: params.options.companionProviders,
    companionSelectorProvider: params.options.selectorProvider,
    companionDiffReader: params.options.companionDiffReader,
    companionReviewAuthority,
    ...phaseRelay,
    getFacetPool: (name: string) => params.config.facetPools?.[name],
    dynamicFacetSelectorCoordinator: dynamicFacetSelector,
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
  });

  const dynamicParallelSelector = new DynamicParallelSelectorCoordinator({
    engineOptions: params.options,
    failureDir,
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
      params.sharedRuntime.dynamicParallelSelectionStore!.snapshot(),
    ),
    getWorkflowReference: () => getWorkflowReference(params.config),
    workflowCallPath: params.resumeStackPrefix,
    commitSelection: params.commitDynamicParallelSelection,
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
    emitEvent: params.emitEvent,
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
    internalAgentSeats: params.options.internalAgentSeats,
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
  dynamicParallelSelections: ReadonlyMap<string, import('../../models/types.js').DynamicParallelSelectionSnapshot>,
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
      workflowCallInvocations: snapshotWorkflowCallInvocationEvidence(
        workflowCallInvocationEvidence,
      ),
      workflowStepParticipations: workflowStepParticipationIndex.snapshot(),
      dynamicParallelSelections,
    })));
  const failures = results.flatMap((result) => result.failures);
  if (failures.length > 0) {
    throw new Error(
      `Unable to resolve dynamic selector report inputs: ${failures.map((failure) => failure.reason).join('; ')}`,
    );
  }
  return results.flatMap((result) => result.reportNames);
}
