import { existsSync, mkdirSync } from 'node:fs';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowResumePoint,
  WorkflowStep,
} from '../../models/types.js';
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
import { RawFindingsStructuredOutput } from '../findings/manager-runner.js';
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

const log = createLogger('workflow-engine');

interface WorkflowEngineSetupParams {
  config: WorkflowConfig;
  state: {
    personaSessions: Map<string, string>;
  };
  task: string;
  projectCwd: string;
  getCwd: () => string;
  getReportDir: () => string;
  getRunPaths: () => RunPaths;
  getMaxSteps: () => WorkflowMaxSteps;
  options: WorkflowEngineOptions & { structuredOutputNormalizers: StructuredOutputNormalizerRegistry };
  detectRuleIndex: (content: string, stepName: string) => number;
  structuredCaller: StructuredCaller;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: WorkflowEngineOptions['resumeStackPrefix'];
  runPaths: RunPaths;
  updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  setActiveResumePoint: (step: WorkflowStep, iteration: number) => void;
  refreshFindingsState: () => void;
  /** 自前 or workflow_call 親から継承した、この engine で有効な Finding Contract。 */
  findingContract?: FindingContractConfig;
  findingLedgerStore?: FindingLedgerStore;
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  resolveNextStepFromDone: (step: WorkflowStep, response: AgentResponse) => string;
  resetCycleDetector: () => void;
  getInheritedPeerReportPaths: (step: WorkflowStep) => readonly string[];
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
  const phaseRelay = createWorkflowPhaseRelay((event, ...args) => params.emitEvent(event, ...args));
  const getCurrentWorkflowStack = () => params.sharedRuntime.activeResumePoint?.stack;
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
    return {
      ledgerCopyPath: params.findingLedgerStore.createRunCopy(),
      ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
      reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
      hasOpenFindings: ledgerHasOpenFindings(ledger),
      hasWaivedFindings: ledgerHasWaivedFindings(ledger),
      hasDismissedFindings: ledgerHasDismissedFindings(ledger),
      ...(includeRawFindingsSchema
        ? {
            rawFindingsJsonSchema: RawFindingsStructuredOutput.schema,
            // review-integrity protocol: このラウンドの reviewer 全員へ同じ snapshot id を
            // 配る。manager-runner.ts の runFindingManagerForStep が同じ cwd に
            // 対して同じ関数をもう一度呼び、reviewer 呼び出しと検証呼び出しの
            // 間に書き込みが起きない通常経路では同じ値になる（値の一致で
            // 「reviewer が見た版のまま」を確認する — snapshot.ts 参照）。
            reviewScopeSnapshotId: computeReviewScopeSnapshotId(params.getCwd()),
          }
        : {}),
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
    getWorkflowDefinitionSteps: () => params.config.steps,
    getWorkflowName: () => params.config.name,
    getWorkflowDescription: () => params.config.description,
    getInheritedPeerReportPaths: params.getInheritedPeerReportPaths,
    getRetryNote: () => params.options.retryNote,
    getObservabilityRunId: () => params.options.observabilityRunId,
    observabilityEnabled: () => params.options.observability?.enabled === true,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack,
    detectRuleIndex: params.detectRuleIndex,
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
    getMaxSteps: params.getMaxSteps,
    updateMaxSteps: params.updateMaxSteps,
    state: params.state as never,
    projectCwd: params.projectCwd,
    getCwd: params.getCwd,
    task: params.task,
    getOptions: () => params.options,
    sharedRuntime: params.sharedRuntime,
    resumeStackPrefix: params.resumeStackPrefix ?? [],
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
    getInteractive: () => params.options.interactive === true,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack,
    detectRuleIndex: params.detectRuleIndex,
    structuredCaller: params.structuredCaller,
    refreshFindingsState: params.refreshFindingsState,
    emitEvent: params.emitEvent,
    findingContract: params.findingContract,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
    findingLedgerStore: params.findingLedgerStore,
    getWorkflowCallRunner: () => workflowCallRunner,
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
    getCurrentWorkflowStack,
    detectRuleIndex: params.detectRuleIndex,
    structuredCaller: params.structuredCaller,
    onPhaseStart: phaseRelay.onPhaseStart,
    onPhaseComplete: phaseRelay.onPhaseComplete,
  });

  const teamLeaderRunner = new TeamLeaderRunner({
    optionsBuilder,
    stepExecutor,
    engineOptions: params.options,
    getCwd: params.getCwd,
    getWorkflowName: () => params.config.name,
    getInteractive: () => params.options.interactive === true,
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
    getRuleContext: (step) => {
      const providerInfo = optionsBuilder.resolveStepProviderModel(step);
      return {
        cwd: params.getCwd(),
          provider: step.provider ?? params.options.provider,
          resolvedProvider: providerInfo.provider,
          resolvedModel: providerInfo.model,
          childProcessEnv: params.options.childProcessEnv,
          interactive: params.options.interactive === true,
          detectRuleIndex: params.detectRuleIndex,
          structuredCaller: params.structuredCaller,
        };
      },
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
    onStepStart: (step, iteration, instruction, providerInfo, resumeStepName) => {
      params.emitEvent(
        'step:start',
        step,
        iteration,
        instruction,
        providerInfo,
        params.config.name,
        resumeStepName,
      );
    },
    onStepComplete: (step, response, instruction, resumeStepName) => {
      params.emitEvent('step:complete', step, response, instruction, resumeStepName);
    },
    emitCollectedReports: () => {
      for (const { step, filePath, fileName } of stepExecutor.drainReportFiles()) {
        params.emitEvent('step:report', step, filePath, fileName);
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
