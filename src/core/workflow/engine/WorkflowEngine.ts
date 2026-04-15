import { EventEmitter } from 'node:events';
import { CapabilityAwareStructuredCaller, type StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger, generateReportDir, isValidReportDirName } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { buildRunPaths, type RunPaths } from '../run/run-paths.js';
import type {
  WorkflowCallChildEngine,
  WorkflowEngineOptions,
  WorkflowRunResult,
  WorkflowSharedRuntimeState,
} from '../types.js';
import { LoopDetector } from './loop-detector.js';
import { createInitialState, addUserInput as addUserInputToState } from './state-manager.js';
import { CycleDetector } from './cycle-detector.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from './WorkflowRunLoop.js';
import { validateWorkflowConfig } from './WorkflowValidator.js';
import { getWorkflowStepKind } from '../step-kind.js';
import { buildWorkflowResumePointEntry } from '../workflow-reference.js';
import { WorkflowEngineStepCoordinator } from './WorkflowEngineStepCoordinator.js';
import {
  applyRuntimeEnvironment,
  assertTaskPrefixPair,
  createSharedRuntime,
  createWorkflowEngineServices,
  ensureRunDirsExist,
  type WorkflowEngineServices,
} from './WorkflowEngineSetup.js';
const log = createLogger('workflow-engine');
export type {
  WorkflowEvents,
  StepProviderInfo,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
} from '../types.js';
export { COMPLETE_STEP, ABORT_STEP } from '../constants.js';

const workflowRunExecutors = new WeakMap<WorkflowEngine, () => Promise<WorkflowRunResult>>();

function getWorkflowRunExecutor(engine: WorkflowEngine): () => Promise<WorkflowRunResult> {
  const executor = workflowRunExecutors.get(engine);
  if (!executor) {
    throw new Error('WorkflowEngine executor is not registered');
  }
  return executor;
}

export class WorkflowEngine extends EventEmitter {
  private state: WorkflowState;
  private config: WorkflowConfig;
  private projectCwd: string;
  private cwd: string;
  private task: string;
  private options: WorkflowEngineOptions;
  private maxSteps: number;
  private loopDetector: LoopDetector;
  private cycleDetector: CycleDetector;
  private reportDir: string;
  private runPaths: RunPaths;
  private abortRequested = false;
  private readonly sharedRuntime: WorkflowSharedRuntimeState;
  private readonly resumeStackPrefix: WorkflowResumePointEntry[];

  private readonly optionsBuilder: WorkflowEngineServices['optionsBuilder'];
  private readonly stepExecutor: WorkflowEngineServices['stepExecutor'];
  private readonly parallelRunner: WorkflowEngineServices['parallelRunner'];
  private readonly arpeggioRunner: WorkflowEngineServices['arpeggioRunner'];
  private readonly teamLeaderRunner: WorkflowEngineServices['teamLeaderRunner'];
  private readonly systemStepExecutor: WorkflowEngineServices['systemStepExecutor'];
  private readonly loopMonitorJudgeRunner: WorkflowEngineServices['loopMonitorJudgeRunner'];
  private readonly workflowCallRunner: WorkflowEngineServices['workflowCallRunner'];
  private readonly stepCoordinator: WorkflowEngineStepCoordinator;
  private readonly detectRuleIndex: (content: string, stepName: string) => number;
  private readonly structuredCaller: StructuredCaller;

  constructor(config: WorkflowConfig, cwd: string, task: string, options: WorkflowEngineOptions) {
    super();
    assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);
    this.config = config;
    this.projectCwd = options.projectCwd;
    this.cwd = cwd;
    this.task = task;
    this.options = options;
    this.loopDetector = new LoopDetector(config.loopDetection);
    this.cycleDetector = new CycleDetector(config.loopMonitors ?? []);
    if (options.reportDirName !== undefined && !isValidReportDirName(options.reportDirName)) {
      throw new Error(`Invalid reportDirName: ${options.reportDirName}`);
    }

    const reportDirName = options.reportDirName ?? generateReportDir(task);
    const initialMaxSteps = options.maxStepsOverride ?? config.maxSteps;
    this.sharedRuntime = options.sharedRuntime ?? createSharedRuntime(options.resumePoint, initialMaxSteps);
    this.sharedRuntime.maxSteps ??= initialMaxSteps;
    this.maxSteps = this.sharedRuntime.maxSteps;
    this.resumeStackPrefix = options.resumeStackPrefix ?? [];
    this.runPaths = buildRunPaths(this.cwd, reportDirName, options.runPathNamespace);
    this.reportDir = this.runPaths.reportsRel;
    ensureRunDirsExist(this.runPaths);
    applyRuntimeEnvironment(this.cwd, this.config, 'init');
    validateWorkflowConfig(this.config, this.options);

