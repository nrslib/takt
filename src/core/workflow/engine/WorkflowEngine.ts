import { EventEmitter } from 'node:events';
import { CapabilityAwareStructuredCaller, type StructuredCaller } from '../../../agents/structured-caller.js';
import { createAutoRoutingAiRouter } from '../../../agents/auto-routing-usecase.js';
import { createLogger, generateReportDir, getErrorMessage, isValidReportDirName } from '../../../shared/utils/index.js';
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
import { buildRunPaths, type RunPaths } from '../run/run-paths.js';
import type {
  WorkflowCallChildEngine,
  WorkflowAbortKind,
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
import { applyAutoRoutingStrategyOverride } from '../auto-routing/resolver.js';
import { buildWorkflowResumePointEntry } from '../workflow-reference.js';
import { runWithWorkflowSpan, type WorkflowSpanOutcome, type WorkflowSpanParams } from '../observability/workflowSpans.js';
import { WorkflowEngineStepCoordinator } from './WorkflowEngineStepCoordinator.js';
import {
  applyRuntimeEnvironment,
  assertTaskPrefixPair,
  createSharedRuntime,
  createWorkflowEngineServices,
  ensureRunDirsExist,
  type WorkflowEngineServices,
} from './WorkflowEngineSetup.js';
import {
  createStructuredOutputNormalizerRegistry,
  type StructuredOutputNormalizerRegistry,
} from './structured-output-normalizer.js';
import { runQualityGates } from '../quality-gates/qualityGateRunner.js';
import { buildFindingsRuleContext } from '../findings/context.js';
import { createFindingLedgerStore, type FindingLedgerStore } from '../findings/store.js';
import { injectFindingConflictAdjudicationStep } from '../findings/adjudication-step.js';
import { createFindingConflictAdjudicationRunner } from '../findings/adjudication-runner.js';
import { ERROR_MESSAGES } from '../constants.js';
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
  private options: WorkflowEngineOptions & { structuredOutputNormalizers: StructuredOutputNormalizerRegistry };
  private maxSteps: WorkflowMaxSteps;
  private loopDetector: LoopDetector;
  private cycleDetector: CycleDetector;
  private reportDir: string;
  private runPaths: RunPaths;
  private abortRequested = false;
  private readonly sharedRuntime: WorkflowSharedRuntimeState;
  private readonly resumeStackPrefix: WorkflowResumePointEntry[];
  private readonly findingLedgerStore?: FindingLedgerStore;
  private readonly findingContract?: FindingContractConfig;

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
    this.structuredCaller = options.structuredCaller ?? new CapabilityAwareStructuredCaller();
    if (options.reportDirName !== undefined && !isValidReportDirName(options.reportDirName)) {
      throw new Error(`Invalid reportDirName: ${options.reportDirName}`);
    }

    const reportDirName = options.reportDirName ?? generateReportDir(task);
    const runPaths = buildRunPaths(cwd, reportDirName, options.runPathNamespace);
    const traceTaskMetadata = {
      ...options.traceTaskMetadata,
      runDir: runPaths.runRootAbs,
    };
    const autoRoutingAiRouter = options.autoRoutingAiRouter ?? createAutoRoutingAiRouter({
      cwd,
      workflowName: config.name,
      runId: runPaths.slug,
      language: options.language,
      childProcessEnv: options.childProcessEnv,
      onStream: options.onStream,
    });
    const effectiveAutoRouting = applyAutoRoutingStrategyOverride(
      config.autoRouting ?? options.autoRouting,
      options.autoStrategyOverride,
    );
    // Phase B (codex B4): the finding-conflict-adjudication step is a REAL
    // synthesized step injected into config.steps whenever the workflow (or a
    // loop monitor judge) wires a rule to it and a finding contract is in
    // effect. Injection happens before validateWorkflowConfig so the injected
    // step is validated exactly like an authored step (session, provider,
    // model), and before any service captures config.steps.
    this.config = injectFindingConflictAdjudicationStep(
      config,
      options.inheritedFindingContract?.contract ?? config.findingContract,
    );
    this.options = {
      ...options,
      rateLimitFallback: config.rateLimitFallback ?? options.rateLimitFallback,
      structuredCaller: this.structuredCaller,
      structuredOutputNormalizers: options.structuredOutputNormalizers ?? createStructuredOutputNormalizerRegistry([]),
      autoRouting: effectiveAutoRouting,
      autoRoutingAiRouter,
      traceTaskMetadata,
    };
    this.projectCwd = this.options.projectCwd;
    this.cwd = cwd;
    this.task = task;
    this.loopDetector = new LoopDetector(this.config.loopDetection);
    this.cycleDetector = new CycleDetector(this.config.loopMonitors ?? []);
    const initialMaxSteps = this.options.maxStepsOverride ?? this.config.maxSteps;
    this.sharedRuntime = this.options.sharedRuntime ?? createSharedRuntime(this.options.resumePoint, initialMaxSteps);
    this.sharedRuntime.maxSteps ??= initialMaxSteps;
    this.maxSteps = this.sharedRuntime.maxSteps;
    this.resumeStackPrefix = this.options.resumeStackPrefix ?? [];
    this.runPaths = runPaths;
    this.reportDir = this.runPaths.reportsRel;
    ensureRunDirsExist(this.runPaths);
    applyRuntimeEnvironment(this.cwd, this.config, 'init');
    validateWorkflowConfig(this.config, this.options);

    this.state = createInitialState(this.config, this.options);
    // workflow_call の親から継承した Finding Contract があればそれを優先する。
    // 継承しないと子の parallel レビューが出す raw findings が親の台帳に届かず、
    // fix ステップへ渡らないまま reviewers ↔ fix が回り続ける（実測: 56周・9時間）。
    // 自前 finding_contract と継承の同時指定は WorkflowValidator で設定エラーに
    // しているため、ここでは「継承 or 自前」のどちらか一方だけが来る前提で良い。
    this.findingContract = this.options.inheritedFindingContract?.contract ?? this.config.findingContract;
    if (this.findingContract) {
      // 継承時は親と同一の FindingLedgerStore インスタンスをそのまま使う。
      // ledger_path / raw_findings_path はワークフロー名に紐づくため、子が
      // 自前で store を作り直すと親の when(findings.*) と別の台帳を見てしまう。
      this.findingLedgerStore = this.options.inheritedFindingContract?.ledgerStore ?? createFindingLedgerStore({
        projectCwd: this.projectCwd,
        reportDir: this.runPaths.reportsAbs,
        workflowName: this.config.name,
        ledgerPath: this.findingContract.ledgerPath,
        rawFindingsPath: this.findingContract.rawFindingsPath,
      });
      this.refreshFindingsState();
      this.findingLedgerStore.createRunCopy();
    }
    this.detectRuleIndex = this.options.detectRuleIndex ?? (() => {
      throw new Error('detectRuleIndex is required for rule evaluation');
    });
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
      refreshFindingsState: this.refreshFindingsState.bind(this),
      findingContract: this.findingContract,
      findingLedgerStore: this.findingLedgerStore,
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
      findingConflictAdjudicationRunner: this.findingContract && this.findingLedgerStore
        ? createFindingConflictAdjudicationRunner({
          ledgerStore: this.findingLedgerStore,
          optionsBuilder: this.optionsBuilder,
          stepExecutor: this.stepExecutor,
          getCwd: () => this.cwd,
          // 台帳へ書く文脈の workflowName は store が束縛する正準名を使う。
          // workflow_call の子が親の台帳を継承した場合、this.config.name
          // （子の名前）を使うと reconcile 文脈が親の台帳の workflowName と
          // 食い違う（StepExecutor / ParallelRunner の manager 経路と同じ理由）。
          workflowName: this.findingLedgerStore.workflowName,
          runId: this.runPaths.slug,
          refreshFindingsState: this.refreshFindingsState.bind(this),
          emitEvent: (event, ...args) => this.emit(event as never, ...args as []),
        })
        : undefined,
    });
    workflowRunExecutors.set(this, () => this.runWithSystemCleanup(
      () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('full'),
        () => runWorkflowToCompletion({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getCurrentWorkflowStack: () => this.sharedRuntime.activeResumePoint?.stack,
          getCwd: () => this.cwd,
          getMaxSteps: () => this.maxSteps,
          getReportDir: () => this.runPaths.reportsAbs,
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
          runQualityGates,
          persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
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
          checkCompletionGate: this.checkCompletionGate.bind(this),
        }),
        (result) => ({
          status: result.state.status,
          abortKind: result.abort?.kind,
          abortReason: result.abort?.reason,
          failure: result.abort?.failure,
          iterations: result.state.iteration,
        }),
        (error) => this.buildWorkflowErrorSpanOutcome(error),
      ),
      () => true,
    ));

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

  private refreshFindingsState(): void {
    if (!this.findingLedgerStore) {
      return;
    }
    this.state.findings = buildFindingsRuleContext(this.findingLedgerStore.loadLedger());
  }

  /**
   * COMPLETE 遷移直前のエンジン最終不変条件（v2 梯子設計 §7）: open な
   * provisional finding（意味を確定できなかった観測）が1件でも残っていれば
   * COMPLETE を拒否する。builtin workflow は findings.provisional.count を見て
   * need_replan へ先にルーティングするため、ここが発火するのは custom workflow
   * が provisional を処理する記述を欠いた設定不備 — 「ルールはあるが何も
   * マッチしない」と同じクラスとして fail-fast する。判定は state.findings の
   * キャッシュではなく保存直前の台帳を再読込して行う（並列子の更新を見逃さない）。
   */
  private checkCompletionGate(): { ok: true } | { ok: false; reason: string } {
    if (!this.findingLedgerStore) {
      return { ok: true };
    }
    const ledger = this.findingLedgerStore.loadLedger();
    const provisionals = ledger.findings.filter(
      (finding) => finding.status === 'open' && finding.provisional !== undefined,
    );
    if (provisionals.length === 0) {
      return { ok: true };
    }
    const items = provisionals.map(
      (finding) => `- ${finding.id} [${finding.provisional!.kind}]: ${finding.provisional!.reason}`,
    );
    return {
      ok: false,
      reason: [
        `Cannot COMPLETE: ${provisionals.length} provisional finding(s) remain open (observations whose meaning could not be determined):`,
        ...items,
        'Workflow rules must route on findings.provisional.count (e.g. to a replan step) before COMPLETE; a provisional finding is a system finding that blocks the final gate until later clean review evidence settles it.',
      ].join('\n'),
    };
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
    const previousSessionId = this.state.personaSessions.get(persona);
    if (sessionId === previousSessionId) return;

    if (sessionId === undefined) {
      this.state.personaSessions.delete(persona);
    } else {
      this.state.personaSessions.set(persona, sessionId);
    }

    if (this.options.onSessionUpdate && sessionId !== previousSessionId) {
      this.options.onSessionUpdate(persona, sessionId);
    }
  }

  private resolveNextStepFromDone(step: WorkflowStep, response: AgentResponse): string {
    return this.stepCoordinator.resolveNextStepFromDone(step, response);
  }

  private finalizeSystemStepResources(): void {
    this.systemStepExecutor.cleanup();
  }

  private buildWorkflowSpanParams(runMode: WorkflowSpanParams['runMode']): WorkflowSpanParams {
    return {
      enabled: this.options.observability?.enabled === true,
      runId: this.options.observabilityRunId,
      workflowName: this.config.name,
      initialStep: this.config.initialStep,
      stepCount: this.config.steps.length,
      maxSteps: this.maxSteps,
      runMode,
      resumeDepth: this.resumeStackPrefix.length,
      sanitizeText: this.options.sanitizeObservabilityText,
      traceTaskMetadata: this.options.traceTaskMetadata,
    };
  }

  private buildWorkflowErrorSpanOutcome(error: unknown): WorkflowSpanOutcome {
    const kind: WorkflowAbortKind = this.abortRequested ? 'interrupt' : 'runtime_error';
    const reason = this.abortRequested
      ? 'Workflow interrupted by user (SIGINT)'
      : ERROR_MESSAGES.STEP_EXECUTION_FAILED(getErrorMessage(error));
    return {
      status: 'error',
      abortKind: kind,
      abortReason: reason,
      failure: {
        kind,
        step: this.state.currentStep,
        reason,
      },
      iterations: this.state.iteration,
    };
  }

  private async runWithSystemCleanup<T>(
    execute: () => Promise<T>,
    shouldCleanup: (result: T | undefined, error: unknown | undefined) => boolean,
  ): Promise<T> {
    let result: T | undefined;
    let error: unknown | undefined;

    try {
      result = await execute();
      return result;
    } catch (caughtError) {
      error = caughtError;
      throw caughtError;
    } finally {
      if (shouldCleanup(result, error)) {
        this.finalizeSystemStepResources();
      }
    }
  }

  async run(): Promise<WorkflowState & { returnValue?: string }> {
    const result = await getWorkflowRunExecutor(this)();
    return {
      ...result.state,
      ...(result.returnValue !== undefined ? { returnValue: result.returnValue } : {}),
    };
  }

  async runSingleIteration(): Promise<{
    response: AgentResponse;
    nextStep: string;
    isComplete: boolean;
    returnValue?: string;
    loopDetected?: boolean;
  }> {
    return this.runWithSystemCleanup(
      () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('single_iteration'),
        () => runSingleWorkflowIteration({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getCurrentWorkflowStack: () => this.sharedRuntime.activeResumePoint?.stack,
          getCwd: () => this.cwd,
          getMaxSteps: () => this.maxSteps,
          getReportDir: () => this.runPaths.reportsAbs,
          abortRequested: () => this.abortRequested,
          getStep: this.stepCoordinator.getStep.bind(this.stepCoordinator),
          applyRuntimeEnvironment: (stage) => applyRuntimeEnvironment(this.cwd, this.config, stage),
          loopDetectorCheck: (stepName) => {
            const loopResult = this.loopDetector.check(stepName);
            return {
              shouldWarn: loopResult.shouldWarn ?? false,
              shouldAbort: loopResult.shouldAbort ?? false,
              count: loopResult.count,
              isLoop: loopResult.isLoop,
            };
          },
          cycleDetectorRecordAndCheck: (stepName) => this.cycleDetector.recordAndCheck(stepName),
          resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
          runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
          runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
          runQualityGates,
          persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
          buildInstruction: this.stepCoordinator.buildInstruction.bind(this.stepCoordinator),
          buildPhase1Instruction: this.stepCoordinator.buildPhase1Instruction.bind(this.stepCoordinator),
          resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
          resolveRuntimeForStep: this.stepCoordinator.resolveRuntimeForStep.bind(this.stepCoordinator),
          setActiveStep: this.setActiveResumePoint.bind(this),
          addUserInput: this.addUserInput.bind(this),
          emit: (event, ...args) => this.emit(event as never, ...args as []),
          updateMaxSteps: () => {},
          checkCompletionGate: this.checkCompletionGate.bind(this),
        }),
        (result) => ({
          status: result.isComplete ? this.state.status : 'running',
          abortKind: result.abort?.kind,
          abortReason: result.abort?.reason,
          failure: result.abort?.failure,
          nextStep: result.nextStep,
          iterations: this.state.iteration,
        }),
        (error) => this.buildWorkflowErrorSpanOutcome(error),
      ),
      (result, error) => error !== undefined || result?.isComplete === true || this.state.status !== 'running',
    );
  }
}
