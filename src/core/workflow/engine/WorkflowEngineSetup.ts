import { existsSync, mkdirSync } from 'node:fs';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
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
import { StepExecutor } from './StepExecutor.js';
import { SystemStepExecutor } from './SystemStepExecutor.js';
import { TeamLeaderRunner } from './TeamLeaderRunner.js';
import { createWorkflowPhaseRelay } from './WorkflowEnginePhaseRelay.js';
import { WorkflowCallRunner } from './WorkflowCallRunner.js';
import type { WorkflowCallChildEngine } from '../types.js';

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
  options: WorkflowEngineOptions;
  detectRuleIndex: (content: string, stepName: string) => number;
  structuredCaller: StructuredCaller;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: WorkflowEngineOptions['resumeStackPrefix'];
  runPaths: RunPaths;
  updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  setActiveResumePoint: (step: WorkflowStep, iteration: number) => void;
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
  const phaseRelay = createWorkflowPhaseRelay((event, ...args) => params.emitEvent(event, ...args));

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
    getRetryNote: () => params.options.retryNote,
    detectRuleIndex: params.detectRuleIndex,
    structuredCaller: params.structuredCaller,
    ...phaseRelay,
  });

  const parallelRunner = new ParallelRunner({
    optionsBuilder,
    stepExecutor,
    engineOptions: params.options,
    getCwd: params.getCwd,
    getReportDir: params.getReportDir,
    getInteractive: () => params.options.interactive === true,
    detectRuleIndex: params.detectRuleIndex,
    structuredCaller: params.structuredCaller,
    ...phaseRelay,
  });

  const arpeggioRunner = new ArpeggioRunner({
    optionsBuilder,
    stepExecutor,
    getCwd: params.getCwd,
    getInteractive: () => params.options.interactive === true,
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
    getInteractive: () => params.options.interactive === true,
    onPhaseStart: phaseRelay.onPhaseStart,
    onPhaseComplete: phaseRelay.onPhaseComplete,
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
    onStepStart: (step, iteration, instruction) => {
      params.emitEvent('step:start', step, iteration, instruction, optionsBuilder.resolveStepProviderModel(step));
    },
    onStepComplete: (step, response, instruction) => {
      params.emitEvent('step:complete', step, response, instruction);
    },
    emitCollectedReports: () => {
      for (const { step, filePath, fileName } of stepExecutor.drainReportFiles()) {
        params.emitEvent('step:report', step, filePath, fileName);
      }
    },
    resetCycleDetector: params.resetCycleDetector,
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
