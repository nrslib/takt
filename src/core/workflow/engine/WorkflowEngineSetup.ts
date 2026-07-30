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
import type { FindingManagerAuthority } from '../../models/finding-types.js';
import { prepareRuntimeEnvironment } from '../../runtime/runtime-environment.js';
import type { RunPaths } from '../run/run-paths.js';
import type { WorkflowEngineOptions, WorkflowSharedRuntimeState } from '../types.js';
import { ArpeggioRunner } from './ArpeggioRunner.js';
import { LoopMonitorJudgeRunner } from './LoopMonitorJudgeRunner.js';
import { OptionsBuilder } from './OptionsBuilder.js';
import { ParallelRunner } from './ParallelRunner.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import { StepExecutor } from './StepExecutor.js';
import { SystemStepExecutor } from './SystemStepExecutor.js';
import { TeamLeaderRunner } from './TeamLeaderRunner.js';
import { createWorkflowPhaseRelay } from './WorkflowEnginePhaseRelay.js';
import { WorkflowCallRunner } from './WorkflowCallRunner.js';
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
import type {
  FindingContractInstructionContext,
  FindingContractReviewerOutputStrategy,
} from '../instruction/instruction-context.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
import {
  resolveFindingContractReviewerOutputStrategy,
} from '../findings/reviewer-output-strategy.js';

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
  resumeStackPrefix: WorkflowEngineOptions['resumeStackPrefix'];
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
  ) => void;
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
  const reviewerOutputStrategy = resolveFindingContractReviewerOutputStrategy(
    params.findingContract,
  );
  const buildFindingContractInstructionContext = (
    _step: WorkflowStep,
    strategy: FindingContractReviewerOutputStrategy | undefined,
  ): FindingContractInstructionContext | undefined => {
    if (!params.findingContract) {
      return undefined;
    }
    if (!params.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }

    const ledger = params.findingLedgerStore.loadLedger();
    let reviewer: FindingContractInstructionContext['reviewer'];
    if (strategy !== undefined) {
      const reviewScopeSnapshotId = computeReviewScopeSnapshotId(params.getCwd());
      reviewer = strategy.kind === 'structured'
        ? {
            mode: 'structured',
            rawFindingsStructuredOutput: createRawFindingsStructuredOutput(),
            reviewScopeSnapshotId,
          }
        : { mode: 'canonical_blocks', reviewScopeSnapshotId };
    }
    return {
      ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
      reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
      hasOpenFindings: ledgerHasOpenFindings(ledger),
      hasWaivedFindings: ledgerHasWaivedFindings(ledger),
      hasDismissedFindings: ledgerHasDismissedFindings(ledger),
      ...(reviewer !== undefined ? { reviewer } : {}),
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
    params.getCurrentWorkflowStack,
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
    getTask: () => params.task,
    getWorkflowDescription: () => params.config.description,
    getRetryNote: () => params.options.retryNote,
    getPrContext: () => params.options.prContext,
    getObservabilityRunId: () => params.options.observabilityRunId,
    observabilityEnabled: () => params.options.observability?.enabled === true,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    structuredOutputNormalizers: params.options.structuredOutputNormalizers,
    reviewerOutputStrategy,
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
    resumeStackPrefix: params.resumeStackPrefix ?? [],
    consumeWorkflowCallContinuation: params.consumeWorkflowCallContinuation,
    runPaths: params.runPaths,
    setActiveResumePoint: params.setActiveResumePoint as never,
    emit: params.emitEvent,
    resolveWorkflowCall: (request) => params.options.workflowCallResolver!(request),
    createEngine: params.createEngine,
    findingContract: params.findingContract,
    findingLedgerStore: params.findingLedgerStore,
    refreshFindingsState: params.refreshFindingsState,
  });

  const parallelRunner = new ParallelRunner({
    optionsBuilder,
    stepExecutor,
    engineOptions: params.options,
    getCwd: params.getCwd,
    getReportDir: params.getReportDir,
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
    reviewerOutputStrategy,
    findingManagerAuthority: params.findingManagerAuthority,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
    findingLedgerStore: params.findingLedgerStore,
    getWorkflowCallRunner: () => workflowCallRunner,
    claimStepOccurrence: params.claimStepOccurrence,
    updateMaxSteps: params.updateMaxSteps,
    setActiveResumePoint: params.setActiveResumePoint,
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
