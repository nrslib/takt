import { WorkflowEngine, createDenyAskUserQuestionHandler } from '../../../core/workflow/index.js';
import type { WorkflowConfig, WorkflowResumePointEntry } from '../../../core/models/index.js';
import type { WorkflowExecutionResult, WorkflowExecutionOptions } from './types.js';
import { detectRuleIndex } from '../../../shared/utils/ruleIndex.js';
import { createDefaultSystemStepServices } from '../../../infra/workflow/system/DefaultSystemStepServices.js';
import { createDefaultStructuredOutputNormalizers } from '../../../infra/workflow/structured-output/followup-task-normalizer.js';
import { AbortHandler } from './abortHandler.js';
import { createIterationLimitHandler, createUserInputHandler } from './iterationLimitHandler.js';
import { createWorkflowExecutionBootstrap } from './workflowExecutionBootstrap.js';
import { createWorkflowExecutionContext, createWorkflowCallResolver } from './workflowExecutionContext.js';
import { bindWorkflowExecutionEvents, type WorkflowExecutionEventBridge } from './workflowExecutionEvents.js';
import { createLogger } from '../../../shared/utils/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import type { StreamEvent } from '../../../shared/types/provider.js';
import { finalizeWorkflowAbort, reportWorkflowAbort } from './workflowExecutionReporting.js';
import {
  OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  resolveOtlpExporterConfig,
  pickNestedOtelExporterOptionEnv,
} from '../../../shared/telemetry/index.js';
import type { GitProvider } from '../../../infra/git/index.js';
import { USAGE_MISSING_REASONS } from '../../../core/logging/contracts.js';

export type { WorkflowExecutionResult, WorkflowExecutionOptions };

const log = createLogger('workflow-execution');

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

