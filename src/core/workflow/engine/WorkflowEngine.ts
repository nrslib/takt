import { EventEmitter } from 'node:events';
import { CapabilityAwareStructuredCaller, type StructuredCaller } from '../../../agents/structured-caller.js';
import { createWorkRequirementEstimator } from '../../../agents/auto-routing-usecase.js';
import { createLogger, generateReportDir, getErrorMessage, isValidReportDirName } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  FindingContractConfig,
  WorkflowConfig,
  LoopMonitorConfig,
  WorkflowPendingLoopJudge,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { WorkflowRestartPointSchema } from '../../models/workflow-resume-schema.js';
import {
  cloneDynamicParallelSelections,
  serializeDynamicParallelSelections,
} from '../dynamic-parallel/snapshot.js';
import { cloneWorkflowResumePoint, parseWorkflowResumePoint } from '../resume-point-codec.js';
import { DynamicParallelSelectionStore } from '../dynamic-parallel/selection-store.js';
import {
  restoreWorkflowCallInvocationEvidence,
  serializeWorkflowCallInvocationEvidence,
  snapshotWorkflowCallInvocationEvidence,
} from '../workflow-call-invocation-index.js';
import { restoreWorkflowStepParticipationIndex } from '../workflow-step-participation-index.js';
import { isWorkflowCallStep } from '../step-kind.js';
import { buildRunPaths, type RunPaths } from '../run/run-paths.js';
import type {
  WorkflowCallChildEngine,
  WorkflowAbortKind,
  AutoRoutingEstimatorSource,
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
import { RoutingRuntime } from '../auto-routing/runtime.js';
import { buildRoutingFindings } from '../auto-routing/snapshot.js';
import { resolveEffectiveAutoRouting } from '../auto-routing/effective-auto-routing.js';
import { buildWorkflowResumePointEntry, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
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
import type { FindingLedger, FindingLedgerEntry, ReviewerAnomalyEntry } from '../findings/types.js';
import { injectFindingConflictAdjudicationStep } from '../findings/adjudication-step.js';
import { createFindingConflictAdjudicationRunner } from '../findings/adjudication-runner.js';
import { rebindPendingManagerPublicationAtBootstrap } from '../findings/manager-commit.js';
import { ERROR_MESSAGES } from '../constants.js';
import { inheritReviewReports, writeReviewReportInheritanceDiagnostic } from '../report-inheritance.js';
import { WorkflowStepBudget } from '../workflow-step-budget.js';
import {
  createReviewReportDiscoveryContext,
  resolveInheritedReviewReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { getRemoteRepositoryIdentifiers } from '../../../infra/git/detect.js';
import { inheritWorkflowConfigMetadata, translateWorkflowConfigError } from '../../../shared/workflowConfigMetadata.js';
import {
  isWorkflowExecutionScope,
  snapshotWorkflowEventValue,
  snapshotWorkflowExecutionScope,
  workflowOwnerPathFromStack,
} from '../workflow-execution-scope.js';
import { WorkflowCallProgressTracker, type WorkflowCallProgressLease } from '../workflow-call-progress-tracker.js';
import { readRunMetaBySlug } from '../run/run-meta.js';
import { WorkflowRestartNavigator } from './WorkflowRestartNavigator.js';
const log = createLogger('workflow-engine');

type WorkflowEngineRuntimeOptions = WorkflowEngineOptions & {
  structuredOutputNormalizers: StructuredOutputNormalizerRegistry;
  autoRoutingEstimatorSource: AutoRoutingEstimatorSource;
};
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
const WORKFLOW_CALL_CONTEXT = Symbol('workflow-call-context');
const WORKFLOW_CALL_PROGRESS_PARENT = Symbol('workflow-call-progress-parent');
const FIX_STEP_NAME = 'fix';
const SCOPED_EVENT_ARGUMENT_COUNTS: Readonly<Record<string, number>> = {
  'step:start': 8,
  'step:complete': 4,
  'routing:decision': 8,
  'step:report': 4,
  'findings:ledger': 2,
  'phase:start': 7,
  'phase:complete': 8,
  'phase:judge_stage': 6,
};

type WorkflowCallChildOptions = WorkflowEngineOptions & {
  readonly [WORKFLOW_CALL_CONTEXT]: true;
  readonly [WORKFLOW_CALL_PROGRESS_PARENT]: WorkflowCallProgressLease;
};

function createWorkflowCallChildOptions(
  options: WorkflowEngineOptions,
  parentProgressLease: WorkflowCallProgressLease,
): WorkflowCallChildOptions {
  return {
    ...options,
    [WORKFLOW_CALL_CONTEXT]: true,
    [WORKFLOW_CALL_PROGRESS_PARENT]: parentProgressLease,
  };
}

function snapshotWorkflowState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    dynamicParallelSelections: cloneDynamicParallelSelections(state.dynamicParallelSelections),
    resumedDynamicParallelSteps: new Set(state.resumedDynamicParallelSteps),
  };
}

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
  private options: WorkflowEngineRuntimeOptions;
  private readonly stepBudget: WorkflowStepBudget;
  private loopDetector: LoopDetector;
  private cycleDetector: CycleDetector;
  private reportDir: string;
  private runPaths: RunPaths;
  private abortRequested = false;
  private readonly sharedRuntime: WorkflowSharedRuntimeState;
  private readonly progressLease: WorkflowCallProgressLease;
  private activeResumePoint?: WorkflowResumePoint;
  private pendingLoopJudge?: WorkflowPendingLoopJudge;
  private readonly resumeStackPrefix: WorkflowResumePointEntry[];
  private readonly findingLedgerStore?: FindingLedgerStore;
  private readonly findingContract?: FindingContractConfig;
  private findingContractBootstrap?: Promise<void>;

  private readonly optionsBuilder: WorkflowEngineServices['optionsBuilder'];
  private readonly stepExecutor: WorkflowEngineServices['stepExecutor'];
  private readonly parallelRunner: WorkflowEngineServices['parallelRunner'];
  private readonly arpeggioRunner: WorkflowEngineServices['arpeggioRunner'];
  private readonly teamLeaderRunner: WorkflowEngineServices['teamLeaderRunner'];
  private readonly systemStepExecutor: WorkflowEngineServices['systemStepExecutor'];
  private readonly loopMonitorJudgeRunner: WorkflowEngineServices['loopMonitorJudgeRunner'];
  private readonly workflowCallRunner: WorkflowEngineServices['workflowCallRunner'];
  private readonly stepCoordinator: WorkflowEngineStepCoordinator;
  private readonly structuredCaller: StructuredCaller;

  constructor(config: WorkflowConfig, cwd: string, task: string, options: WorkflowEngineOptions) {
    super();
    if (
      config.subworkflow?.callable === true
      && (options as Partial<WorkflowCallChildOptions>)[WORKFLOW_CALL_CONTEXT] !== true
    ) {
      throw new Error(
        `Configuration error: callable workflow "${config.name}" must be started from a workflow_call`,
      );
    }
    const resumePoint = options.resumePoint === undefined ? undefined : parseWorkflowResumePoint(options.resumePoint);
    const restartPoint = options.restartPoint === undefined
      ? undefined
      : WorkflowRestartPointSchema.parse(options.restartPoint);
    if (resumePoint !== undefined && restartPoint !== undefined) {
      throw new Error('Workflow engine cannot own both resumePoint and restartPoint');
    }
    if (restartPoint !== undefined && options.initialIteration !== undefined) {
      throw new Error('Workflow engine cannot own both restartPoint and initialIteration');
    }
    // The adjudication target must participate in normal step validation and execution,
    // so it is injected before restart validation and before services capture config.steps.
    this.config = injectFindingConflictAdjudicationStep(
      config,
      options.inheritedFindingContract?.contract ?? config.findingContract,
    );
    inheritWorkflowConfigMetadata(config, this.config);
    const restartNavigator = restartPoint === undefined
      ? undefined
      : new WorkflowRestartNavigator(restartPoint);
    const restartStartStep = restartNavigator?.resolveRootStartStep(
      this.config,
      options.startStep,
    );
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
    const inheritedAutoRouting = resolveEffectiveAutoRouting(config, options.autoRouting);
    if (options.autoStrategyOverride !== undefined && inheritedAutoRouting !== undefined) {
      options.onEffectiveAutoRoutingReached?.();
    }
    const effectiveAutoRouting = applyAutoRoutingStrategyOverride(
      inheritedAutoRouting,
      options.autoStrategyOverride,
    );
    const inheritedEstimatorSource = options.autoRoutingEstimatorSource;
    const autoRoutingEstimatorSource = inheritedEstimatorSource
      ?? (options.autoRoutingEstimator !== undefined
        ? 'injected'
        : effectiveAutoRouting === undefined
          ? 'absent'
          : 'engine-default');
    const autoRoutingEstimator = effectiveAutoRouting === undefined
      ? options.autoRoutingEstimator
      : options.autoRoutingEstimator ?? createWorkRequirementEstimator({
        cwd,
        provider: effectiveAutoRouting.router.provider,
        model: effectiveAutoRouting.router.model,
        language: options.language,
        childProcessEnv: options.childProcessEnv,
        abortSignal: options.abortSignal,
      });
    const routingSensitiveValues = effectiveAutoRouting === undefined
      ? options.routingSensitiveValues
      : options.routingSensitiveValues ?? getRemoteRepositoryIdentifiers(options.projectCwd);
    const routingRuntime = effectiveAutoRouting === undefined || autoRoutingEstimator === undefined
      ? undefined
      : options.routingRuntime ?? new RoutingRuntime({
        autoRouting: effectiveAutoRouting,
        estimator: autoRoutingEstimator,
      });
    this.options = {
      ...options,
      ...(resumePoint === undefined ? {} : { resumePoint }),
      ...(restartPoint === undefined ? {} : { restartPoint }),
      ...(restartStartStep === undefined ? {} : { startStep: restartStartStep }),
      rateLimitFallback: config.rateLimitFallback ?? options.rateLimitFallback,
      structuredCaller: this.structuredCaller,
      structuredOutputNormalizers: options.structuredOutputNormalizers ?? createStructuredOutputNormalizerRegistry([]),
      autoRouting: effectiveAutoRouting,
      autoRoutingEstimator,
      autoRoutingEstimatorSource,
      routingRuntime,
      routingSensitiveValues,
      traceTaskMetadata,
    };
    this.projectCwd = this.options.projectCwd;
    this.cwd = cwd;
    this.task = task;
    this.loopDetector = new LoopDetector(this.config.loopDetection);
    this.cycleDetector = new CycleDetector(this.config.loopMonitors ?? []);
    this.runPaths = runPaths;
    this.reportDir = this.runPaths.reportsRel;
    ensureRunDirsExist(runPaths);
    applyRuntimeEnvironment(this.cwd, this.config, 'init');
    try {
      validateWorkflowConfig(this.config, this.options);
    } catch (error) {
      throw translateWorkflowConfigError(this.config, error);
    }
    const initialMaxSteps = this.options.maxStepsOverride
      ?? this.options.resumePoint?.max_steps
      ?? this.config.maxSteps
      ?? this.options.sharedRuntime?.stepBudget?.currentMaxSteps();
    if (initialMaxSteps === undefined) {
      throw new Error(`Configuration error: root workflow "${this.config.name}" requires max_steps`);
    }
    this.sharedRuntime = this.options.sharedRuntime ?? createSharedRuntime(
      this.options.resumePoint,
      initialMaxSteps,
    );
    if (restartNavigator !== undefined) {
      if (this.sharedRuntime.restartNavigator !== undefined) {
        throw new Error('Workflow restart navigator is already initialized');
      }
      this.sharedRuntime.restartNavigator = restartNavigator;
    }
    this.sharedRuntime.dynamicParallelSelectionStore ??= new DynamicParallelSelectionStore(
      new Map(Object.entries(this.options.resumePoint?.dynamic_parallel_selections ?? {})),
    );
    this.sharedRuntime.workflowCallInvocationEvidence ??=
      restoreWorkflowCallInvocationEvidence(this.options.resumePoint);
    this.sharedRuntime.workflowStepParticipationIndex ??=
      restoreWorkflowStepParticipationIndex(this.options.resumePoint);
    this.sharedRuntime.workflowCallProgressTracker ??= new WorkflowCallProgressTracker();
    const parentProgressLease = (this.options as Partial<WorkflowCallChildOptions>)[WORKFLOW_CALL_PROGRESS_PARENT];
    this.progressLease = this.sharedRuntime.workflowCallProgressTracker.reserve(parentProgressLease);
    this.sharedRuntime.workflowCallInvocationEvidence.index.validateResumePoint(this.options.resumePoint);
    this.sharedRuntime.stepBudget ??= new WorkflowStepBudget(initialMaxSteps);
    this.stepBudget = this.sharedRuntime.stepBudget;
    this.resumeStackPrefix = this.options.resumeStackPrefix ?? [];
    this.pendingLoopJudge = this.options.resumePoint?.pending_loop_judge === undefined
      ? undefined
      : {
          ...this.options.resumePoint.pending_loop_judge,
          cycle: [...this.options.resumePoint.pending_loop_judge.cycle],
        };
    this.activeResumePoint = this.options.resumePoint === undefined
      ? undefined
      : {
          ...this.options.resumePoint,
          max_steps: this.stepBudget.currentMaxSteps(),
        };
    this.state = createInitialState(this.config, this.options);
    this.syncStateDynamicParallelSelections();
    this.inheritPreviousReviewReports();
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
        ...(this.options.resumeSource?.sourceRunSlug === undefined
          ? {}
          : { trustedResumeSourceRunId: this.options.resumeSource.sourceRunSlug }),
      });
      this.refreshFindingsState();
      this.findingLedgerStore.saveLedgerSnapshot();
    }
    const services = createWorkflowEngineServices({
      config: this.config,
      state: this.state,
      task: this.task,
      projectCwd: this.projectCwd,
      getCwd: () => this.cwd,
      getReportDir: () => this.reportDir,
      getRunPaths: () => this.runPaths,
      stepBudget: this.stepBudget,
      interruptRequested: () => this.abortRequested || this.options.abortSignal?.aborted === true,
      options: this.options,
      structuredCaller: this.structuredCaller,
      sharedRuntime: this.sharedRuntime,
      progressLease: this.progressLease,
      resumeStackPrefix: this.resumeStackPrefix,
      runPaths: this.runPaths,
      setActiveResumePoint: this.setActiveResumePoint.bind(this),
      setActiveResumeStack: this.setActiveResumeStack.bind(this),
      adoptResumeCheckpoint: this.adoptResumeCheckpoint.bind(this),
      getActiveResumePoint: () => this.activeResumePoint,
      buildStepExecutionScope: (step, iteration) =>
        snapshotWorkflowExecutionScope(this.buildResumePoint(step, iteration).stack),
      setPendingLoopJudge: this.setPendingLoopJudge.bind(this),
      startPendingLoopJudge: this.startPendingLoopJudge.bind(this),
      clearPendingLoopJudge: this.clearPendingLoopJudge.bind(this),
      syncMaxSteps: this.syncMaxSteps.bind(this),
      persistDynamicParallelSelection: this.persistDynamicParallelSelection.bind(this),
      refreshFindingsState: this.refreshFindingsState.bind(this),
      findingContract: this.findingContract,
      findingLedgerStore: this.findingLedgerStore,
      updatePersonaSession: this.updatePersonaSession.bind(this),
      resolveNextStepFromDone: this.resolveNextStepFromDone.bind(this),
      resetCycleDetector: () => this.cycleDetector.reset(),
      emitEvent: (event, ...args) => this.emitEvent(event, ...args),
      createEngine: (nestedConfig, nestedCwd, nestedTask, nestedOptions): WorkflowCallChildEngine => {
        const nestedEngine = new WorkflowEngine(
          nestedConfig,
          nestedCwd,
          nestedTask,
          createWorkflowCallChildOptions(nestedOptions, this.progressLease),
        );
        return {
          on: nestedEngine.on.bind(nestedEngine),
          runWithResult: () => getWorkflowRunExecutor(nestedEngine)(),
          getOwnedResumePoint: () => nestedEngine.getResumePoint(),
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
      stepBudget: this.stepBudget,
      getOptions: () => this.options,
      stepExecutor: this.stepExecutor,
      parallelRunner: this.parallelRunner,
      arpeggioRunner: this.arpeggioRunner,
      teamLeaderRunner: this.teamLeaderRunner,
      systemStepExecutor: this.systemStepExecutor,
      loopMonitorJudgeRunner: this.loopMonitorJudgeRunner,
      workflowCallRunner: this.workflowCallRunner,
      updatePersonaSession: this.updatePersonaSession.bind(this),
      emitReport: (step, filePath, fileName, eventAttribution) => this.emitEvent(
        'step:report',
        step,
        filePath,
        fileName,
        eventAttribution.iteration,
        eventAttribution.scope,
      ),
      getExecutionOwnerPath: () => workflowOwnerPathFromStack(this.resumeStackPrefix),
      recordParticipation: (step, reportNames, ownerPath) => {
        this.sharedRuntime.workflowStepParticipationIndex!.record(
          this.config,
          step.name,
          ownerPath,
          reportNames,
        );
      },
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
          emitEvent: (event, ...args) => this.emitEvent(event, ...args),
        })
        : undefined,
    });
    workflowRunExecutors.set(this, async () => {
      await this.initializeFindingContract();
      return this.runWithSystemCleanup(
        () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('full'),
        () => runWorkflowToCompletion({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getTask: () => this.task,
          getRoutingFindings: () => buildRoutingFindings(this.findingLedgerStore?.loadLedger()),
          getCurrentWorkflowStack: () => this.activeResumePoint?.stack,
          buildStepExecutionScope: (step, iteration) =>
            snapshotWorkflowExecutionScope(this.buildResumePoint(step, iteration).stack),
          getCwd: () => this.cwd,
          stepBudget: this.stepBudget,
          recordCountableProgress: () => this.progressLease.recordCountableProgress(),
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
          cycleDetectorRecordAndCheck: (stepName, nextStep) => this.cycleDetector.recordAndCheck(stepName, nextStep),
          resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
          runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
          getPendingLoopJudge: this.getPendingLoopJudge.bind(this),
          runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
          runQualityGates,
          persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
          prepareNormalStepExecution: this.stepCoordinator.prepareNormalStepExecution.bind(this.stepCoordinator),
          resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
          resolveStepProviderModelBeforeAutoRouting: (step, runtime) => this.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(step, runtime),
          setActiveStep: this.setActiveResumePoint.bind(this),
          syncMaxSteps: this.syncMaxSteps.bind(this),
          addUserInput: this.addUserInput.bind(this),
          emit: (event, ...args) => this.emitEvent(event, ...args),
          checkCompletionGate: this.checkCompletionGate.bind(this),
          checkReturnValueGate: this.checkReturnValueGate.bind(this),
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
    );
    });

    log.debug('WorkflowEngine initialized', {
      workflow: config.name,
      steps: config.steps.map((step) => step.name),
      initialStep: config.initialStep,
      maxSteps: config.maxSteps,
      effectiveMaxSteps: this.stepBudget.currentMaxSteps(),
    });
  }

  getState(): WorkflowState {
    return snapshotWorkflowState(this.state);
  }

  private emitEvent(event: string, ...args: unknown[]): void {
    if (event === 'workflow:complete' || event === 'workflow:abort') {
      this.emit(event, snapshotWorkflowState(this.state), ...args.slice(1));
      return;
    }
    if (event === 'workflow_call:start' || event === 'workflow_call:complete') {
      const lifecycle = args[0] as { stack: WorkflowResumePointEntry[]; result?: unknown };
      const scope = snapshotWorkflowExecutionScope(lifecycle.stack);
      this.emit(event, Object.freeze({
        ...lifecycle,
        stack: scope.stack,
        ...(lifecycle.result === undefined
          ? {}
          : { result: snapshotWorkflowEventValue(lifecycle.result) }),
      }));
      return;
    }
    if (
      event === 'step:start'
      || event === 'step:complete'
      || event === 'routing:decision'
      || event === 'step:report'
      || event === 'findings:ledger'
      || event === 'phase:start'
      || event === 'phase:complete'
      || event === 'phase:judge_stage'
    ) {
      const incomingScope = args.at(-1);
      if (!isWorkflowExecutionScope(incomingScope)) {
        throw new Error(`${event} event requires an explicit execution scope`);
      }
      const scope = snapshotWorkflowExecutionScope(incomingScope.stack);
      const sourceArgs = args.slice(0, -1);
      if (
        (event === 'step:report' && typeof sourceArgs[3] !== 'number')
        || (event === 'findings:ledger' && typeof sourceArgs[1] !== 'number')
      ) {
        throw new Error(`${event} event requires an explicit iteration`);
      }
      const eventArgs = sourceArgs.map(snapshotWorkflowEventValue);
      const expectedArgumentCount = SCOPED_EVENT_ARGUMENT_COUNTS[event];
      if (expectedArgumentCount === undefined) {
        throw new Error(`Missing scoped event contract for ${event}`);
      }
      while (eventArgs.length < expectedArgumentCount) {
        eventArgs.push(undefined);
      }
      this.emit(event, ...eventArgs, scope);
      return;
    }
    this.emit(event, ...args);
  }

  private refreshFindingsState(): void {
    if (!this.findingLedgerStore) {
      return;
    }
    this.state.findings = buildFindingsRuleContext(this.findingLedgerStore.loadLedger(), this.cwd);
  }

  private async initializeFindingContract(): Promise<void> {
    if (this.findingLedgerStore === undefined) {
      return;
    }
    this.findingContractBootstrap ??= rebindPendingManagerPublicationAtBootstrap(
      this.findingLedgerStore,
    );
    await this.findingContractBootstrap;
    this.refreshFindingsState();
  }

  /** Open findings still carrying provisional metadata. */
  private loadOpenProvisionalFindings(ledger: FindingLedger): FindingLedgerEntry[] {
    return ledger.findings.filter(
      (finding) => finding.status === 'open' && finding.provisional !== undefined,
    );
  }

  /** Human-readable bullet lines for open provisional findings. */
  private formatProvisionalFindingItems(provisionals: readonly FindingLedgerEntry[]): string[] {
    return provisionals.map(
      (finding) => `- ${finding.id} [${finding.provisional!.kind}]: ${finding.provisional!.reason}`,
    );
  }

  /** 二系統台帳（review-integrity protocol）の未昇格 anomaly。 */
  private loadOutstandingReviewerAnomalies(ledger: FindingLedger): ReviewerAnomalyEntry[] {
    return (ledger.reviewerAnomalies ?? []).filter((anomaly) => anomaly.promotedFindingId === undefined);
  }

  /**
   * COMPLETE 遷移直前のエンジン最終不変条件。2つの独立したゲートを見る:
   *
   * 1. product gate: open な provisional finding（意味を確定
   *    できなかった観測）が1件でも残っていれば COMPLETE を拒否する。
   *
   * 2. review-integrity gate（review-integrity requirement）: 未昇格（promotedFindingId
   *    無し）の reviewer anomaly が1件でも残っていれば COMPLETE を拒否する。
   *    二系統台帳（review-integrity protocol）で全指摘が anomaly に隔離された run は product
   *    gate が空になり「即 COMPLETE」で実質レビューされずに通り得たため、product
   *    gate とは別にここで fail-closed にする。anomaly は product finding では
   *    ないので product gate（open/provisional の count）は塞がない — この
   *    review-integrity gate だけが COMPLETE を止め、builtin は未昇格 anomaly を
   *    見て再レビューまたは再計画へルーティングする。custom
   *    workflow がその配線を欠いても、このエンジンゲートが COMPLETE を拒否する。
   *
   * builtin workflow は先に findings.provisional.count / findings.reviewerAnomalies を
   * 見てルーティングするため、ここが発火するのは custom workflow の設定不備 —
   * 「ルールはあるが何もマッチしない」と同じクラスとして fail-fast する。判定は
   * state.findings のキャッシュではなく保存直前の台帳を再読込して行う（並列子の
   * 更新を見逃さない）。
   */
  private checkCompletionGate(): { ok: true } | { ok: false; reason: string } {
    if (!this.findingLedgerStore) {
      return { ok: true };
    }
    const ledger = this.findingLedgerStore.loadLedger();
    const provisionals = this.loadOpenProvisionalFindings(ledger);
    const anomalies = this.loadOutstandingReviewerAnomalies(ledger);
    if (provisionals.length === 0 && anomalies.length === 0) {
      return { ok: true };
    }
    const reasonLines: string[] = ['Cannot COMPLETE:'];
    if (provisionals.length > 0) {
      reasonLines.push(
        `- ${provisionals.length} provisional finding(s) remain open (observations whose meaning could not be determined):`,
        ...this.formatProvisionalFindingItems(provisionals),
        '  Workflow rules must route on findings.provisional.count (e.g. to a replan step) before COMPLETE; a provisional finding is a system finding that blocks the final gate until later clean review evidence settles it.',
      );
    }
    if (anomalies.length > 0) {
      reasonLines.push(...this.formatReviewIntegrityGateReason(anomalies));
    }
    return { ok: false, reason: reasonLines.join('\n') };
  }

  private formatReviewIntegrityGateReason(anomalies: readonly ReviewerAnomalyEntry[]): string[] {
    return [
      `- ${anomalies.length} unpromoted reviewer anomaly(ies) remain (reviewer claims whose evidence did not mechanically verify — the reviewed scope was not soundly reviewed):`,
      ...anomalies.map((anomaly) => `  - ${anomaly.id} [${anomaly.kind}]: ${anomaly.mismatchReason}`),
      '  This is the review-integrity gate: an unpromoted anomaly is NOT a product finding, so it does not block the product gate — but the workflow must route on findings.reviewerAnomalies.count to re-review until a correctly-quoted finding promotes it, or replan when the existing review approach cannot substantiate it. Completion is never allowed while an unverified reviewer anomaly stands.',
    ];
  }

  /**
   * review-integrity gate 単独。checkCompletionGate は product
   * gate（provisional）+ review-integrity gate（未昇格 anomaly）の両方を見るが、
   * こちらは未昇格 anomaly だけを見る。returnValue 終端（`return: X`）に適用する
   * ためのもの: `return: need_replan` のような「未解決の provisional を親/呼び出し元へ
   * ハンドバックするシグナル」は provisional gate で塞ぐべきではない（provisional は
   * そのシグナルで扱われる）が、未昇格 anomaly が残ったまま 'completed' になるのは
   * どの完了経路でも許さない（review integrity は engine 側のハード不変条件）。
   */
  private checkReviewIntegrityGate(): { ok: true } | { ok: false; reason: string } {
    if (!this.findingLedgerStore) {
      return { ok: true };
    }
    const anomalies = this.loadOutstandingReviewerAnomalies(this.findingLedgerStore.loadLedger());
    if (anomalies.length === 0) {
      return { ok: true };
    }
    return { ok: false, reason: ['Cannot complete:', ...this.formatReviewIntegrityGateReason(anomalies)].join('\n') };
  }

  private checkReturnValueGate(): { ok: true } | { ok: false; reason: string } {
    if (this.options.inheritedFindingContract !== undefined) {
      return { ok: true };
    }
    return this.checkReviewIntegrityGate();
  }

  private inheritPreviousReviewReports(): void {
    const resumeSource = this.options.resumeSource;
    const currentStep = this.config.steps.find((step) => step.name === this.state.currentStep);
    if (!resumeSource || !currentStep || currentStep.name !== FIX_STEP_NAME || !this.isResumeTarget(currentStep)) {
      return;
    }
    const reportNameResult = resolveInheritedReviewReportNamesWithDiagnostics(createReviewReportDiscoveryContext({
      step: currentStep,
      workflow: this.config,
      workflowCallResolver: this.options.workflowCallResolver,
      projectCwd: this.projectCwd,
      lookupCwd: this.cwd,
      resumeStackPrefix: this.resumeStackPrefix,
      stepOutputNames: new Set(this.state.stepOutputs.keys()),
      restoredStepIterationNames: this.state.restoredStepIterationNames,
      dynamicParallelSelections: this.state.dynamicParallelSelections,
      workflowCallInvocations: snapshotWorkflowCallInvocationEvidence(
        this.sharedRuntime.workflowCallInvocationEvidence!,
      ),
      workflowStepParticipations: this.sharedRuntime.workflowStepParticipationIndex!.snapshot(),
    }));
    const fatalFailure = reportNameResult.failures.find((failure) => failure.kind === 'fatal');
    if (fatalFailure !== undefined) {
      throw new Error(`Invalid review report discovery state: ${fatalFailure.reason}`);
    }
    const recoverableFailures = reportNameResult.failures.map((failure) => failure.reason);
    const sourceRunMeta = resumeSource.sourceRunSlug === undefined
      ? null
      : readRunMetaBySlug(this.cwd, resumeSource.sourceRunSlug, (warning) => {
          log.warn('Failed to load source run metadata for report inheritance', { warning });
        });
    const sourceWorkflowCallInvocations = sourceRunMeta?.resumePoint?.workflow_call_invocations;
    const inheritanceOptions = {
      cwd: this.cwd,
      sourceRunSlug: resumeSource.sourceRunSlug,
      currentRunSlug: this.runPaths.slug,
      targetReportDirectory: this.runPaths.reportsAbs,
      reviewReportNames: reportNameResult.reportNames,
      discoveryFailures: recoverableFailures,
      ...(sourceWorkflowCallInvocations === undefined
        ? {}
        : { sourceWorkflowCallInvocations }),
    };
    try {
      const result = inheritReviewReports(inheritanceOptions);
      try {
        writeReviewReportInheritanceDiagnostic(inheritanceOptions, result);
      } catch (error) {
        log.warn('Failed to write review report inheritance diagnostic', { error: getErrorMessage(error), result });
      }
      if (result.fallbackUsed) {
        log.warn('Review report inheritance completed with fallback', result);
      } else {
        log.info('Review report inheritance completed', result);
      }
    } catch (error) {
      const diagnosticOptions = {
        cwd: this.cwd,
        sourceRunSlug: resumeSource.sourceRunSlug,
        currentRunSlug: this.runPaths.slug,
        targetReportDirectory: this.runPaths.reportsAbs,
        reviewReportNames: [],
      };
      const result = {
        ...(resumeSource.sourceRunSlug ? { sourceRunSlug: resumeSource.sourceRunSlug } : {}),
        targetReportDirectory: this.runPaths.reportsAbs,
        status: 'unavailable' as const,
        fallbackUsed: true,
        copied: [],
        skipped: [{ reportName: '*', reason: `resolution_failed:${getErrorMessage(error)}` }],
      };
      try {
        writeReviewReportInheritanceDiagnostic(diagnosticOptions, result);
      } catch (diagnosticError) {
        log.warn('Failed to write review report inheritance diagnostic', {
          error: getErrorMessage(diagnosticError),
          result,
        });
      }
      log.warn('Review report inheritance completed with fallback', result);
    }
  }

  private isResumeTarget(step: WorkflowStep): boolean {
    if (this.options.startStep === step.name) {
      return true;
    }
    const resumePoint = this.options.resumePoint;
    const entry = resumePoint?.stack[this.resumeStackPrefix.length];
    return entry !== undefined
      && entry.step === step.name
      && workflowEntryMatchesWorkflow(entry, this.config);
  }

  private buildResumePoint(
    step: WorkflowStep,
    iteration: number,
    dynamicParallelSelections: ReadonlyMap<string, import('../../models/types.js').DynamicParallelSelectionSnapshot> = this.sharedRuntime.dynamicParallelSelectionStore!.snapshot(),
  ): WorkflowResumePoint {
    const workflowCallInstance = isWorkflowCallStep(step)
      ? this.sharedRuntime.workflowCallInvocationEvidence!.index.get(
          this.config,
          step.name,
          workflowOwnerPathFromStack(this.resumeStackPrefix),
        )?.call_instance
      : undefined;
    const workflowCallInvocations = serializeWorkflowCallInvocationEvidence(
      this.sharedRuntime.workflowCallInvocationEvidence!,
    );
    const workflowStepParticipations =
      this.sharedRuntime.workflowStepParticipationIndex!.serialized();
    return {
      version: 2,
      stack: [
        ...this.resumeStackPrefix,
        buildWorkflowResumePointEntry(
          this.config,
          step.name,
          getWorkflowStepKind(step),
          this.state.stepIterations,
          workflowCallInstance,
        ),
      ],
      iteration,
      max_steps: this.stepBudget.currentMaxSteps(),
      elapsed_ms: Date.now() - this.sharedRuntime.startedAtMs,
      ...(this.pendingLoopJudge === undefined
        ? {}
        : { pending_loop_judge: this.clonePendingLoopJudge(this.pendingLoopJudge) }),
      ...(this.state.pendingFallback === undefined || this.state.rateLimitFallbackAttempts === undefined
        ? {}
        : {
            pending_fallback: {
              context: { ...this.state.pendingFallback },
              attempts: this.state.rateLimitFallbackAttempts.map((attempt) => ({ ...attempt })),
            },
          }),
      ...(dynamicParallelSelections.size === 0
        ? {}
        : { dynamic_parallel_selections: serializeDynamicParallelSelections(dynamicParallelSelections) }),
      workflow_call_invocations: workflowCallInvocations,
      workflow_step_participations: workflowStepParticipations,
    };
  }

  private setActiveResumePoint(step: WorkflowStep, iteration: number): void {
    this.syncStateDynamicParallelSelections();
    const resumePoint = this.buildResumePoint(step, iteration);
    this.commitExecutionCheckpoint(resumePoint, iteration);
  }

  private setActiveResumeStack(
    stack: readonly WorkflowResumePointEntry[],
    iteration: number,
  ): void {
    if (iteration < this.state.iteration) {
      throw new Error('Cannot adopt a resume stack at an earlier iteration');
    }
    this.syncStateDynamicParallelSelections();
    const resumePoint: WorkflowResumePoint = {
      version: 2,
      stack: stack.map((entry) => ({
        ...entry,
        ...(entry.step_iterations === undefined
          ? {}
          : { step_iterations: { ...entry.step_iterations } }),
      })),
      iteration,
      max_steps: this.stepBudget.currentMaxSteps(),
      elapsed_ms: Date.now() - this.sharedRuntime.startedAtMs,
      ...(this.pendingLoopJudge === undefined
        ? {}
        : { pending_loop_judge: this.clonePendingLoopJudge(this.pendingLoopJudge) }),
      ...(this.state.pendingFallback === undefined || this.state.rateLimitFallbackAttempts === undefined
        ? {}
        : {
            pending_fallback: {
              context: { ...this.state.pendingFallback },
              attempts: this.state.rateLimitFallbackAttempts.map((attempt) => ({ ...attempt })),
            },
          }),
      ...(this.sharedRuntime.dynamicParallelSelectionStore!.serialized() === undefined
        ? {}
        : {
            dynamic_parallel_selections:
              this.sharedRuntime.dynamicParallelSelectionStore!.serialized(),
          }),
      workflow_call_invocations: serializeWorkflowCallInvocationEvidence(
        this.sharedRuntime.workflowCallInvocationEvidence!,
      ),
      workflow_step_participations:
        this.sharedRuntime.workflowStepParticipationIndex!.serialized(),
    };
    this.commitExecutionCheckpoint(resumePoint, iteration);
  }

  private adoptResumeCheckpoint(resumePoint: WorkflowResumePoint, iteration: number): void {
    if (
      !Number.isSafeInteger(iteration)
      || iteration < resumePoint.iteration
      || iteration < this.state.iteration
    ) {
      throw new Error('Cannot adopt a resume checkpoint at an earlier iteration');
    }
    this.commitExecutionCheckpoint(cloneWorkflowResumePoint({
      ...resumePoint,
      iteration,
    }), iteration);
  }

  private commitExecutionCheckpoint(resumePoint: WorkflowResumePoint, iteration: number): void {
    if (resumePoint.iteration !== iteration) {
      throw new Error('Execution state and resume checkpoint iterations must match');
    }
    this.state.iteration = iteration;
    this.activeResumePoint = resumePoint;
  }

  private clonePendingLoopJudge<T extends WorkflowPendingLoopJudge>(pending: T): T {
    return {
      ...pending,
      cycle: [...pending.cycle],
    } as T;
  }

  private setPendingLoopJudge(
    triggeringStep: WorkflowStep,
    pending: WorkflowPendingLoopJudge,
    iteration: number,
  ): void {
    this.pendingLoopJudge = this.clonePendingLoopJudge(pending);
    this.setActiveResumePoint(triggeringStep, iteration);
  }

  private startPendingLoopJudge(
    judgeStep: WorkflowStep,
    pending: import('../../models/types.js').WorkflowPendingLoopJudgeStarted,
    iteration: number,
  ): void {
    this.pendingLoopJudge = this.clonePendingLoopJudge(pending);
    this.setActiveResumePoint(judgeStep, iteration);
  }

  private clearPendingLoopJudge(triggeringStep: WorkflowStep, iteration: number): void {
    this.pendingLoopJudge = undefined;
    this.setActiveResumePoint(triggeringStep, iteration);
  }

  private getPendingLoopJudge(): {
    monitor: LoopMonitorConfig;
    cycleCount: number;
    triggeringStep: WorkflowStep;
    fallbackNextStep: string;
    resumedStart?: import('../../models/types.js').WorkflowPendingLoopJudgeStarted;
  } | undefined {
    const pending = this.pendingLoopJudge;
    if (pending === undefined) {
      return undefined;
    }
    const resumePoint = this.options.resumePoint;
    if (resumePoint === undefined) {
      throw new Error('Pending loop judge requires a resume point');
    }
    const ownerIndex = resumePoint.stack.length - 1;
    if (this.resumeStackPrefix.length < ownerIndex) {
      return undefined;
    }
    if (this.resumeStackPrefix.length > ownerIndex) {
      throw new Error('Pending loop judge owner is outside the current resume stack');
    }
    const resumeEntry = resumePoint.stack[ownerIndex]!;
    const expectedOwner = pending.status === 'started' ? pending.judge_step : pending.triggering_step;
    const monitors = (this.config.loopMonitors ?? []).filter(
      (monitor) => monitor.cycle.length === pending.cycle.length
        && monitor.cycle.every((stepName, index) => stepName === pending.cycle[index]),
    );
    if (monitors.length !== 1) {
      throw new Error(`Pending loop judge cycle must match exactly one loop monitor: ${pending.cycle.join(' -> ')}`);
    }
    const triggeringStep = this.config.steps.find((step) => step.name === pending.triggering_step);
    if (triggeringStep === undefined) {
      throw new Error(`Pending loop judge references unknown triggering step: ${pending.triggering_step}`);
    }
    const expectedOwnerKind = pending.status === 'started'
      ? 'agent'
      : getWorkflowStepKind(triggeringStep);
    if (
      !workflowEntryMatchesWorkflow(resumeEntry, this.config)
      || resumeEntry.step !== expectedOwner
      || resumeEntry.kind !== expectedOwnerKind
    ) {
      throw new Error(`Pending loop judge owner does not match workflow "${this.config.name}"`);
    }
    return {
      monitor: monitors[0]!,
      cycleCount: pending.cycle_count,
      triggeringStep,
      fallbackNextStep: pending.fallback_next_step,
      ...(pending.status === 'started'
        ? { resumedStart: this.clonePendingLoopJudge(pending) }
        : {}),
    };
  }

  private syncMaxSteps(maxSteps: import('../../models/types.js').WorkflowMaxSteps): void {
    if (this.activeResumePoint === undefined) {
      return;
    }
    this.activeResumePoint = {
      ...this.activeResumePoint,
      max_steps: maxSteps,
    };
  }

  private async persistDynamicParallelSelection(
    step: WorkflowStep,
    iteration: number,
    identity: string,
    selection: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ): Promise<void> {
    const selections = await this.sharedRuntime.dynamicParallelSelectionStore!.commit(identity, selection, async (selections) => {
      const resumePoint = this.buildResumePoint(step, iteration, selections);
      await this.options.onDynamicParallelSelectionPersisted?.(resumePoint);
      this.activeResumePoint = resumePoint;
    });
    this.syncStateDynamicParallelSelections(selections);
  }

  getResumePoint(): WorkflowResumePoint | undefined {
    const activeResumePoint = this.activeResumePoint;
    const activeEntry = activeResumePoint?.stack[this.resumeStackPrefix.length];
    if (activeResumePoint === undefined || activeEntry === undefined) {
      return activeResumePoint;
    }

    const stack = [...activeResumePoint.stack];
    const activeStep = this.config.steps.find((step) => step.name === activeEntry.step);
    const workflowCallInstance = activeStep !== undefined && isWorkflowCallStep(activeStep)
      ? this.sharedRuntime.workflowCallInvocationEvidence!.index.get(
          this.config,
          activeStep.name,
          workflowOwnerPathFromStack(this.resumeStackPrefix),
        )?.call_instance
      : undefined;
    stack[this.resumeStackPrefix.length] = buildWorkflowResumePointEntry(
      this.config,
      activeEntry.step,
      activeEntry.kind,
      this.state.stepIterations,
      workflowCallInstance,
    );
    const dynamicParallelSelections = this.sharedRuntime.dynamicParallelSelectionStore!.serialized();
    const workflowCallInvocations = serializeWorkflowCallInvocationEvidence(
      this.sharedRuntime.workflowCallInvocationEvidence!,
    );
    const workflowStepParticipations =
      this.sharedRuntime.workflowStepParticipationIndex!.serialized();
    const refreshedResumePoint = {
      ...activeResumePoint,
      stack,
      ...(dynamicParallelSelections === undefined
        ? {}
        : { dynamic_parallel_selections: dynamicParallelSelections }),
      workflow_call_invocations: workflowCallInvocations,
      workflow_step_participations: workflowStepParticipations,
    };
    this.activeResumePoint = refreshedResumePoint;
    return cloneWorkflowResumePoint(refreshedResumePoint);
  }

  private syncStateDynamicParallelSelections(
    selections = this.sharedRuntime.dynamicParallelSelectionStore!.snapshot(),
  ): void {
    this.state.dynamicParallelSelections.clear();
    for (const [identity, selection] of selections) {
      this.state.dynamicParallelSelections.set(identity, selection);
    }
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
      maxSteps: this.stepBudget.currentMaxSteps(),
      runMode,
      resumeDepth: this.resumeStackPrefix.length,
      sanitizeText: this.options.sanitizeObservabilityText,
      traceTaskMetadata: this.options.traceTaskMetadata,
    };
  }

  private buildWorkflowErrorSpanOutcome(error: unknown): WorkflowSpanOutcome {
    const interruptReason = this.abortRequested
      ? 'Workflow interrupted by user (SIGINT)'
      : this.options.abortSignal?.aborted === true
        ? 'Workflow interrupted by external AbortSignal'
        : undefined;
    const kind: WorkflowAbortKind = interruptReason === undefined ? 'runtime_error' : 'interrupt';
    const reason = interruptReason ?? ERROR_MESSAGES.STEP_EXECUTION_FAILED(getErrorMessage(error));
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
      this.progressLease.activate();
      result = await execute();
      return result;
    } catch (caughtError) {
      error = caughtError;
      throw caughtError;
    } finally {
      if (shouldCleanup(result, error)) {
        this.finalizeSystemStepResources();
        this.progressLease.release();
      }
    }
  }

  async run(): Promise<WorkflowState & { returnValue?: string }> {
    const result = await getWorkflowRunExecutor(this)();
    return {
      ...snapshotWorkflowState(result.state),
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
      async () => {
        await this.initializeFindingContract();
        return runWithWorkflowSpan(
          this.buildWorkflowSpanParams('single_iteration'),
          () => runSingleWorkflowIteration({
            state: this.state,
            options: this.options,
            getWorkflowName: () => this.config.name,
            getTask: () => this.task,
            getRoutingFindings: () => buildRoutingFindings(this.findingLedgerStore?.loadLedger()),
            getCurrentWorkflowStack: () => this.activeResumePoint?.stack,
            buildStepExecutionScope: (step, iteration) =>
              snapshotWorkflowExecutionScope(this.buildResumePoint(step, iteration).stack),
            getCwd: () => this.cwd,
            stepBudget: this.stepBudget,
            recordCountableProgress: () => this.progressLease.recordCountableProgress(),
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
            cycleDetectorRecordAndCheck: (stepName, nextStep) => this.cycleDetector.recordAndCheck(stepName, nextStep),
            resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
            runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
            getPendingLoopJudge: this.getPendingLoopJudge.bind(this),
            runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
            runQualityGates,
            persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
            prepareNormalStepExecution: this.stepCoordinator.prepareNormalStepExecution.bind(this.stepCoordinator),
            resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
            resolveStepProviderModelBeforeAutoRouting: (step, runtime) => this.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(step, runtime),
            setActiveStep: this.setActiveResumePoint.bind(this),
            syncMaxSteps: this.syncMaxSteps.bind(this),
            addUserInput: this.addUserInput.bind(this),
            emit: (event, ...args) => this.emitEvent(event, ...args),
            checkCompletionGate: this.checkCompletionGate.bind(this),
            checkReturnValueGate: this.checkReturnValueGate.bind(this),
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
        );
      },
      (result, error) => error !== undefined || result?.isComplete === true || this.state.status !== 'running',
    );
  }
}
