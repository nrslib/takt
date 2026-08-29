import { WorkflowEngine, createDenyAskUserQuestionHandler } from '../../../core/workflow/index.js';
import { join } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowExecutionResult, WorkflowExecutionOptions } from './types.js';
import { createDefaultSystemStepServices } from '../../../infra/workflow/system/DefaultSystemStepServices.js';
import { createDefaultStructuredOutputNormalizers } from '../../../infra/workflow/structured-output/followup-task-normalizer.js';
import { AbortHandler } from './abortHandler.js';
import { createIterationLimitHandler, createUserInputHandler } from './iterationLimitHandler.js';
import {
  createWorkflowExecutionBootstrap,
  resolveWorkflowExecutionResumeLineage,
  resolveWorkflowExecutionResumeSourceLineage,
  type WorkflowExecutionBootstrap,
  type WorkflowExecutionResumeLineage,
} from './workflowExecutionBootstrap.js';
import {
  OperationLineageUnavailableError,
} from '../../../core/workflow/operations/operation-recovery-error.js';
import {
  createWorkflowExecutionContext,
  createWorkflowCallResolver,
} from './workflowExecutionContext.js';
import {
  bindWorkflowExecutionEvents,
  type WorkflowExecutionEventBridge,
} from './workflowExecutionEvents.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import type { StreamEvent } from '../../../shared/types/provider.js';
import {
  OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  resolveOtlpExporterConfig,
  pickNestedOtelExporterOptionEnv,
} from '../../../shared/telemetry/index.js';
import type { GitProvider } from '../../../infra/git/index.js';
import type { WorkflowAbortKind } from '../../../core/workflow/types.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import {
  createSessionLog,
  initNdjsonLog,
} from '../../../infra/fs/index.js';
import { USAGE_MISSING_REASONS } from '../../../core/logging/contracts.js';
import { createPullRequestContext } from '../../../core/workflow/pr-context.js';
import {
  createWorkflowRunLifecycle,
  type WorkflowRunHandle,
} from './workflowRunLifecycle.js';
import {
  RunCleanupError,
  RunLiveDeliveryError,
  type RunFinalizationIssue,
  type WorkflowRunExecutionControl,
  type WorkflowRunExecutionHandle,
} from './workflowRunExecution.js';
import {
  type WorkflowRunTerminalStatus,
} from './workflowTerminalStatus.js';
import {
  createWorkflowTerminalPayloadFactory,
  type WorkflowTerminalPayloadFactory,
  type WorkflowTerminalPublicationPayload,
  requireTerminalReason,
} from './workflowTerminalPayload.js';
import {
  reportWorkflowCompletion,
  reportWorkflowFailure,
} from './workflowExecutionReporting.js';
import { stageTaskSpecForExecution } from './taskSpecContext.js';
import { GitSelectorCommandRunner } from '../../../infra/task/selector-git-command-runner.js';
import { GitCompanionDiffReader } from '../../../infra/task/companion-git-diff-reader.js';
import {
  loadWorkflowExecutionBundle,
  prepareWorkflowExecutionBundle,
  publishWorkflowExecutionBundle,
} from './workflowExecutionBundle.js';
import { scheduleLoopAnalysis } from './loopAnalysis.js';
import { buildChildProcessEnv } from '../../../shared/utils/child-process-env.js';

export type { WorkflowExecutionResult, WorkflowExecutionOptions };

export type WorkflowRunContext = {
  ignoreIterationLimit?: boolean;
  gitProvider?: GitProvider;
};

function serializeObservabilityForNestedRuns(observability: {
  enabled: boolean;
  monitor: boolean;
  sessionLogExporter: boolean;
  usageEventsPhase: boolean;
}): string {
  return JSON.stringify({
    enabled: observability.enabled,
    monitor: observability.monitor,
    session_log_exporter: observability.sessionLogExporter,
    usage_events_phase: observability.usageEventsPhase,
  });
}