    this.state = createInitialState(config, options);
    this.detectRuleIndex = options.detectRuleIndex ?? (() => {
      throw new Error('detectRuleIndex is required for rule evaluation');
    });
    this.structuredCaller = options.structuredCaller ?? new CapabilityAwareStructuredCaller();
    this.options = {
      ...options,
      structuredCaller: this.structuredCaller,
    };
    const services = createWorkflowEngineServices({
      config: this.config,
      state: this.state,
      task: this.task,
      projectCwd: this.projectCwd,
      getCwd: () => this.cwd,
      getReportDir: () => this.reportDir,
      getRunPaths: () => this.runPaths,
      getMaxSteps: () => this.maxSteps,
      options: this.options,
      detectRuleIndex: this.detectRuleIndex,
      structuredCaller: this.structuredCaller,
      sharedRuntime: this.sharedRuntime,
      resumeStackPrefix: this.resumeStackPrefix,
      runPaths: this.runPaths,
      updateMaxSteps: (maxSteps) => {
        this.maxSteps = maxSteps;
        this.sharedRuntime.maxSteps = maxSteps;
      },
      setActiveResumePoint: this.setActiveResumePoint.bind(this),
      updatePersonaSession: this.updatePersonaSession.bind(this),
      resolveNextStepFromDone: this.resolveNextStepFromDone.bind(this),
      resetCycleDetector: () => this.cycleDetector.reset(),
      emitEvent: (event, ...args) => this.emit(event as never, ...args as []),
      createEngine: (nestedConfig, nestedCwd, nestedTask, nestedOptions): WorkflowCallChildEngine => {
        const nestedEngine = new WorkflowEngine(nestedConfig, nestedCwd, nestedTask, nestedOptions);
        return {
          on: nestedEngine.on.bind(nestedEngine),
          runWithResult: () => getWorkflowRunExecutor(nestedEngine)(),
        };
      },
    });
    this.optionsBuilder = services.optionsBuilder;
    this.stepExecutor = services.stepExecutor;
    this.parallelRunner = services.parallelRunner;
    this.arpeggioRunner = services.arpeggioRunner;
    this.teamLeaderRunner = services.teamLeaderRunner;
    this.systemStepExecutor = services.systemStepExecutor;
    this.loopMonitorJudgeRunner = services.loopMonitorJudgeRunner;
    this.workflowCallRunner = services.workflowCallRunner;
    this.stepCoordinator = new WorkflowEngineStepCoordinator({
      config: this.config,
      state: this.state,
      task: this.task,
      getMaxSteps: () => this.maxSteps,
      getOptions: () => this.options,
      stepExecutor: this.stepExecutor,
      parallelRunner: this.parallelRunner,
      arpeggioRunner: this.arpeggioRunner,
      teamLeaderRunner: this.teamLeaderRunner,
      systemStepExecutor: this.systemStepExecutor,
      loopMonitorJudgeRunner: this.loopMonitorJudgeRunner,
      workflowCallRunner: this.workflowCallRunner,
      updatePersonaSession: this.updatePersonaSession.bind(this),
      emitReport: (step, filePath, fileName) => this.emit('step:report', step, filePath, fileName),
    });
    workflowRunExecutors.set(this, () => runWorkflowToCompletion({
      state: this.state,
      options: this.options,
      getMaxSteps: () => this.maxSteps,
      abortRequested: () => this.abortRequested,
      getStep: this.stepCoordinator.getStep.bind(this.stepCoordinator),
      applyRuntimeEnvironment: (stage) => applyRuntimeEnvironment(this.cwd, this.config, stage),
      loopDetectorCheck: (stepName) => {
        const result = this.loopDetector.check(stepName);
        return {
          shouldWarn: result.shouldWarn ?? false,
          shouldAbort: result.shouldAbort ?? false,
          count: result.count,
          isLoop: result.isLoop,
        };
      },
      cycleDetectorRecordAndCheck: (stepName) => this.cycleDetector.recordAndCheck(stepName),
      resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
      runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
      runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
      buildInstruction: this.stepCoordinator.buildInstruction.bind(this.stepCoordinator),
      buildPhase1Instruction: this.stepCoordinator.buildPhase1Instruction.bind(this.stepCoordinator),
      resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
      resolveRuntimeForStep: this.stepCoordinator.resolveRuntimeForStep.bind(this.stepCoordinator),
      setActiveStep: this.setActiveResumePoint.bind(this),
      addUserInput: this.addUserInput.bind(this),
      emit: (event, ...args) => this.emit(event as never, ...args as []),
      updateMaxSteps: (maxSteps) => {
        this.maxSteps = maxSteps;
        this.sharedRuntime.maxSteps = maxSteps;
      },
    }));

