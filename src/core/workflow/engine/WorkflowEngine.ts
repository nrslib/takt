/**
 * Workflow execution engine.
 *
 * Orchestrates the main execution loop: step transitions, abort handling,
 * loop detection, and iteration limits. Delegates step execution to
 * StepExecutor (normal steps) and ParallelRunner (parallel steps).
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { DefaultStructuredCaller, type StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger, generateReportDir, isValidReportDirName } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { prepareRuntimeEnvironment } from '../../runtime/runtime-environment.js';
import { buildRunPaths, type RunPaths } from '../run/run-paths.js';
import type { RuntimeStepResolution, WorkflowEngineOptions } from '../types.js';
import { ArpeggioRunner } from './ArpeggioRunner.js';
import { LoopMonitorJudgeRunner } from './LoopMonitorJudgeRunner.js';
import { LoopDetector } from './loop-detector.js';
import { OptionsBuilder } from './OptionsBuilder.js';
import { ParallelRunner } from './ParallelRunner.js';
import { createInitialState, addUserInput as addUserInputToState } from './state-manager.js';
import { StepExecutor } from './StepExecutor.js';
import { TeamLeaderRunner } from './TeamLeaderRunner.js';
import { determineNextStepByRules } from './transitions.js';
import { CycleDetector } from './cycle-detector.js';
import { createWorkflowPhaseRelay } from './WorkflowEnginePhaseRelay.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from './WorkflowRunLoop.js';
import { validateWorkflowConfig } from './WorkflowValidator.js';

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

export class WorkflowEngine extends EventEmitter {
  private state: WorkflowState;
  private config: WorkflowConfig;
  private projectCwd: string;
  private cwd: string;
  private task: string;
  private options: WorkflowEngineOptions;
  private loopDetector: LoopDetector;
  private cycleDetector: CycleDetector;
  private reportDir: string;
  private runPaths: RunPaths;
  private abortRequested = false;

  private readonly optionsBuilder: OptionsBuilder;
  private readonly stepExecutor: StepExecutor;
  private readonly parallelRunner: ParallelRunner;
  private readonly arpeggioRunner: ArpeggioRunner;
  private readonly teamLeaderRunner: TeamLeaderRunner;
  private readonly loopMonitorJudgeRunner: LoopMonitorJudgeRunner;
  private readonly detectRuleIndex: (content: string, stepName: string) => number;
  private readonly structuredCaller: StructuredCaller;

  constructor(config: WorkflowConfig, cwd: string, task: string, options: WorkflowEngineOptions) {
    super();
    this.assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);
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
    this.runPaths = buildRunPaths(this.cwd, reportDirName);
    this.reportDir = this.runPaths.reportsRel;
    this.ensureRunDirsExist();
    this.applyRuntimeEnvironment('init');
    validateWorkflowConfig(this.config, this.options);

    this.state = createInitialState(config, options);
    this.detectRuleIndex = options.detectRuleIndex ?? (() => {
      throw new Error('detectRuleIndex is required for rule evaluation');
    });
    this.structuredCaller = options.structuredCaller ?? new DefaultStructuredCaller();
    this.options = {
      ...options,
      structuredCaller: this.structuredCaller,
    };

    const phaseRelay = createWorkflowPhaseRelay((event, ...args) => this.emit(event as never, ...args as []));

    this.optionsBuilder = new OptionsBuilder(
      this.options,
      () => this.cwd,
      () => this.projectCwd,
      (persona) => this.state.personaSessions.get(persona),
      () => this.reportDir,
      () => this.options.language,
      () => this.config.steps.map((step) => ({ name: step.name, description: step.description })),
      () => this.config.name,
      () => this.config.description,
    );

    this.stepExecutor = new StepExecutor({
      optionsBuilder: this.optionsBuilder,
      getCwd: () => this.cwd,
      getProjectCwd: () => this.projectCwd,
      getReportDir: () => this.reportDir,
      getRunPaths: () => this.runPaths,
      getLanguage: () => this.options.language,
      getInteractive: () => this.options.interactive === true,
      getWorkflowSteps: () => this.config.steps.map((step) => ({ name: step.name, description: step.description })),
      getWorkflowName: () => this.config.name,
      getWorkflowDescription: () => this.config.description,
      getRetryNote: () => this.options.retryNote,
      detectRuleIndex: this.detectRuleIndex,
      structuredCaller: this.structuredCaller,
      ...phaseRelay,
    });

    this.parallelRunner = new ParallelRunner({
      optionsBuilder: this.optionsBuilder,
      stepExecutor: this.stepExecutor,
      engineOptions: this.options,
      getCwd: () => this.cwd,
      getReportDir: () => this.reportDir,
      getInteractive: () => this.options.interactive === true,
      detectRuleIndex: this.detectRuleIndex,
      structuredCaller: this.structuredCaller,
      ...phaseRelay,
    });

    this.arpeggioRunner = new ArpeggioRunner({
      optionsBuilder: this.optionsBuilder,
      stepExecutor: this.stepExecutor,
      getCwd: () => this.cwd,
      getInteractive: () => this.options.interactive === true,
      detectRuleIndex: this.detectRuleIndex,
      structuredCaller: this.structuredCaller,
      onPhaseStart: phaseRelay.onPhaseStart,
      onPhaseComplete: phaseRelay.onPhaseComplete,
    });

    this.teamLeaderRunner = new TeamLeaderRunner({
      optionsBuilder: this.optionsBuilder,
      stepExecutor: this.stepExecutor,
      engineOptions: this.options,
      getCwd: () => this.cwd,
      getInteractive: () => this.options.interactive === true,
      onPhaseStart: phaseRelay.onPhaseStart,
      onPhaseComplete: phaseRelay.onPhaseComplete,
    });

    this.loopMonitorJudgeRunner = new LoopMonitorJudgeRunner({
      optionsBuilder: this.optionsBuilder,
      stepExecutor: this.stepExecutor,
      state: this.state,
      task: this.task,
      maxSteps: this.config.maxSteps,
      language: this.options.language,
      updatePersonaSession: this.updatePersonaSession.bind(this),
      resolveNextStepFromDone: this.resolveNextStepFromDone.bind(this),
      onStepStart: (step, iteration, instruction) => {
        this.emit('step:start', step, iteration, instruction, this.optionsBuilder.resolveStepProviderModel(step));
      },
      onStepComplete: (step, response, instruction) => {
        this.emit('step:complete', step, response, instruction);
      },
      emitCollectedReports: this.emitCollectedReports.bind(this),
      resetCycleDetector: () => this.cycleDetector.reset(),
    });

    log.debug('WorkflowEngine initialized', {
      workflow: config.name,
      steps: config.steps.map((step) => step.name),
      initialStep: config.initialStep,
      maxSteps: config.maxSteps,
    });
  }

  private assertTaskPrefixPair(taskPrefix: string | undefined, taskColorIndex: number | undefined): void {
    const hasTaskPrefix = taskPrefix != null;
    const hasTaskColorIndex = taskColorIndex != null;
    if (hasTaskPrefix !== hasTaskColorIndex) {
      throw new Error('taskPrefix and taskColorIndex must be provided together');
    }
  }

  private ensureRunDirsExist(): void {
    for (const dir of [
      this.runPaths.runRootAbs,
      this.runPaths.reportsAbs,
      this.runPaths.contextAbs,
      this.runPaths.contextKnowledgeAbs,
      this.runPaths.contextPolicyAbs,
      this.runPaths.contextPreviousResponsesAbs,
      this.runPaths.logsAbs,
    ]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  private applyRuntimeEnvironment(stage: 'init' | 'step'): void {
    const prepared = prepareRuntimeEnvironment(this.cwd, this.config.runtime);
    if (!prepared) return;
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

  getState(): WorkflowState {
    return { ...this.state };
  }

  addUserInput(input: string): void {
    addUserInputToState(this.state, input);
  }

  updateCwd(newCwd: string): void {
    this.cwd = newCwd;
  }

  getCwd(): string {
    return this.cwd;
  }

  getProjectCwd(): string {
    return this.projectCwd;
  }

  abort(): void {
    if (this.abortRequested) return;
    this.abortRequested = true;
    log.info('Abort requested');
  }

  isAbortRequested(): boolean {
    return this.abortRequested;
  }

  private getStep(name: string): WorkflowStep {
    const step = this.config.steps.find((candidate) => candidate.name === name);
    if (!step) {
      throw new Error(`Unknown step: ${name}`);
    }
    return step;
  }

  private updatePersonaSession(persona: string, sessionId: string | undefined): void {
    if (!sessionId) return;
    const previousSessionId = this.state.personaSessions.get(persona);
    this.state.personaSessions.set(persona, sessionId);
    if (this.options.onSessionUpdate && sessionId !== previousSessionId) {
      this.options.onSessionUpdate(persona, sessionId);
    }
  }

  private emitCollectedReports(): void {
    for (const { step, filePath, fileName } of this.stepExecutor.drainReportFiles()) {
      this.emit('step:report', step, filePath, fileName);
    }
  }

  private async runStep(step: WorkflowStep, prebuiltInstruction?: string): Promise<{ response: AgentResponse; instruction: string }> {
    const updateSession = this.updatePersonaSession.bind(this);
    let result: { response: AgentResponse; instruction: string };

    if (step.parallel && step.parallel.length > 0) {
      result = await this.parallelRunner.runParallelStep(step, this.state, this.task, this.config.maxSteps, updateSession);
    } else if (step.arpeggio) {
      result = await this.arpeggioRunner.runArpeggioStep(step, this.state);
    } else if (step.teamLeader) {
      result = await this.teamLeaderRunner.runTeamLeaderStep(step, this.state, this.task, this.config.maxSteps, updateSession);
    } else {
      result = await this.stepExecutor.runNormalStep(
        step,
        this.state,
        this.task,
        this.config.maxSteps,
        updateSession,
        prebuiltInstruction,
      );
    }

    this.emitCollectedReports();
    return result;
  }

  private resolveNextStep(step: WorkflowStep, response: AgentResponse): string {
    if (response.matchedRuleIndex != null && step.rules) {
      const nextByRules = determineNextStepByRules(step, response.matchedRuleIndex);
      if (nextByRules) {
        return nextByRules;
      }
    }
    throw new Error(`No matching rule found for step "${step.name}" (status: ${response.status})`);
  }

  private resolveNextStepFromDone(step: WorkflowStep, response: AgentResponse): string {
    if (response.status !== 'done') {
      throw new Error(`Unhandled response status: ${response.status}`);
    }
    return this.resolveNextStep(step, response);
  }

  buildInstruction(step: WorkflowStep, stepIteration: number): string {
    return this.stepExecutor.buildInstruction(step, stepIteration, this.state, this.task, this.config.maxSteps);
  }

  private async runLoopMonitorJudge(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime?: RuntimeStepResolution,
  ): Promise<string> {
    return this.loopMonitorJudgeRunner.run(monitor, cycleCount, triggeringStep, triggeringRuntime);
  }

  async run(): Promise<WorkflowState> {
    return runWorkflowToCompletion({
      state: this.state,
      options: this.options,
      getMaxSteps: () => this.config.maxSteps,
      abortRequested: () => this.abortRequested,
      getStep: this.getStep.bind(this),
      applyRuntimeEnvironment: this.applyRuntimeEnvironment.bind(this),
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
      resolveNextStepFromDone: this.resolveNextStepFromDone.bind(this),
      runLoopMonitorJudge: this.runLoopMonitorJudge.bind(this),
      runStep: this.runStep.bind(this),
      buildInstruction: this.buildInstruction.bind(this),
      resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
      addUserInput: this.addUserInput.bind(this),
      emit: (event, ...args) => this.emit(event as never, ...args as []),
      updateMaxSteps: (maxSteps) => {
        this.config = { ...this.config, maxSteps };
      },
    });
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
      getMaxSteps: () => this.config.maxSteps,
      abortRequested: () => this.abortRequested,
      getStep: this.getStep.bind(this),
      applyRuntimeEnvironment: this.applyRuntimeEnvironment.bind(this),
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
      resolveNextStepFromDone: this.resolveNextStepFromDone.bind(this),
      runLoopMonitorJudge: this.runLoopMonitorJudge.bind(this),
      runStep: this.runStep.bind(this),
      buildInstruction: this.buildInstruction.bind(this),
      resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
      addUserInput: this.addUserInput.bind(this),
      emit: (event, ...args) => this.emit(event as never, ...args as []),
      updateMaxSteps: () => {},
    });
  }
}