function resolveNestedChildProcessEnv(observability: {
  enabled: boolean;
  monitor: boolean;
  sessionLogExporter: boolean;
  usageEventsPhase: boolean;
}, env: NodeJS.ProcessEnv): Readonly<Record<string, string>> | undefined {
  if (!observability.enabled) {
    return undefined;
  }

  const childProcessEnv: Record<string, string> = {
    TAKT_OBSERVABILITY: serializeObservabilityForNestedRuns(observability),
    ...pickNestedOtelExporterOptionEnv(env),
  };
  const otlpConfig = resolveOtlpExporterConfig({
    observabilityEnabled: observability.enabled,
    env,
  });

  if (otlpConfig.enabled) {
    childProcessEnv[OTEL_EXPORTER_OTLP_ENDPOINT] = otlpConfig.endpoint;
    childProcessEnv[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT] = otlpConfig.traces.endpoint;
    childProcessEnv[OTEL_EXPORTER_OTLP_METRICS_ENDPOINT] = otlpConfig.metrics.endpoint;
  }

  return childProcessEnv;
}

function resolveCurrentTaskContext(options: WorkflowExecutionOptions, runSlug: string) {
  return {
    issueNumber: options.currentTaskIssueNumber,
    runSlug,
  };
}

function requireFiniteWorkflowMaxSteps(workflowConfig: WorkflowConfig): number {
  if (typeof workflowConfig.maxSteps !== 'number') {
    throw new Error('Iteration limit handling requires finite workflow maxSteps');
  }
  return workflowConfig.maxSteps;
}

function resolvePhase1ProcessSafetyByStep(
  workflowConfig: WorkflowConfig,
  parentRunPid: number,
): Record<string, { protectedParentRunPid: number }> | undefined {
  if (
    workflowConfig.name !== 'takt-default'
    || !workflowConfig.steps.some((step) => step.name === 'implement')
  ) {
    return undefined;
  }

  return {
    implement: {
      protectedParentRunPid: parentRunPid,
    },
  };
}

export async function executeWorkflow(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
): Promise<WorkflowExecutionResult> {
  return executeWorkflowInternal(workflowConfig, task, cwd, options);
}

export async function executeWorkflowForRun(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
  runContext?: WorkflowRunContext,
): Promise<WorkflowExecutionResult> {
  return executeWorkflowInternal(workflowConfig, task, cwd, options, runContext);
}

function assertTaskSpecRunIdentity(
  options: WorkflowExecutionOptions,
): void {
  if (
    options.taskSpec !== undefined
    && options.reportDirName !== options.taskSpec.runSlug
  ) {
    throw new Error(
      `Task spec run "${options.taskSpec.runSlug}" requires matching reportDirName`,
    );
  }
}