    log.debug('WorkflowEngine initialized', {
      workflow: config.name,
      steps: config.steps.map((step) => step.name),
      initialStep: config.initialStep,
      maxSteps: config.maxSteps,
      effectiveMaxSteps: this.maxSteps,
    });
  }

  getState(): WorkflowState {
    return { ...this.state };
  }

  private buildResumePoint(step: WorkflowStep, iteration: number): WorkflowResumePoint {
    return {
      version: 1,
      stack: [...this.resumeStackPrefix, buildWorkflowResumePointEntry(this.config, step.name, getWorkflowStepKind(step))],
      iteration,
      elapsed_ms: Date.now() - this.sharedRuntime.startedAtMs,
    };
  }

  private setActiveResumePoint(step: WorkflowStep, iteration: number): void {
    this.sharedRuntime.activeResumePoint = this.buildResumePoint(step, iteration);
  }

  getResumePoint(): WorkflowResumePoint | undefined {
    return this.sharedRuntime.activeResumePoint;
  }

  buildResumePointForStepName(stepName: string): WorkflowResumePoint | undefined {
    const step = this.config.steps.find((candidate) => candidate.name === stepName);
    return step ? this.buildResumePoint(step, this.state.iteration) : undefined;
  }

  addUserInput(input: string): void {
    addUserInputToState(this.state, input);
  }

  updateCwd(newCwd: string): void { this.cwd = newCwd; }
  getCwd(): string { return this.cwd; }
  getProjectCwd(): string { return this.projectCwd; }

  abort(): void {
    if (this.abortRequested) return;
    this.abortRequested = true;
    log.info('Abort requested');
  }

  isAbortRequested(): boolean { return this.abortRequested; }

  private updatePersonaSession(persona: string, sessionId: string | undefined): void {
    if (!sessionId) return;
    const previousSessionId = this.state.personaSessions.get(persona);
    this.state.personaSessions.set(persona, sessionId);
    if (this.options.onSessionUpdate && sessionId !== previousSessionId) {
      this.options.onSessionUpdate(persona, sessionId);
    }
  }

  private resolveNextStepFromDone(step: WorkflowStep, response: AgentResponse): string {
    return this.stepCoordinator.resolveNextStepFromDone(step, response);
  }

  async run(): Promise<WorkflowState> {
    const result = await getWorkflowRunExecutor(this)();
    return result.state;
  }

  async runSingleIteration(): Promise<{
    response: AgentResponse;
    nextStep: string;
    isComplete: boolean;
    loopDetected?: boolean;
  }> {
    return runSingleWorkflowIteration({
      state: this.state,
      options: this.options,
      getMaxSteps: () => this.maxSteps,
      abortRequested: () => this.abortRequested,
      getStep: this.stepCoordinator.getStep.bind(this.stepCoordinator),
      applyRuntimeEnvironment: (stage) => applyRuntimeEnvironment(this.cwd, this.config, stage),
      loopDetectorCheck: (stepName) => {
        const result = this.loopDetector.check(stepName);
        return {
          shouldWarn: result.shouldWarn ?? false,
          shouldAbort: result.shouldAbort ?? false,
          count: result.count,
          isLoop: result.isLoop,
        };
      },
      cycleDetectorRecordAndCheck: (stepName) => this.cycleDetector.recordAndCheck(stepName),
      resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
      runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
      runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
      buildInstruction: this.stepCoordinator.buildInstruction.bind(this.stepCoordinator),
      buildPhase1Instruction: this.stepCoordinator.buildPhase1Instruction.bind(this.stepCoordinator),
      resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
      resolveRuntimeForStep: this.stepCoordinator.resolveRuntimeForStep.bind(this.stepCoordinator),
      setActiveStep: this.setActiveResumePoint.bind(this),
      addUserInput: this.addUserInput.bind(this),
      emit: (event, ...args) => this.emit(event as never, ...args as []),
      updateMaxSteps: () => {},
    });
  }
}