async function executeWorkflowInternal(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
  runContext?: WorkflowRunContext,
): Promise<WorkflowExecutionResult> {
  const parentRunPid = process.pid;
  const workflowExecutionContext = createWorkflowExecutionContext(workflowConfig, options.projectCwd);
  const workflowCallResolver = createWorkflowCallResolver(workflowExecutionContext);
  const bootstrap = await createWorkflowExecutionBootstrap(workflowConfig, task, cwd, {
    ...options,
    workflowCallResolver,
  });
  const phase1ProcessSafetyByStep = resolvePhase1ProcessSafetyByStep(workflowConfig, parentRunPid);
  let engine: WorkflowEngine | null = null;
  let eventBridge: WorkflowExecutionEventBridge | undefined;
  const getCurrentWorkflowStack = (): WorkflowResumePointEntry[] | undefined => {
    if (!engine || typeof engine.getResumePoint !== 'function') {
      return undefined;
    }
    return engine.getResumePoint()?.stack;
  };
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
      const workflowMaxSteps = requireFiniteWorkflowMaxSteps(bootstrap.effectiveWorkflowConfig);
      const resumePoint = getLatestResumePoint()
        ?? buildResumePointForStep(request.currentStep)
        ?? eventBridge?.state.lastResumePoint;
      eventBridge!.state.exceededInfo = {
        currentStep: request.currentStep,
        newMaxSteps: request.maxSteps + workflowMaxSteps,
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
  const runAbortController = new AbortController();
  const abortHandler = new AbortHandler({
    externalSignal: options.abortSignal,
    internalController: runAbortController,
    getEngine: () => engine,
  });
  const handleProviderStream = (event: StreamEvent): void => {
    bootstrap.streamHandler(event);
    eventBridge?.emitProviderOutput(event);
  };

  try {
    const childProcessEnv = resolveNestedChildProcessEnv(bootstrap.observability, process.env);
    engine = new WorkflowEngine(bootstrap.effectiveWorkflowConfig, cwd, task, {
      abortSignal: runAbortController.signal,
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
      rateLimitFallback: bootstrap.effectiveWorkflowConfig.rateLimitFallback,
      providerOptions: options.providerOptions,
      autoRouting: bootstrap.effectiveWorkflowConfig.autoRouting,
      autoStrategyOverride: bootstrap.autoStrategyOverride,
      onEffectiveAutoRoutingReached: bootstrap.onEffectiveAutoRoutingReached,
      providerOptionsSource: options.providerOptionsSource,
      providerOptionsOriginResolver: options.providerOptionsOriginResolver,
      personaProviders: options.personaProviders,
      providerRouting: options.providerRouting,
      providerProfiles: options.providerProfiles,
      mcpServers: options.mcpServers,
      interactive: bootstrap.interactiveUserInput,
      detectRuleIndex,
      structuredCaller: bootstrap.structuredCaller,
      structuredOutputNormalizers: createDefaultStructuredOutputNormalizers(),
      startStep: options.startStep,
      retryNote: options.retryNote,
      resumePoint: options.resumePoint,
      reportDirName: bootstrap.runSlug,
      taskPrefix: options.taskPrefix,
      taskColorIndex: options.taskColorIndex,
      initialIteration: options.initialIterationOverride,
      currentTask: resolveCurrentTaskContext(options, bootstrap.runSlug),
      traceTaskMetadata: options.traceTaskMetadata,
      phase1ProcessSafetyByStep,
      systemStepServicesFactory: (serviceOptions) => createDefaultSystemStepServices({
        ...serviceOptions,
        ...(runContext?.gitProvider !== undefined ? { gitProvider: runContext.gitProvider } : {}),
      }),
      workflowCallResolver,
    });

    eventBridge = bindWorkflowExecutionEvents({
      engine,
      workflowConfig: bootstrap.effectiveWorkflowConfig,
      task,
      projectCwd: options.projectCwd,
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
      ndjsonLogPath: bootstrap.ndjsonLogPath,
      shouldNotifyRateLimit: bootstrap.shouldNotifyRateLimit,
      shouldNotifyWorkflowComplete: bootstrap.shouldNotifyWorkflowComplete,
      shouldNotifyWorkflowAbort: bootstrap.shouldNotifyWorkflowAbort,
      traceDiscovery: bootstrap.traceDiscovery,
      writeTraceReportOnce: bootstrap.writeTraceReportOnce,
      getCurrentWorkflowStack,
      initialResumePoint: options.resumePoint,
      sessionLog: bootstrap.sessionLog,
      eventSink: options.eventSink,
      reportDirectory: bootstrap.runPaths.reportsAbs,
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
    return {
      success: finalState.status === 'completed',
      reason: eventBridge.state.abortReason,
      lastStep: eventBridge.state.lastStepName,
      lastMessage: eventBridge.state.lastStepContent,
      runDirectory: bootstrap.runPaths.runRootAbs,
      reportDirectory: bootstrap.runPaths.reportsAbs,
      ndjsonLogPath: bootstrap.ndjsonLogPath,
      exceeded: eventBridge.state.exceededInfo != null,
      ...(eventBridge.state.exceededInfo ? { exceededInfo: eventBridge.state.exceededInfo } : {}),
    };
  } catch (error) {
    if (!bootstrap.runMetaManager.isFinalized) {
      eventBridge?.syncLatestResumePoint();
      const reason = getErrorMessage(error);
      const iteration = eventBridge?.state.currentIteration ?? 0;
      const sessionLog = finalizeWorkflowAbort(
        eventBridge?.state.sessionLog ?? bootstrap.sessionLog,
        reason,
        task,
        bootstrap.effectiveWorkflowConfig.name,
        eventBridge?.state.lastStepName,
        options.projectCwd,
        bootstrap.out.warn,
      );
      if (eventBridge) {
        eventBridge.state.abortReason = reason;
        eventBridge.state.sessionLog = sessionLog;
      }
      bootstrap.runMetaManager.finalize('aborted', iteration);
      reportWorkflowAbort(
        bootstrap.out,
        sessionLog,
        iteration,
        reason,
        bootstrap.ndjsonLogPath,
        bootstrap.shouldNotifyWorkflowAbort,
        bootstrap.traceDiscovery,
      );
      if (eventBridge) {
        eventBridge.emitWorkflowFailed({
          type: 'completed',
          success: false,
          reportDirectory: bootstrap.runPaths.reportsAbs,
          reason,
        });
        try {
          await eventBridge.flushEventSink();
        } catch (flushError) {
          log.warn('Failed to flush event sink after workflow failure', {
            error: getErrorMessage(flushError),
          });
        }
      }
    }
    throw error;
  } finally {
    bootstrap.warnIfAutoStrategyUnused();
    bootstrap.prefixWriter?.flush();
    abortHandler.cleanup();
    try {
      await bootstrap.observabilityHandle.shutdown();
    } catch (error) {
      log.warn('Observability shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