async function executeWorkflowInternal(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
  runContext?: WorkflowRunContext,
): Promise<WorkflowExecutionResult> {
  assertTaskSpecRunIdentity(options);
  const prContext = options.prContext === undefined
    ? undefined
    : createPullRequestContext(options.prContext);
  const executionOptions = prContext === undefined
    ? options
    : { ...options, prContext };
  const parentRunPid = process.pid;
  const liveWorkflowCallResolver = createWorkflowCallResolver(
    createWorkflowExecutionContext(
      workflowConfig,
      options.projectCwd,
      options.workflowResourceRoot,
    ),
  );
  const preparedBundle = prepareWorkflowExecutionBundle({
    rootWorkflow: workflowConfig,
    workflowCallResolver: liveWorkflowCallResolver,
    projectCwd: options.projectCwd,
    lookupCwd: cwd,
    centralExecution: options.runPathsDirectory !== undefined,
  });
  const runLifecycle = createWorkflowRunLifecycle({
    cwd,
    ...(options.runPathsDirectory === undefined ? {} : { runPathsDirectory: options.runPathsDirectory }),
  });
  const availableSourceLineage = resolveAvailableSourceLineage(
    cwd,
    options.resumeSource,
    options.runPathsDirectory,
  );
  const activeRun = await runLifecycle.lifecycle.beginRun({
    workflowConfig,
    task,
    ...(options.reportDirName === undefined
      ? {}
      : { requestedRunSlug: options.reportDirName }),
    ...(options.resumeSource === undefined
      ? {}
      : { resumeSource: options.resumeSource }),
  });
  const resumeLineage: WorkflowExecutionResumeLineage =
    availableSourceLineage ?? resolveWorkflowExecutionResumeLineage(
      cwd,
      activeRun.runSlug,
      options.resumeSource,
      options.runPathsDirectory,
    );
  const artifactResumeSource = resumeLineage.artifactResumeSource;
  const publishedResumeSource = resumeLineage.publishedResumeSource;
  let bootstrap: WorkflowExecutionBootstrap;
  try {
    publishWorkflowExecutionBundle(activeRun.runPaths, preparedBundle);
    const executionBundle = loadWorkflowExecutionBundle(activeRun.runPaths);
    const bundledWorkflowConfig = executionBundle.rootWorkflow;
    const workflowCallResolver = executionBundle.workflowCallResolver;
    if (options.taskSpec !== undefined) {
      stageTaskSpecForExecution(options.taskSpec, activeRun.runPaths);
    }
    bootstrap = await createWorkflowExecutionBootstrap(
      bundledWorkflowConfig,
      task,
      cwd,
      {
        ...executionOptions,
        workflowCallResolver,
      },
      activeRun.bootstrap,
      resumeLineage,
    );
  } catch (bootstrapError) {
    return terminalizeBootstrapFailure({
      activeRun,
      workflowConfig,
      task,
      projectCwd: options.projectCwd,
      ...(options.sessionStorageDirectory === undefined
        ? {}
        : { sessionStorageDirectory: options.sessionStorageDirectory }),
      primaryError: bootstrapError,
      resumeLineage,
      loopAnalysisScheduler: options.loopAnalysisScheduler,
    });
  }
  const executionBundle = loadWorkflowExecutionBundle(activeRun.runPaths);
  const workflowCallResolver = executionBundle.workflowCallResolver;
  const terminalPublicationContext = {
    runSlug: bootstrap.runSlug,
    projectCwd: options.projectCwd,
    ...(options.sessionStorageDirectory === undefined
      ? {}
      : { sessionStorageDirectory: options.sessionStorageDirectory }),
    task,
    workflowName: bootstrap.effectiveWorkflowConfig.name,
    sessionLog: bootstrap.sessionLog,
    sessionId: activeRun.bootstrap.sessionId,
    ndjsonLogPath: bootstrap.ndjsonLogPath,
    traceReportMode: bootstrap.traceReportMode,
    ...(bootstrap.promptLogPath === undefined
      ? {}
      : { promptLogPath: bootstrap.promptLogPath }),
    ...(bootstrap.traceDiscovery === undefined
      ? {}
      : { traceDiscovery: bootstrap.traceDiscovery }),
  };
  const terminalPayloads = createWorkflowTerminalPayloadFactory(
    terminalPublicationContext,
  );
  const phase1ProcessSafetyByStep = resolvePhase1ProcessSafetyByStep(bootstrap.effectiveWorkflowConfig, parentRunPid);
  let engine: WorkflowEngine | null = null;
  let eventBridge: WorkflowExecutionEventBridge | undefined;
  let runExecution: Pick<WorkflowRunExecutionHandle, 'run'> | undefined;
  let runExecutionControl: WorkflowRunExecutionControl | undefined;
  let abortHandler: AbortHandler | undefined;
  let primaryError: unknown;
  let latentAbortPrimary: WorkflowAbortError | undefined;
  const terminalizationErrors: unknown[] = [];
  const cleanupErrors: unknown[] = [];
  const finalizationIssues: RunFinalizationIssue[] = [];
  let executionResult: WorkflowExecutionResult | undefined;
  const buildResumePointForStep = (stepName: string) => {
    if (!engine || typeof engine.buildResumePointForStepName !== 'function') {
      return undefined;
    }
    return engine.buildResumePointForStepName(stepName);
  };
  const getLatestResumePoint = () => {
    if (!engine || typeof engine.getResumePoint !== 'function') {
      return undefined;
    }
    return engine.getResumePoint();
  };
  const iterationLimitHandler = createIterationLimitHandler(
    bootstrap.out,
    bootstrap.displayRef,
    bootstrap.shouldNotifyIterationLimit,
    (request) => {
      const workflowMaxSteps = workflowConfig.maxSteps === 'infinite'
        ? requireFiniteWorkflowMaxSteps(bootstrap.effectiveWorkflowConfig)
        : workflowConfig.maxSteps;
      const newMaxSteps = request.maxSteps + workflowMaxSteps;
      if (!Number.isSafeInteger(newMaxSteps)) {
        throw new Error('Cannot continue workflow because the next max steps limit exceeds the safe integer range');
      }
      const resumePoint = getLatestResumePoint()
        ?? buildResumePointForStep(request.currentStep)
        ?? eventBridge?.state.lastResumePoint;
      eventBridge!.state.exceededInfo = {
        currentStep: request.currentStep,
        newMaxSteps,
        currentIteration: request.currentIteration,
        ...(resumePoint ? { resumePoint } : {}),
      };
    },
  );
  const onIterationLimit = runContext?.ignoreIterationLimit === true
    ? undefined
    : iterationLimitHandler;
  const onUserInput = bootstrap.interactiveUserInput
    ? createUserInputHandler(bootstrap.out, bootstrap.displayRef)
    : undefined;
  const handleProviderStream = (event: StreamEvent): void => {
    bootstrap.streamHandler(event);
    eventBridge?.emitProviderOutput(event);
  };

  try {
    const executionBinding = await activeRun.bindExecution({
      workflowConfig: bootstrap.effectiveWorkflowConfig,
      ...(publishedResumeSource === undefined
        ? {}
        : { resumeSource: publishedResumeSource }),
      terminalPayloads,
    });
    const activeRunExecution = executionBinding.execution;
    runExecution = activeRunExecution;
    await activeRunExecution.run(async (executionControl) => {
      runExecutionControl = executionControl;
      abortHandler = new AbortHandler({
        externalSignal: options.abortSignal,
        internalController: executionControl,
        getEngine: () => engine,
      });
      const childProcessEnv = resolveNestedChildProcessEnv(
        bootstrap.observability,
        buildChildProcessEnv(),
      );
      engine = new WorkflowEngine(bootstrap.effectiveWorkflowConfig, cwd, task, {
        abortSignal: executionControl.signal,
        onStream: handleProviderStream,
        onProviderStream: (context, event) => {
          bootstrap.providerEventLogger.logEvent(context, event);
        },
        onDelegatedAgentUsage: (context, result) => {
          bootstrap.usageEventLogger.logUsageFor(context, {
            success: result.success,
            usage: result.usage ?? {
              usageMissing: true,
              reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
            },
          });
        },
        onUserInput,
        initialSessions: bootstrap.savedSessions,
        onSessionUpdate: bootstrap.sessionUpdateHandler,
        onIterationLimit,
        onAskUserQuestion: options.onAskUserQuestion ?? createDenyAskUserQuestionHandler(),
        ignoreIterationLimit: runContext?.ignoreIterationLimit === true,
        projectCwd: options.projectCwd,
        observability: bootstrap.observability,
        observabilityRunId: bootstrap.runSlug,
        sanitizeObservabilityText: bootstrap.sanitizeObservabilityText,
        childProcessEnv,
        language: options.language,
        provider: bootstrap.currentProvider,
        providerSource: bootstrap.currentProviderSource,
        model: bootstrap.configuredModel,
        modelSource: bootstrap.configuredModelSource,
        reportFallbackProvider: options.reportFallbackProvider,
        reportContentSanitizer: options.reportContentSanitizer,
        rateLimitFallback: bootstrap.rateLimitFallback,
        providerOptions: bootstrap.providerOptions,
        configProviderOptions: bootstrap.configProviderOptions,
        providerOptionsProviderSource: bootstrap.providerOptionsProviderSource,
        providerPermissionMode: bootstrap.providerPermissionMode,
        selectorProvider: bootstrap.selectorProvider,
        selectorGitCommandRunner: new GitSelectorCommandRunner(),
        companionDiffReader: new GitCompanionDiffReader(),
        autoRouting: bootstrap.autoRouting,
        autoStrategyOverride: bootstrap.autoStrategyOverride,
        onEffectiveAutoRoutingReached: bootstrap.onEffectiveAutoRoutingReached,
        providerOptionsSource: options.providerOptionsSource,
        providerOptionsOriginResolver: options.providerOptionsOriginResolver,
        personaProviders: bootstrap.personaProviders,
        providerRouting: bootstrap.providerRouting,
        providerLadders: bootstrap.providerLadders,
        internalAgentSeats: bootstrap.internalAgentSeats,
        companionEnabled: bootstrap.companionEnabled,
        companionReviewMode: bootstrap.companionReviewMode,
        companionFixPolicy: bootstrap.companionFixPolicy,
        companionProviders: bootstrap.companionProviders,
        providerRoutingTagConflictPolicy: bootstrap.providerRoutingTagConflictPolicy,
        providerProfiles: options.providerProfiles,
        mcpServers: options.mcpServers,
        mcpAssignment: bootstrap.mcpAssignment,
        interactive: bootstrap.interactiveUserInput,
        structuredCaller: bootstrap.structuredCaller,
        structuredOutputNormalizers: createDefaultStructuredOutputNormalizers(),
        startStep: options.startStep,
        retryNote: options.retryNote,
        resumePoint: options.resumePoint,
        restartPoint: options.restartPoint,
        resumeSource: artifactResumeSource,
        operationJournal: bootstrap.operationJournal,
        reportDirName: bootstrap.runSlug,
        ...(options.runPathsDirectory === undefined ? {} : { runPathsDirectory: options.runPathsDirectory }),
        taskPrefix: options.taskPrefix,
        taskColorIndex: options.taskColorIndex,
        initialIteration: options.initialIterationOverride,
        currentTask: resolveCurrentTaskContext(options, bootstrap.runSlug),
        traceTaskMetadata: options.traceTaskMetadata,
        prContext,
        phase1ProcessSafetyByStep,
        systemStepServicesFactory: (serviceOptions) => createDefaultSystemStepServices({
          ...serviceOptions,
          ...(runContext?.gitProvider !== undefined ? { gitProvider: runContext.gitProvider } : {}),
        }),
        workflowCallResolver,
        workflowBundleResourceRoot: executionBundle.resourceRoot,
      });

      eventBridge = bindWorkflowExecutionEvents({
        engine,
        workflowConfig: bootstrap.effectiveWorkflowConfig,
        currentProvider: bootstrap.currentProvider!,
        configuredModel: bootstrap.configuredModel,
        out: bootstrap.out,
        prefixWriter: bootstrap.prefixWriter,
        displayRef: bootstrap.displayRef,
        handlerRef: bootstrap.handlerRef,
        usageEventLogger: bootstrap.usageEventLogger,
        analyticsEmitter: bootstrap.analyticsEmitter,
        sessionLogger: bootstrap.sessionLogger,
        runMetaManager: bootstrap.runMetaManager,
        shouldNotifyRateLimit: bootstrap.shouldNotifyRateLimit,
        initialResumePoint: options.resumePoint,
        sessionLog: bootstrap.sessionLog,
        eventSink: options.eventSink,
        terminalPayloads,
      });

      eventBridge.emitRunStarted({
        type: 'run_started',
        runDirectory: bootstrap.runPaths.runRootAbs,
        reportDirectory: bootstrap.runPaths.reportsAbs,
        ndjsonLogPath: bootstrap.ndjsonLogPath,
      });

      abortHandler.install();
      const finalState = await engine.run();
      await eventBridge.flushEventSink();
      executionResult = {
        success: finalState.status === 'completed',
        reason: eventBridge.state.failure?.error ?? eventBridge.state.abortReason,
        lastStep: eventBridge.state.failure?.step ?? eventBridge.state.lastStepName,
        lastMessage: eventBridge.state.lastStepContent,
        runDirectory: bootstrap.runPaths.runRootAbs,
        reportDirectory: bootstrap.runPaths.reportsAbs,
        ndjsonLogPath: bootstrap.ndjsonLogPath,
        exceeded: eventBridge.state.exceededInfo != null,
        ...(eventBridge.state.exceededInfo ? { exceededInfo: eventBridge.state.exceededInfo } : {}),
      };
      if (finalState.status === 'aborted') {
        const stagedAbort = eventBridge.getStagedAbort();
        if (stagedAbort === undefined) {
          throw new Error('Aborted workflow did not stage its terminal intent');
        }
        latentAbortPrimary = new WorkflowAbortError(
          stagedAbort.reason,
          stagedAbort.kind,
        );
      }
    });
  } catch (caughtError) {
    const error = caughtError;
    const stagedAbort = eventBridge?.getStagedAbort();
    if (stagedAbort !== undefined) {
      latentAbortPrimary = new WorkflowAbortError(
        stagedAbort.reason,
        stagedAbort.kind,
      );
      primaryError = latentAbortPrimary;
      terminalizationErrors.push(error);
    } else {
      primaryError = error;
    }
    const failurePublicationStatus = stagedAbort === undefined
      ? runExecutionControl?.signal.aborted === true
          ? 'aborted'
          : 'failed'
      : stagedAbort.status;
    if (eventBridge !== undefined && stagedAbort === undefined) {
      if (runExecution === undefined) {
        terminalizationErrors.push(
          new Error('Workflow event bridge exists without a run lifecycle'),
        );
      } else {
        const activeEventBridge = eventBridge;
        captureError(terminalizationErrors, () => {
          activeEventBridge.stageWorkflowFailure(
            activeEventBridge.state.currentIteration,
            getErrorMessage(error),
            failurePublicationStatus,
          );
        });
      }
    }
  } finally {
    let committedPublication: WorkflowTerminalPublicationPayload | undefined;
    if (runExecution !== undefined || primaryError !== undefined) {
      try {
        const terminalPublication = resolveTerminalPublication(
          eventBridge,
          primaryError,
          terminalPayloads,
        );
        const terminalStatus = resolveRunStatusFromTerminalPublication(
          terminalPublication,
        );
        const finalization = await activeRun.finish(
          {
            status: terminalStatus,
            iteration: terminalPublication.iterations,
            ...(terminalPublication.reason === undefined
              ? {}
              : { reason: terminalPublication.reason }),
          },
          terminalPublication,
        );
        finalizationIssues.push(...finalization.issues);
        committedPublication = terminalPublication;
        scheduleLoopAnalysis(
          options.loopAnalysisScheduler,
          activeRun.runPaths.runRootAbs,
        );
      } catch (error) {
        terminalizationErrors.push(error);
      }
    }
    if (committedPublication !== undefined && eventBridge !== undefined) {
      await publishTerminalLiveFeedback({
        payload: committedPublication,
        runPaths: bootstrap.runPaths,
        out: bootstrap.out,
        eventBridge,
        shouldNotifyWorkflowComplete:
          bootstrap.shouldNotifyWorkflowComplete,
        shouldNotifyWorkflowAbort: bootstrap.shouldNotifyWorkflowAbort,
        issues: finalizationIssues,
      });
      finalizationIssues.push(...eventBridge.getFinalizationIssues());
    }
    captureError(cleanupErrors, () => bootstrap.warnIfAutoStrategyUnused());
    captureError(cleanupErrors, () => bootstrap.prefixWriter?.flush());
    captureError(cleanupErrors, () => abortHandler?.cleanup());
    await captureAsyncError(
      cleanupErrors,
      () => bootstrap.observabilityHandle.shutdown(),
    );
  }

  const additionalErrors = [
    ...terminalizationErrors,
    ...(terminalizationErrors.length === 0 ? [] : cleanupErrors),
  ];
  const effectivePrimary = primaryError
    ?? (
      latentAbortPrimary !== undefined
      && additionalErrors.some((error) => expandErrors(error).length !== 0)
        ? latentAbortPrimary
        : undefined
    );
  throwCombinedErrors(effectivePrimary, additionalErrors);
  if (executionResult === undefined || eventBridge === undefined) {
    throw new Error('Workflow execution finished without a result');
  }
  finalizationIssues.push(
    ...cleanupErrors.map((error) => new RunCleanupError(error)),
  );
  return finalizationIssues.length === 0
    ? executionResult
    : {
        ...executionResult,
        finalizationIssues: Object.freeze([...finalizationIssues]),
      };
}

