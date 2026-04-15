import { WorkflowEngine, createDenyAskUserQuestionHandler } from '../../../core/workflow/index.js';
import type { WorkflowConfig, WorkflowResumePointEntry } from '../../../core/models/index.js';
import type { WorkflowExecutionResult, WorkflowExecutionOptions } from './types.js';
import { detectRuleIndex } from '../../../shared/utils/ruleIndex.js';
import { createDefaultSystemStepServices } from '../../../infra/workflow/system/DefaultSystemStepServices.js';
import { AbortHandler } from './abortHandler.js';
import { createIterationLimitHandler, createUserInputHandler } from './iterationLimitHandler.js';
import { createWorkflowExecutionBootstrap } from './workflowExecutionBootstrap.js';
import { createWorkflowExecutionContext, createWorkflowCallResolver } from './workflowExecutionContext.js';
import { bindWorkflowExecutionEvents, type WorkflowExecutionEventBridge } from './workflowExecutionEvents.js';

export type { WorkflowExecutionResult, WorkflowExecutionOptions };

type WorkflowRunContext = {
  ignoreIterationLimit?: boolean;
};

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
  const bootstrap = createWorkflowExecutionBootstrap(workflowConfig, task, cwd, options);
  const workflowExecutionContext = createWorkflowExecutionContext(workflowConfig, options.projectCwd);
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
      const resumePoint = getLatestResumePoint()
        ?? buildResumePointForStep(request.currentStep)
        ?? eventBridge?.state.lastResumePoint;
      eventBridge!.state.exceededInfo = {
        currentStep: request.currentStep,
        newMaxSteps: request.maxSteps + workflowConfig.maxSteps,
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

  try {
    engine = new WorkflowEngine(bootstrap.effectiveWorkflowConfig, cwd, task, {
      abortSignal: runAbortController.signal,
      onStream: bootstrap.providerEventLogger.wrapCallback(bootstrap.streamHandler),
      onUserInput,
      initialSessions: bootstrap.savedSessions,
      onSessionUpdate: bootstrap.sessionUpdateHandler,
      onIterationLimit,
      onAskUserQuestion: createDenyAskUserQuestionHandler(),
      ignoreIterationLimit: runContext?.ignoreIterationLimit === true,
      projectCwd: options.projectCwd,
      language: options.language,
      provider: bootstrap.currentProvider,
      model: bootstrap.configuredModel,
      providerOptions: options.providerOptions,
      providerOptionsSource: options.providerOptionsSource,
      providerOptionsOriginResolver: options.providerOptionsOriginResolver,
      personaProviders: options.personaProviders,
      providerProfiles: options.providerProfiles,
      interactive: bootstrap.interactiveUserInput,
      detectRuleIndex,
      structuredCaller: bootstrap.structuredCaller,
      startStep: options.startStep,
      retryNote: options.retryNote,
      resumePoint: options.resumePoint,
      reportDirName: bootstrap.runSlug,
      taskPrefix: options.taskPrefix,
      taskColorIndex: options.taskColorIndex,
      initialIteration: options.initialIterationOverride,
      currentTask: options.currentTaskIssueNumber !== undefined
        ? { issueNumber: options.currentTaskIssueNumber }
        : undefined,
      systemStepServicesFactory: createDefaultSystemStepServices,
      workflowCallResolver: createWorkflowCallResolver(workflowExecutionContext),
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
      providerEventLogger: bootstrap.providerEventLogger,
      usageEventLogger: bootstrap.usageEventLogger,
      analyticsEmitter: bootstrap.analyticsEmitter,
      sessionLogger: bootstrap.sessionLogger,
      runMetaManager: bootstrap.runMetaManager,
      ndjsonLogPath: bootstrap.ndjsonLogPath,
      shouldNotifyWorkflowComplete: bootstrap.shouldNotifyWorkflowComplete,
      shouldNotifyWorkflowAbort: bootstrap.shouldNotifyWorkflowAbort,
      writeTraceReportOnce: bootstrap.writeTraceReportOnce,
      getCurrentWorkflowStack,
      initialResumePoint: options.resumePoint,
      sessionLog: bootstrap.sessionLog,
    });

    abortHandler.install();
    const finalState = await engine.run();
    return {
      success: finalState.status === 'completed',
      reason: eventBridge.state.abortReason,
      lastStep: eventBridge.state.lastStepName,
      lastMessage: eventBridge.state.lastStepContent,
      exceeded: eventBridge.state.exceededInfo != null,
      ...(eventBridge.state.exceededInfo ? { exceededInfo: eventBridge.state.exceededInfo } : {}),
    };
  } catch (error) {
    if (!bootstrap.runMetaManager.isFinalized) {
      eventBridge?.syncLatestResumePoint();
      bootstrap.runMetaManager.finalize('aborted');
    }
    throw error;
  } finally {
    bootstrap.prefixWriter?.flush();
    abortHandler.cleanup();
  }
}
