import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { ProviderNeutralStructuredCaller, type StructuredCaller } from '../../../agents/structured-caller.js';
import { createWorkRequirementEstimator } from '../../../agents/auto-routing-usecase.js';
import { createLogger, generateReportDir, getErrorMessage, isValidReportDirName } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { WorkflowRestartPointSchema } from '../../models/workflow-resume-schema.js';
import { cloneDynamicParallelSelections } from '../dynamic-parallel/snapshot.js';
import { cloneWorkflowResumePoint, parseWorkflowResumePoint } from '../resume-point-codec.js';
import { DynamicParallelSelectionStore } from '../dynamic-parallel/selection-store.js';
import { DynamicFacetSelectionStore, cloneDynamicFacetSelections } from '../dynamic-facets/dynamicFacetSelectionStore.js';
import {
  restoreWorkflowCallInvocationEvidence,
  serializeWorkflowCallInvocationEvidence,
  snapshotWorkflowCallInvocationEvidence,
} from '../workflow-call-invocation-index.js';
import { CompanionReviewAuthority } from '../companion/review-state-store.js';
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
import { withWorkflowTargetContext } from '../provider-target-resolution.js';
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
    ...(state.companion === undefined
      ? {}
      : {
          companion: {
            ...state.companion,
            openMustFix: state.companion.openMustFix.map((finding) => ({ ...finding })),
          },
        }),
    dynamicParallelSelections: cloneDynamicParallelSelections(state.dynamicParallelSelections),
    dynamicFacetSelections: cloneDynamicFacetSelections(state.dynamicFacetSelections),
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

  private readonly optionsBuilder: WorkflowEngineServices['optionsBuilder'];
  private readonly stepExecutor: WorkflowEngineServices['stepExecutor'];
  private readonly parallelRunner: WorkflowEngineServices['parallelRunner'];
  private readonly arpeggioRunner: WorkflowEngineServices['arpeggioRunner'];
  private readonly teamLeaderRunner: WorkflowEngineServices['teamLeaderRunner'];
  private readonly systemStepExecutor: WorkflowEngineServices['systemStepExecutor'];
  private readonly loopMonitorJudgeRunner: WorkflowEngineServices['loopMonitorJudgeRunner'];
  private readonly workflowCallRunner: WorkflowEngineServices['workflowCallRunner'];
  private readonly stepAbortSignalContext: WorkflowEngineServices['stepAbortSignalContext'];
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
    this.config = config;
    inheritWorkflowConfigMetadata(config, this.config);
    const restartNavigator = restartPoint === undefined
      ? undefined
      : new WorkflowRestartNavigator(restartPoint);
    const restartStartStep = restartNavigator?.resolveRootStartStep(
      this.config,
      options.startStep,
    );
    assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);
    this.structuredCaller = options.structuredCaller ?? new ProviderNeutralStructuredCaller();
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
    const effectiveAutoRouting = withWorkflowTargetContext(
      applyAutoRoutingStrategyOverride(inheritedAutoRouting, options.autoStrategyOverride),
      config.name,
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
        failureDir: join(runPaths.runRootAbs, 'failures'),
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
      providerRouting: withWorkflowTargetContext(options.providerRouting, config.name),
      providerLadders: withWorkflowTargetContext(options.providerLadders, config.name),
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
    this.sharedRuntime.dynamicParallelSelectionStore ??= new DynamicParallelSelectionStore(new Map());
    this.sharedRuntime.dynamicFacetSelectionStore ??= new DynamicFacetSelectionStore(new Map());
    this.sharedRuntime.workflowCallInvocationEvidence ??=
      restoreWorkflowCallInvocationEvidence(this.options.resumePoint);
    this.sharedRuntime.workflowStepParticipationIndex ??=
      restoreWorkflowStepParticipationIndex(this.options.resumePoint);
    this.sharedRuntime.companionReviewAuthority ??= new CompanionReviewAuthority();
    restoreActiveResumePoint(
      this.sharedRuntime,
      this.options.resumePoint,
      this.options.initialIteration,
    );
    this.sharedRuntime.workflowCallInvocationEvidence.index.validateResumePoint(this.options.resumePoint);
    this.sharedRuntime.maxSteps ??= initialMaxSteps;
    this.maxSteps = this.sharedRuntime.maxSteps;
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
    this.syncStateDynamicFacetSelections();
    this.inheritPreviousReviewReports();
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
      commitDynamicParallelSelection: this.commitDynamicParallelSelection.bind(this),
      commitDynamicFacetSelection: this.commitDynamicFacetSelection.bind(this),
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
    this.stepAbortSignalContext = services.stepAbortSignalContext;
    this.stepCoordinator = new WorkflowEngineStepCoordinator({
      config: this.config,
      state: this.state,
      task: this.task,
      getMaxSteps: () => this.maxSteps,
      getOptions: () => this.options,
      optionsBuilder: this.optionsBuilder,
      stepAbortSignalContext: this.stepAbortSignalContext,
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
      recordParticipation: (step, reportNames, parallelParentStepName) => {
        this.sharedRuntime.workflowStepParticipationIndex!.record(
          this.config,
          step.name,
          this.resumeStackPrefix,
          reportNames,
          parallelParentStepName,
        );
      },
    });
    workflowRunExecutors.set(this, async () => {
      return this.runWithSystemCleanup(
        () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('full'),
        () => runWorkflowToCompletion({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getTask: () => this.task,
          getCurrentWorkflowStack: () => this.activeResumePoint?.stack,
          getCwd: () => this.cwd,
          getMaxSteps: () => this.maxSteps,
          getReportDir: () => this.runPaths.reportsAbs,
          abortRequested: () => this.abortRequested,
          getStep: this.stepCoordinator.getStep.bind(this.stepCoordinator),
          beginStepDeadline: this.stepCoordinator.beginStepDeadline.bind(this.stepCoordinator),
          disposeStepDeadline: this.stepCoordinator.disposeStepDeadline.bind(this.stepCoordinator),
          disposeAllStepDeadlines: this.stepCoordinator.disposeAllStepDeadlines.bind(this.stepCoordinator),
          stepAbortSignalContext: this.stepAbortSignalContext,
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
      workflowCallInvocations: snapshotWorkflowCallInvocationEvidence(
        this.sharedRuntime.workflowCallInvocationEvidence!,
      ),
      workflowStepParticipations: this.sharedRuntime.workflowStepParticipationIndex!.snapshot(),
      dynamicParallelSelections: this.sharedRuntime.dynamicParallelSelectionStore!.snapshot(),
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

  private async commitDynamicParallelSelection(
    identity: string,
    selection: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ): Promise<void> {
    const selections = await this.sharedRuntime.dynamicParallelSelectionStore!.commit(identity, selection);
    this.sharedRuntime.workflowStepParticipationIndex!.clearParallelParticipants(
      this.config,
      selection.step_name,
      this.resumeStackPrefix,
    );
    this.syncStateDynamicParallelSelections(selections);
  }

  private async commitDynamicFacetSelection(
    identity: string,
    selection: import('../../models/types.js').DynamicFacetSelectionSnapshot,
  ): Promise<void> {
    const selections = await this.sharedRuntime.dynamicFacetSelectionStore!.commit(identity, selection);
    this.syncStateDynamicFacetSelections(selections);
  }

  private syncStateDynamicFacetSelections(
    selections = this.sharedRuntime.dynamicFacetSelectionStore!.snapshot(),
  ): void {
    this.state.dynamicFacetSelections.clear();
    for (const [identity, selection] of selections) {
      this.state.dynamicFacetSelections.set(identity, selection);
    }
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
    const workflowCallInvocations = serializeWorkflowCallInvocationEvidence(
      this.sharedRuntime.workflowCallInvocationEvidence!,
    );
    const workflowStepParticipations =
      this.sharedRuntime.workflowStepParticipationIndex!.serialized();
    const refreshedResumePoint = {
      ...activeResumePoint,
      stack,
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
    return this.runWithSystemCleanup(
      () => runWithWorkflowSpan(
        this.buildWorkflowSpanParams('single_iteration'),
        () => runSingleWorkflowIteration({
          state: this.state,
          options: this.options,
          getWorkflowName: () => this.config.name,
          getTask: () => this.task,
          getCurrentWorkflowStack: () => this.activeResumePoint?.stack,
          getCwd: () => this.cwd,
          getMaxSteps: () => this.maxSteps,
          getReportDir: () => this.runPaths.reportsAbs,
          abortRequested: () => this.abortRequested,
          getStep: this.stepCoordinator.getStep.bind(this.stepCoordinator),
          beginStepDeadline: this.stepCoordinator.beginStepDeadline.bind(this.stepCoordinator),
          disposeStepDeadline: this.stepCoordinator.disposeStepDeadline.bind(this.stepCoordinator),
          disposeAllStepDeadlines: this.stepCoordinator.disposeAllStepDeadlines.bind(this.stepCoordinator),
          stepAbortSignalContext: this.stepAbortSignalContext,
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
  }

  sharedRuntime.activeResumePoint = restored;
}