function resolveAvailableSourceLineage(
  cwd: string,
  resumeSource: WorkflowExecutionOptions['resumeSource'],
  runsDirectory?: string,
): WorkflowExecutionResumeLineage | undefined {
  if (resumeSource?.sourceRunSlug === undefined) {
    return undefined;
  }
  try {
    return resolveWorkflowExecutionResumeSourceLineage(cwd, resumeSource, runsDirectory);
  } catch (error) {
    if (error instanceof OperationLineageUnavailableError) {
      return undefined;
    }
    throw error;
  }
}

async function terminalizeBootstrapFailure(input: {
  readonly activeRun: WorkflowRunHandle;
  readonly workflowConfig: WorkflowConfig;
  readonly task: string;
  readonly projectCwd: string;
  readonly sessionStorageDirectory?: string;
  readonly primaryError: unknown;
  readonly resumeLineage?: WorkflowExecutionResumeLineage;
  readonly loopAnalysisScheduler?: WorkflowExecutionOptions['loopAnalysisScheduler'];
}): Promise<never> {
  const reason = getErrorMessage(input.primaryError);
  const finalizationErrors: unknown[] = [];
  const publishedResumeSource = input.resumeLineage?.publishedResumeSource;
  try {
    input.activeRun.bootstrap.publishRunMeta({
        runPaths: input.activeRun.runPaths,
        task: input.task,
        workflowName: input.workflowConfig.name,
        ...(publishedResumeSource === undefined
          ? {}
          : { resumeSource: publishedResumeSource }),
        ...(input.resumeLineage === undefined
          ? {}
          : {
              options: {
                operationJournalRunSlug: input.resumeLineage.operationJournalRunSlug,
                operationClaimToken: input.resumeLineage.operationClaimToken,
              },
            }),
    });
  } catch (error) {
    finalizationErrors.push(error);
  }
  const sessionLog = createSessionLog(
    input.task,
    input.projectCwd,
    input.workflowConfig.name,
    { startTime: input.activeRun.bootstrap.startedAt },
  );
  const sessionId = input.activeRun.bootstrap.sessionId;
  let ndjsonLogPath = join(
    input.activeRun.runPaths.logsAbs,
    `${sessionId}.jsonl`,
  );
  try {
    ndjsonLogPath = initNdjsonLog(
      sessionId,
      input.task,
      input.workflowConfig.name,
      {
        logsDir: input.activeRun.runPaths.logsAbs,
        startTime: input.activeRun.bootstrap.startedAt,
      },
    );
  } catch (error) {
    finalizationErrors.push(error);
  }
  const terminalPayloads = createWorkflowTerminalPayloadFactory({
    runSlug: input.activeRun.runSlug,
    projectCwd: input.projectCwd,
    ...(input.sessionStorageDirectory === undefined
      ? {}
      : { sessionStorageDirectory: input.sessionStorageDirectory }),
    task: input.task,
    workflowName: input.workflowConfig.name,
    sessionLog,
    sessionId,
    ndjsonLogPath,
    traceReportMode: 'redacted',
  });
  const payload = terminalPayloads.create({
    status: 'failed',
    iterations: 0,
    reason,
    lastStepContent: undefined,
    lastStepName: undefined,
    endTime: new Date().toISOString(),
  });
  try {
    const finalization = await input.activeRun.finish({
      status: 'failed',
      iteration: 0,
      reason,
    }, payload);
    finalizationErrors.push(...finalization.issues);
    scheduleLoopAnalysis(
      input.loopAnalysisScheduler,
      input.activeRun.runPaths.runRootAbs,
    );
  } catch (error) {
    finalizationErrors.push(error);
  }
  throwCombinedErrors(input.primaryError, finalizationErrors);
  throw input.primaryError;
}

