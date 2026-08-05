import { EventEmitter } from 'node:events';
import { CapabilityAwareStructuredCaller, type StructuredCaller } from '../../../agents/structured-caller.js';
import { createWorkRequirementEstimator } from '../../../agents/auto-routing-usecase.js';
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
import type { FindingManagerAuthority } from '../../models/finding-types.js';
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
import { buildRunPaths, type RunPaths } from '../run/run-paths.js';
import { createRunFailure } from '../run/run-failure.js';
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
import { getWorkflowResumeFrameKind, isWorkflowCallStep } from '../step-kind.js';
import { applyAutoRoutingStrategyOverride } from '../auto-routing/resolver.js';
import { RoutingRuntime } from '../auto-routing/runtime.js';
import { buildRoutingFindings } from '../auto-routing/snapshot.js';
import { resolveEffectiveAutoRouting } from '../auto-routing/effective-auto-routing.js';
import { buildWorkflowResumePointEntry, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
import { runWithWorkflowSpan, type WorkflowSpanOutcome, type WorkflowSpanParams } from '../observability/workflowSpans.js';
import { WorkflowEngineStepCoordinator } from './WorkflowEngineStepCoordinator.js';
import type { WorkflowCallExecutionToken } from './WorkflowCallRunner.js';
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
import type { FindingLedgerStore } from '../findings/store.js';
import type { FindingLedger, FindingLedgerEntry, ReviewerAnomalyEntry } from '../findings/types.js';
import { injectFindingConflictAdjudicationStep } from '../findings/adjudication-step.js';
import { createFindingConflictAdjudicationRunner } from '../findings/adjudication-runner.js';
import { rebindPendingManagerPublicationAtBootstrap } from '../findings/manager-commit.js';
import { isOutstandingReviewerAnomaly } from '../findings/reviewer-anomalies.js';
import { listFindingReviewPublications } from '../findings/review-publication.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { ERROR_MESSAGES } from '../constants.js';
import { inheritReviewReports, writeReviewReportInheritanceDiagnostic } from '../report-inheritance.js';
import {
  createReviewReportDiscoveryContext,
  resolveInheritedReviewReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { getRemoteRepositoryIdentifiers } from '../../../infra/git/detect.js';
import { WorkflowResumeContinuation } from './workflow-resume-continuation.js';
import { inheritWorkflowConfigMetadata, translateWorkflowConfigError } from '../../../shared/workflowConfigMetadata.js';
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
const FIX_STEP_NAME = 'fix';

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
  private maxSteps: WorkflowMaxSteps;
  private loopDetector: LoopDetector;
  private cycleDetector: CycleDetector;
  private reportDir: string;
  private runPaths: RunPaths;
  private abortRequested = false;
  private readonly sharedRuntime: WorkflowSharedRuntimeState;
  private readonly resumeStackPrefix: WorkflowResumePointEntry[];
  private activeResumePoint: WorkflowResumePoint | undefined;
  private readonly resumeContinuation: WorkflowResumeContinuation;
  private readonly findingLedgerStore?: FindingLedgerStore;
  private readonly findingContract?: FindingContractConfig;
  private readonly findingManagerAuthority: FindingManagerAuthority;
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
    const initialMaxSteps = this.options.maxStepsOverride ?? this.config.maxSteps;
    const findingContractConfigured = options.inheritedFindingContract?.contract
      ?? this.config.findingContract;
    if (
      findingContractConfigured !== undefined
      && (
        initialMaxSteps === 'infinite'
        || options.ignoreIterationLimit === true
      )
    ) {
      throw new Error(
        'Finding Contract execution requires finite maxSteps and cannot ignore the iteration limit',
      );
    }
    ensureRunDirsExist(runPaths);
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
    restoreActiveResumePoint(
      this.sharedRuntime,
      this.options.resumePoint,
      this.options.initialIteration,
    );
    this.sharedRuntime.workflowCallInvocationEvidence.index.validateResumePoint(this.options.resumePoint);
    this.sharedRuntime.maxSteps ??= initialMaxSteps;
    this.maxSteps = this.sharedRuntime.maxSteps;
    if (findingContractConfigured !== undefined && this.maxSteps === 'infinite') {
      throw new Error(
        'Finding Contract execution requires a finite shared maxSteps value',
      );
    }
    this.resumeStackPrefix = this.options.resumeStackPrefix ?? [];
    this.runPaths = runPaths;
    this.reportDir = this.runPaths.reportsRel;
    applyRuntimeEnvironment(this.cwd, this.config, 'init');
    try {
      validateWorkflowConfig(this.config, this.options);
    } catch (error) {
      throw translateWorkflowConfigError(this.config, error);
    }

    this.state = createInitialState(this.config, this.options);
    this.resumeContinuation = new WorkflowResumeContinuation(
      this.config,
      this.options.resumePoint,
    );
    this.syncStateDynamicParallelSelections();
    this.inheritPreviousReviewReports();
    // workflow_call の親から継承した Finding Contract があればそれを優先する。
    // 継承しないと子の parallel レビューが出す raw findings が親の台帳に届かず、
    // fix ステップへ渡らないまま reviewers ↔ fix が回り続ける（実測: 56周・9時間）。
    // 親から継承した authority がある場合は、子の契約定義より優先する。
    this.findingContract = this.options.inheritedFindingContract?.contract ?? this.config.findingContract;
    this.findingManagerAuthority =
      this.options.inheritedFindingContract?.managerAuthority ?? 'standard';
    if (this.options.inheritedFindingContract !== undefined) {
      // 継承時は親と同一の FindingLedgerStore インスタンスをそのまま使う。
      this.findingLedgerStore = this.options.inheritedFindingContract.ledgerStore;
    } else if (this.findingContract !== undefined) {
      if (this.options.findingAuthorityResolver === undefined) {
        throw new Error(
          'Finding Contract requires an injected Finding authority resolver',
        );
      }
      this.findingLedgerStore = this.options.findingAuthorityResolver.resolve({
        workflowConfig: this.config,
        runPaths: this.runPaths,
        runPathNamespace: this.options.runPathNamespace ?? [],
        ...(this.options.workflowCallSiteIdentity === undefined
          ? {}
          : {
              workflowCallSiteIdentity:
                this.options.workflowCallSiteIdentity,
            }),
      });
    }
    if (this.findingLedgerStore !== undefined) {
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
      getMaxSteps: () => this.maxSteps,
      options: this.options,
      structuredCaller: this.structuredCaller,
      sharedRuntime: this.sharedRuntime,
      resumeStackPrefix: this.resumeStackPrefix,
      getCurrentWorkflowStack: () => this.activeResumePoint?.stack,
      runPaths: this.runPaths,
      updateMaxSteps: (maxSteps) => {
        this.maxSteps = maxSteps;
        this.sharedRuntime.maxSteps = maxSteps;
      },
      claimStepOccurrence: (step, resumeStackPrefix) => (
        this.resumeContinuation.claimStepOccurrence({
          step,
          resumeStackPrefix,
          state: this.state,
        })
      ),
      consumeWorkflowCallContinuation: (step, occurrence, resumeStackPrefix) => (
        this.resumeContinuation.consumeWorkflowCallFrame({
          step,
          occurrence,
          resumeStackPrefix,
        })
      ),
      setActiveResumePoint: this.setActiveResumePoint.bind(this),
      persistDynamicParallelSelection: this.persistDynamicParallelSelection.bind(this),
      refreshFindingsState: this.refreshFindingsState.bind(this),
      findingContract: this.findingContract,
      findingManagerAuthority: this.findingManagerAuthority,
      findingLedgerStore: this.findingLedgerStore,
      updatePersonaSession: this.updatePersonaSession.bind(this),
      resolveNextStepFromDone: this.resolveNextStepFromDone.bind(this),
      resetCycleDetector: () => this.cycleDetector.reset(),
      emitEvent: (event, ...args) => this.emitEvent(event, ...args),
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
      emitReport: (step, filePath, fileName, context) => this.emit(
        'step:report',
        step,
        filePath,
        fileName,
        context,
      ),
      recordParticipation: (step, reportNames) => {
        this.sharedRuntime.workflowStepParticipationIndex!.record(
          this.config,
          step.name,
          this.resumeStackPrefix,
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
          analyticsWorkflowName: this.config.name,
          findingScopeIdentity: this.findingLedgerStore.ledgerIdentity,
          runId: this.runPaths.slug,
          refreshFindingsState: this.refreshFindingsState.bind(this),
          emitEvent: (event, ...args) => this.emitEvent(event, ...args),
          guidance: this.findingContract.adjudicator?.instruction,
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
          getFindingScopeIdentity: () => this.findingLedgerStore?.ledgerIdentity,
          getFindingIds: () => this.findingLedgerStore
            ?.loadLedger()
            .findings
            .map((finding) => finding.id),
          getTask: () => this.task,
          getRoutingFindings: () => buildRoutingFindings(this.findingLedgerStore?.loadLedger()),
          getCurrentWorkflowStack: () => this.activeResumePoint?.stack,
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
          cycleDetectorRecordAndCheck: (stepName, nextStep) => this.cycleDetector.recordAndCheck(stepName, nextStep),
          resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
          runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
          runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
          runQualityGates,
          persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
          buildInstruction: this.stepCoordinator.buildInstruction.bind(this.stepCoordinator),
          buildPhase1Instruction: this.stepCoordinator.buildPhase1Instruction.bind(this.stepCoordinator),
          prepareNormalStepExecution: this.stepCoordinator.prepareNormalStepExecution.bind(this.stepCoordinator),
          resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
          resolveStepProviderModelBeforeAutoRouting: (step, runtime) => this.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(step, runtime),
          resolveRuntimeForStep: this.stepCoordinator.resolveRuntimeForStep.bind(this.stepCoordinator),
          claimStepOccurrence: (step) => (
            this.resumeContinuation.claimStepOccurrence({
              step,
              resumeStackPrefix: this.resumeStackPrefix,
              state: this.state,
            })
          ),
          setActiveStep: this.activateStep.bind(this),
          cancelPendingStepActivation: () => this.workflowCallRunner.cancelPendingInvocation(),
          addUserInput: this.addUserInput.bind(this),
          emit: (event, ...args) => this.emitEvent(event, ...args),
          updateMaxSteps: (maxSteps) => {
            this.maxSteps = maxSteps;
            this.sharedRuntime.maxSteps = maxSteps;
          },
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
      effectiveMaxSteps: this.maxSteps,
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
    this.emit(event, ...args);
  }

  private refreshFindingsState(): void {
    if (!this.findingLedgerStore) {
      return;
    }
    const presentationCounts = new Map<string, number>();
    for (const publication of listFindingReviewPublications(this.runPaths.reportsAbs)) {
      if (publication.presentationContext?.revision !== 2) {
        continue;
      }
      for (const anomalyId of publication.presentationContext.presentedReviewerAnomalyIds) {
        presentationCounts.set(anomalyId, (presentationCounts.get(anomalyId) ?? 0) + 1);
      }
    }
    this.state.findings = buildFindingsRuleContext(
      this.findingLedgerStore.loadLedger(),
      this.cwd,
      presentationCounts,
    );
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
      (finding) => finding.status === 'open'
        && finding.provisional !== undefined,
    );
  }

  /** Human-readable bullet lines for open provisional findings. */
  private formatProvisionalFindingItems(provisionals: readonly FindingLedgerEntry[]): string[] {
    return provisionals.map(
      (finding) => `- ${finding.id} [${finding.provisional!.kind}]: ${finding.provisional!.reason}`,
    );
  }

  /** 二系統台帳（review-integrity protocol）の未決着 anomaly。 */
  private loadOutstandingReviewerAnomalies(ledger: FindingLedger): ReviewerAnomalyEntry[] {
    return (ledger.reviewerAnomalies ?? []).filter(isOutstandingReviewerAnomaly);
  }

  /**
   * COMPLETE 遷移直前のエンジン最終不変条件。2つの独立したゲートを見る:
   *
   * 1. product gate: open な provisional finding（意味を確定
   *    できなかった観測）が1件でも残っていれば COMPLETE を拒否する。
   *
   * 2. review-integrity gate（review-integrity requirement）: 未昇格かつ未settleの
   *    reviewer anomaly が1件でも残っていれば COMPLETE を拒否する。
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
  private intakeReviewIntegrityFailure(
    anomalies: readonly ReviewerAnomalyEntry[],
  ): {
    reason: string;
    failure: import('../types.js').WorkflowStepFailureSummary;
  } | undefined {
    const intakeAnomalies = anomalies.filter((anomaly) => (
      anomaly.kind === 'intake-contract-incomplete'
      && anomaly.intakeContract !== undefined
    ));
    if (intakeAnomalies.length === 0) {
      return undefined;
    }
    const publications = listFindingReviewPublications(this.runPaths.reportsAbs);
    const presentationCounts = new Map<string, number>();
    const publicationIdsByAnomalyId = new Map<string, string[]>();
    for (const publication of publications) {
      if (publication.presentationContext?.revision !== 2) continue;
      for (const anomalyId of publication.presentationContext.presentedReviewerAnomalyIds) {
        presentationCounts.set(anomalyId, (presentationCounts.get(anomalyId) ?? 0) + 1);
        const publicationIds = publicationIdsByAnomalyId.get(anomalyId) ?? [];
        if (!publicationIds.includes(publication.publicationId)) {
          publicationIds.push(publication.publicationId);
        }
        publicationIdsByAnomalyId.set(anomalyId, publicationIds);
      }
    }
    const unpresentedIds = intakeAnomalies
      .filter((anomaly) => (presentationCounts.get(anomaly.id) ?? 0) === 0)
      .map(({ id }) => id)
      .sort(compareBinaryStrings);
    const exhaustedIds = intakeAnomalies
      .filter((anomaly) => (
        anomaly.intakeContract!.terminalDisposition?.workflowOutcome === 'review_integrity_unresolved'
        || (anomaly.intakeContract!.observationClass === 'claim-bearing'
          && (presentationCounts.get(anomaly.id) ?? 0) >= anomaly.intakeContract!.presentationLimit)
      ))
      .map(({ id }) => id)
      .sort(compareBinaryStrings);
    if (unpresentedIds.length === 0 && exhaustedIds.length === 0) {
      return undefined;
    }
    const anomalyIds = intakeAnomalies.map(({ id }) => id).sort(compareBinaryStrings);
    const publicationIds = [...new Set(intakeAnomalies.flatMap(({ id }) => (
      publicationIdsByAnomalyId.get(id) ?? []
    )))].sort(compareBinaryStrings);
    const code = unpresentedIds.length > 0
      ? 'review_integrity_unresolved_unpresented' as const
      : 'restatement_exhausted_claim_bearing' as const;
    const reason = code === 'review_integrity_unresolved_unpresented'
      ? `Review-integrity reviewer anomaly restatement could not be presented for anomaly IDs: ${unpresentedIds.join(', ')}`
      : `Review-integrity reviewer anomaly restatement limit was exhausted for anomaly IDs: ${exhaustedIds.join(', ')}`;
    return {
      reason,
      failure: createRunFailure({
        kind: 'review_integrity_unresolved',
        step: this.state.currentStep,
        reason,
        error: reason,
        details: {
          reviewIntegrity: {
            code,
            anomalyIds,
            unpresentedIds,
            classificationAuthorityIds: [...new Set(intakeAnomalies.map(
              ({ intakeContract }) => intakeContract!.classificationAuthorityId,
            ))].sort(compareBinaryStrings),
            publicationIds,
          },
        },
      }),
    };
  }

  private checkCompletionGate(): {
    ok: true;
  } | {
    ok: false;
    reason: string;
    abortKind?: WorkflowAbortKind;
    failure?: import('../types.js').WorkflowStepFailureSummary;
  } {
    if (!this.findingLedgerStore) {
      return { ok: true };
    }
    const ledger = this.findingLedgerStore.loadLedger();
    const provisionals = this.loadOpenProvisionalFindings(ledger);
    const anomalies = this.loadOutstandingReviewerAnomalies(ledger);
    const intakeFailure = this.intakeReviewIntegrityFailure(anomalies);
    if (intakeFailure !== undefined) {
      return {
        ok: false,
        reason: intakeFailure.reason,
        abortKind: 'review_integrity_unresolved',
        failure: intakeFailure.failure,
      };
    }
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
  private checkReviewIntegrityGate(): {
    ok: true;
  } | {
    ok: false;
    reason: string;
    abortKind?: WorkflowAbortKind;
    failure?: import('../types.js').WorkflowStepFailureSummary;
  } {
    if (!this.findingLedgerStore) {
      return { ok: true };
    }
    const anomalies = this.loadOutstandingReviewerAnomalies(this.findingLedgerStore.loadLedger());
    const intakeFailure = this.intakeReviewIntegrityFailure(anomalies);
    if (intakeFailure !== undefined) {
      return {
        ok: false,
        reason: intakeFailure.reason,
        abortKind: 'review_integrity_unresolved',
        failure: intakeFailure.failure,
      };
    }
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
    const inheritanceOptions = {
      cwd: this.cwd,
      sourceRunSlug: resumeSource.sourceRunSlug,
      currentRunSlug: this.runPaths.slug,
      targetReportDirectory: this.runPaths.reportsAbs,
      reviewReportNames: reportNameResult.reportNames,
      discoveryFailures: recoverableFailures,
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
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
    dynamicParallelSelections: ReadonlyMap<string, import('../../models/types.js').DynamicParallelSelectionSnapshot> = this.sharedRuntime.dynamicParallelSelectionStore!.snapshot(),
  ): WorkflowResumePoint {
    const workflowCallInstance = isWorkflowCallStep(step)
      ? this.sharedRuntime.workflowCallInvocationEvidence!.index.get(
          this.config,
          step.name,
          resumeStackPrefix,
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
        ...resumeStackPrefix,
        buildWorkflowResumePointEntry(
          this.config,
          step.name,
          getWorkflowResumeFrameKind(step),
          occurrence,
          this.state.stepIterations,
          workflowCallInstance,
        ),
      ],
      iteration,
      elapsed_ms: Date.now() - this.sharedRuntime.startedAtMs,
      ...(dynamicParallelSelections.size === 0
        ? {}
        : { dynamic_parallel_selections: serializeDynamicParallelSelections(dynamicParallelSelections) }),
      workflow_call_invocations: workflowCallInvocations,
      workflow_step_participations: workflowStepParticipations,
    };
  }

  private setActiveResumePoint(
    step: WorkflowStep,
    iteration: number,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): void {
    this.syncStateDynamicParallelSelections();
    const activeResumePoint = this.buildResumePoint(
      step,
      iteration,
      occurrence,
      resumeStackPrefix,
    );
    this.activeResumePoint = activeResumePoint;
    this.sharedRuntime.activeResumePoint = activeResumePoint;
  }

  private activateStep(
    step: WorkflowStep,
    iteration: number,
    occurrence: number,
  ): WorkflowCallExecutionToken | undefined {
    if (isWorkflowCallStep(step)) {
      return this.workflowCallRunner.activateInvocation(
        step,
        iteration,
        occurrence,
        this.resumeStackPrefix,
      );
    }
    this.workflowCallRunner.cancelPendingInvocation();
    this.setActiveResumePoint(step, iteration, occurrence, this.resumeStackPrefix);
    return undefined;
  }

  private async persistDynamicParallelSelection(
    step: WorkflowStep,
    iteration: number,
    identity: string,
    selection: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ): Promise<void> {
    const activeEntry = this.activeResumePoint?.stack[this.resumeStackPrefix.length];
    if (
      activeEntry === undefined
      || activeEntry.step !== step.name
      || !workflowEntryMatchesWorkflow(activeEntry, this.config)
    ) {
      throw new Error(`Cannot persist dynamic parallel selection without an active resume frame for step '${step.name}'`);
    }
    const selections = await this.sharedRuntime.dynamicParallelSelectionStore!.commit(identity, selection, async (selections) => {
      const resumePoint = this.buildResumePoint(
        step,
        iteration,
        activeEntry.occurrence,
        this.resumeStackPrefix,
        selections,
      );
      await this.options.onDynamicParallelSelectionPersisted?.(resumePoint);
      this.activeResumePoint = resumePoint;
      this.sharedRuntime.activeResumePoint = resumePoint;
    });
    this.syncStateDynamicParallelSelections(selections);
  }

  getResumePoint(): WorkflowResumePoint | undefined {
    const activeResumePoint = this.sharedRuntime.activeResumePoint;
    const activeEntry = activeResumePoint?.stack[this.resumeStackPrefix.length];
    if (activeResumePoint === undefined || activeEntry === undefined) {
      return activeResumePoint;
    }
    if (activeResumePoint.stack.length > this.resumeStackPrefix.length + 1) {
      return activeResumePoint;
    }
    const stack = [...activeResumePoint.stack];
    const activeStep = this.config.steps.find((step) => step.name === activeEntry.step);
    const workflowCallInstance = activeStep !== undefined && isWorkflowCallStep(activeStep)
      ? this.sharedRuntime.workflowCallInvocationEvidence!.index.get(
          this.config,
          activeStep.name,
          this.resumeStackPrefix,
        )?.call_instance
      : undefined;
    stack[this.resumeStackPrefix.length] = buildWorkflowResumePointEntry(
      this.config,
      activeEntry.step,
      activeEntry.kind,
      activeEntry.occurrence,
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
    this.sharedRuntime.activeResumePoint = refreshedResumePoint;
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
    if (step === undefined) {
      return undefined;
    }
    const nextOccurrence = (this.state.stepIterations.get(stepName) ?? 0) + 1;
    return this.buildResumePoint(
      step,
      this.state.iteration,
      nextOccurrence,
      this.resumeStackPrefix,
    );
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
    const interruptReason = this.abortRequested
      ? 'Workflow interrupted by user (SIGINT)'
      : this.options.abortSignal?.aborted === true
        ? 'Workflow interrupted by external AbortSignal'
        : undefined;
    const kind: WorkflowAbortKind = interruptReason === undefined ? 'runtime_error' : 'interrupt';
    const errorMessage = getErrorMessage(error);
    const reason = interruptReason ?? ERROR_MESSAGES.STEP_EXECUTION_FAILED(errorMessage);
    const failure = createRunFailure({
      kind,
      step: this.state.currentStep,
      reason,
      error: interruptReason ?? errorMessage,
    });
    return {
      status: 'error',
      abortKind: kind,
      abortReason: failure.reason,
      failure,
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
    await this.initializeFindingContract();
    return this.runWithSystemCleanup(
      () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('single_iteration'),
        () => runSingleWorkflowIteration({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getFindingScopeIdentity: () => this.findingLedgerStore?.ledgerIdentity,
          getFindingIds: () => this.findingLedgerStore
            ?.loadLedger()
            .findings
            .map((finding) => finding.id),
          getTask: () => this.task,
          getRoutingFindings: () => buildRoutingFindings(this.findingLedgerStore?.loadLedger()),
          getCurrentWorkflowStack: () => this.activeResumePoint?.stack,
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
          cycleDetectorRecordAndCheck: (stepName, nextStep) => this.cycleDetector.recordAndCheck(stepName, nextStep),
          resolveDoneTransition: this.stepCoordinator.resolveTransitionFromDone.bind(this.stepCoordinator),
          runLoopMonitorJudge: this.stepCoordinator.runLoopMonitorJudge.bind(this.stepCoordinator),
          runStep: this.stepCoordinator.runStep.bind(this.stepCoordinator),
          runQualityGates,
          persistPreviousResponseSnapshot: this.stepExecutor.persistPreviousResponseSnapshot.bind(this.stepExecutor),
          buildInstruction: this.stepCoordinator.buildInstruction.bind(this.stepCoordinator),
          buildPhase1Instruction: this.stepCoordinator.buildPhase1Instruction.bind(this.stepCoordinator),
          prepareNormalStepExecution: this.stepCoordinator.prepareNormalStepExecution.bind(this.stepCoordinator),
          resolveStepProviderModel: (step, runtime) => this.optionsBuilder.resolveStepProviderModel(step, runtime),
          resolveStepProviderModelBeforeAutoRouting: (step, runtime) => this.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(step, runtime),
          resolveRuntimeForStep: this.stepCoordinator.resolveRuntimeForStep.bind(this.stepCoordinator),
          claimStepOccurrence: (step) => (
            this.resumeContinuation.claimStepOccurrence({
              step,
              resumeStackPrefix: this.resumeStackPrefix,
              state: this.state,
            })
          ),
          setActiveStep: this.activateStep.bind(this),
          cancelPendingStepActivation: () => this.workflowCallRunner.cancelPendingInvocation(),
          addUserInput: this.addUserInput.bind(this),
          emit: (event, ...args) => this.emitEvent(event, ...args),
          updateMaxSteps: () => {},
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
      ),
      (result, error) => error !== undefined || result?.isComplete === true || this.state.status !== 'running',
    );
  }
}

function restoreActiveResumePoint(
  sharedRuntime: WorkflowSharedRuntimeState,
  resumePoint: WorkflowResumePoint | undefined,
  initialIteration: number | undefined,
): void {
  if (resumePoint === undefined) {
    return;
  }

  const restored = cloneWorkflowResumePoint(resumePoint);
  const current = sharedRuntime.activeResumePoint === undefined
    ? undefined
    : cloneWorkflowResumePoint(sharedRuntime.activeResumePoint);
  restored.iteration = Math.max(
    restored.iteration,
    initialIteration ?? restored.iteration,
    current?.iteration ?? restored.iteration,
  );
  restored.elapsed_ms = Math.max(restored.elapsed_ms, current?.elapsed_ms ?? restored.elapsed_ms);

  if (current !== undefined) {
    restored.workflow_call_invocations = current.workflow_call_invocations;
    restored.workflow_step_participations = current.workflow_step_participations;
    if (current.dynamic_parallel_selections === undefined) {
      delete restored.dynamic_parallel_selections;
    } else {
      restored.dynamic_parallel_selections = current.dynamic_parallel_selections;
    }
  }

  sharedRuntime.activeResumePoint = restored;
}