class WorkflowAbortError extends Error {
  readonly kind: WorkflowAbortKind;

  constructor(
    reason: string,
    kind: WorkflowAbortKind,
  ) {
    super(reason);
    this.name = 'WorkflowAbortError';
    this.kind = kind;
  }
}

function resolveTerminalPublication(
  eventBridge: WorkflowExecutionEventBridge | undefined,
  primaryError: unknown,
  terminalPayloads: WorkflowTerminalPayloadFactory,
): WorkflowTerminalPublicationPayload {
  if (eventBridge !== undefined) {
    return eventBridge.prepareTerminalPublicationPayload();
  }
  if (primaryError === undefined) {
    throw new Error(
      'Workflow terminal publication requires a staged result or a primary error',
    );
  }
  return terminalPayloads.create({
    status: 'failed',
    iterations: 0,
    reason: getErrorMessage(primaryError),
    lastStepContent: undefined,
    lastStepName: undefined,
    endTime: new Date().toISOString(),
  });
}

function resolveRunStatusFromTerminalPublication(
  publication: WorkflowTerminalPublicationPayload,
): WorkflowRunTerminalStatus {
  switch (publication.status) {
    case 'completed':
      return 'completed';
    case 'aborted':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

async function publishTerminalLiveFeedback(input: {
  readonly payload: WorkflowTerminalPublicationPayload;
  readonly runPaths: RunPaths;
  readonly out: ReturnType<
    typeof import('./outputFns.js').createOutputFns
  >;
  readonly eventBridge: WorkflowExecutionEventBridge;
  readonly shouldNotifyWorkflowComplete: boolean;
  readonly shouldNotifyWorkflowAbort: boolean;
  readonly issues: RunFinalizationIssue[];
}): Promise<void> {
  try {
    if (input.payload.status === 'completed') {
      reportWorkflowCompletion(
        input.out,
        input.payload.sessionLog,
        input.payload.iterations,
        join(input.runPaths.logsAbs, input.payload.ndjsonLogFile),
        input.shouldNotifyWorkflowComplete,
        input.payload.traceDiscovery,
      );
    } else {
      reportWorkflowFailure(
        input.out,
        input.payload.sessionLog,
        input.payload.iterations,
        requireTerminalReason(input.payload.reason),
        input.payload.status,
        join(input.runPaths.logsAbs, input.payload.ndjsonLogFile),
        input.shouldNotifyWorkflowAbort,
        input.payload.traceDiscovery,
      );
    }
  } catch (error) {
    input.issues.push(new RunLiveDeliveryError(error));
  }
  try {
    input.eventBridge.emitTerminalFeedback(
      input.payload.status === 'completed'
        ? {
            type: 'completed',
            success: true,
            reportDirectory: input.runPaths.reportsAbs,
          }
        : {
            type: 'completed',
            success: false,
            reason: requireTerminalReason(input.payload.reason),
            reportDirectory: input.runPaths.reportsAbs,
          },
    );
    await input.eventBridge.flushEventSink();
  } catch (error) {
    input.issues.push(new RunLiveDeliveryError(error));
  }
}

function captureError(
  errors: unknown[],
  action: () => void,
): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}

async function captureAsyncError(
  errors: unknown[],
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

function throwCombinedErrors(
  primary: unknown,
  additional: readonly unknown[],
): void {
  const primaryCause = resolvePrimaryCause(primary);
  const errors = deduplicateErrors([
    ...(primaryCause === undefined ? [] : [primaryCause]),
    ...expandErrors(primary),
    ...additional.flatMap(expandErrors),
  ]);
  if (errors.length === 0) {
    return;
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  const cause = primaryCause === undefined ? errors[0] : primaryCause;
  throw new AggregateError(
    errors,
    getErrorMessage(cause),
    { cause },
  );
}

function resolvePrimaryCause(error: unknown): unknown {
  if (error instanceof AggregateError && error.cause !== undefined) {
    return error.cause;
  }
  return error;
}

function expandErrors(error: unknown): unknown[] {
  if (error === undefined) {
    return [];
  }
  if (error instanceof AggregateError) {
    return error.errors.flatMap(expandErrors);
  }
  return [error];
}

function deduplicateErrors(errors: readonly unknown[]): unknown[] {
  const seen = new Set<unknown>();
  const unique: unknown[] = [];
  for (const error of errors) {
    if (seen.has(error)) {
      continue;
    }
    seen.add(error);
    unique.push(error);
  }
  return unique;
}
