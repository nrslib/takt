import { interruptAllQueries } from '../../../infra/claude/query-manager.js';
import { formatWorkflowRuleCondition } from '../../../core/models/workflow-rule-condition.js';
import type { WorkflowEngine } from '../../../core/workflow/index.js';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';
import type { SessionLog } from '../../../infra/fs/index.js';
import type { StepProviderInfo, WorkflowAbortKind } from '../../../core/workflow/types.js';
import type { WorkflowExecutionScope } from '../../../core/workflow/workflow-execution-scope.js';
import { extractBlockedPrompt } from '../../../core/workflow/engine/transitions.js';
import { CONFIGURED_PROVIDER_OPTION_VALUE } from '../../../core/workflow/providerOptionsRedaction.js';
import type { ProviderType, StreamEvent } from '../../../shared/types/provider.js';
import type {
  UsageEventLogContext,
  UsageEventLogger,
} from '../../../core/logging/usageEventLogger.js';
import { StreamDisplay } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { isDebugEnabled, isVerboseConsole } from '../../../shared/utils/debug.js';
import { notifyWarning, playWarningSound } from '../../../shared/utils/index.js';
import type { ExceededInfo, WorkflowExecutionEvent, WorkflowExecutionOptions } from './types.js';
import { detectStepType, isQuietMode } from './workflowExecutionBootstrap.js';
import { buildWorkflowStepScopeKey } from './workflowStepScope.js';
import {
  isCountableWorkflowStep,
  isProviderBackedWorkflowStep,
} from '../../../core/workflow/step-kind.js';
import {
  finalizeWorkflowAbort,
  finalizeWorkflowSuccess,
  reportStepFile,
  reportWorkflowAbort,
  reportWorkflowCompletion,
  updateUsageForStepCompletion,
} from './workflowExecutionReporting.js';

export interface WorkflowExecutionEventState {
  abortReason?: string;
  abortKind?: WorkflowAbortKind;
  exceededInfo?: ExceededInfo;
  lastStepContent?: string;
  lastStepName?: string;
  currentStepName?: string;
  lastResumePoint?: WorkflowExecutionOptions['resumePoint'];
  currentIteration: number;
  sessionLog: SessionLog;
}

interface WorkflowExecutionEventBridgeDeps {
  engine: WorkflowEngine;
  workflowConfig: {
    name: string;
    steps: Array<{ name: string }>;
    maxSteps: number | 'infinite';
  };
  task: string;
  projectCwd: string;
  currentProvider: ProviderType | undefined;
  configuredModel: string | undefined;
  out: ReturnType<typeof import('./outputFns.js').createOutputFns>;
  prefixWriter: import('../../../shared/ui/TaskPrefixWriter.js').TaskPrefixWriter | undefined;
  displayRef: { current: StreamDisplay | null };
  handlerRef: { current: ReturnType<StreamDisplay['createHandler']> | null };
  usageEventLogger: UsageEventLogger;
  analyticsEmitter: import('./analyticsEmitter.js').AnalyticsEmitter;
  sessionLogger: import('./sessionLogger.js').SessionLogger;
  runMetaManager: import('./runMeta.js').RunMetaManager;
  ndjsonLogPath: string;
  shouldNotifyRateLimit: boolean;
  shouldNotifyWorkflowComplete: boolean;
  shouldNotifyWorkflowAbort: boolean;
  traceDiscovery?: WorkflowTraceDiscovery;
  writeTraceReportOnce: ReturnType<typeof import('./traceReportWriter.js').createTraceReportWriter>;
  initialResumePoint: WorkflowExecutionOptions['resumePoint'];
  sessionLog: SessionLog;
  eventSink: WorkflowExecutionOptions['eventSink'];
  reportDirectory: string;
}

export interface WorkflowExecutionEventBridge {
  state: WorkflowExecutionEventState;
  syncLatestResumePoint: () => void;
  emitRunStarted: (event: Extract<WorkflowExecutionEvent, { type: 'run_started' }>) => void;
  emitWorkflowFailed: (event: Extract<WorkflowExecutionEvent, { type: 'completed' }>) => void;
  emitProviderOutput: (event: StreamEvent) => void;
  flushEventSink: () => Promise<void>;
}

function requireEventScope(
  scope: WorkflowExecutionScope | undefined,
  event: string,
): WorkflowExecutionScope {
  if (scope === undefined) {
    throw new Error(`${event} event is missing its execution scope snapshot`);
  }
  return scope;
}

type OutInfo = { info: (line: string) => void };
function emitWorkflowExecutionEvent(
  sink: WorkflowExecutionOptions['eventSink'],
  event: WorkflowExecutionEvent,
  onFailure: (error: unknown) => void,
  dispatchState: {
    current: Promise<void>;
    hasError: boolean;
    firstError: unknown;
  },
): void {
  if (!sink) {
    return;
  }
  const dispatch = dispatchState.current.then(() => sink(event)).then(
    () => undefined,
    (error) => {
      if (!dispatchState.hasError) {
        dispatchState.hasError = true;
        dispatchState.firstError = error;
      }
      onFailure(error);
    },
  );
  dispatchState.current = dispatch;
}

function getEventSinkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createOutputEvents(
  streamEvent: StreamEvent,
  step: string | undefined,
  pendingToolCallIds: string[],
  pendingPermissionRequestIds: string[],
): WorkflowExecutionEvent[] {
  switch (streamEvent.type) {
    case 'tool_use':
      pendingToolCallIds.push(streamEvent.data.id);
      return [{
        type: 'tool_started',
        toolCallId: streamEvent.data.id,
        tool: streamEvent.data.tool,
        input: streamEvent.data.input,
        step,
      }];
    case 'text':
      return streamEvent.data.text
        ? [{ type: 'output', outputType: 'text', message: streamEvent.data.text, step }]
        : [];
    case 'thinking':
      return streamEvent.data.thinking
        ? [{ type: 'output', outputType: 'thinking', message: streamEvent.data.thinking, step }]
        : [];
    case 'tool_output':
      return streamEvent.data.output
        ? [{
            type: 'output',
            outputType: 'tool_output',
            message: streamEvent.data.output,
            step,
            tool: streamEvent.data.tool,
          }]
        : [];
    case 'tool_result': {
      const completedToolCallId = pendingToolCallIds.shift();
      if (!completedToolCallId && !streamEvent.data.content) {
        return [];
      }
      return completedToolCallId
        ? [{
            type: 'tool_completed',
            toolCallId: completedToolCallId,
            message: streamEvent.data.content,
            step,
            isError: streamEvent.data.isError,
          }]
        : [{
            type: 'output',
            outputType: 'tool_result',
            message: streamEvent.data.content,
            step,
            isError: streamEvent.data.isError,
          }];
    }
    case 'result':
      return [{
        type: 'output',
        outputType: 'result',
        message: streamEvent.data.error ?? streamEvent.data.result,
        step,
        isError: !streamEvent.data.success,
      }];
    case 'assistant_error':
      return [{
        type: 'output',
        outputType: 'error',
        message: streamEvent.data.error,
        step,
        isError: true,
      }];
    case 'error':
      return [{
        type: 'output',
        outputType: 'error',
        message: streamEvent.data.message,
        step,
        isError: true,
      }];
    case 'permission_asked':
      pendingPermissionRequestIds.push(streamEvent.data.requestId);
      return [{
        type: 'confirmation_requested',
        confirmationId: streamEvent.data.requestId,
        message: `Permission requested: ${streamEvent.data.permission}`,
        step,
      }];
    case 'permission_summary':
      if (pendingPermissionRequestIds.length === 0) {
        return [{
          type: 'progress',
          message: `Permission summary: ${streamEvent.data.resolvedPermissions.length} resolved permissions`,
          step,
        }];
      }
      return pendingPermissionRequestIds.splice(0).map((requestId) => ({
        type: 'tool_completed',
        toolCallId: requestId,
        message: `Permission summary: ${streamEvent.data.resolvedPermissions.length} resolved permissions`,
        step,
        isError: false,
      }));
    case 'rate_limit': {
      const message = [
        `Rate limit ${streamEvent.data.status}`,
        streamEvent.data.rateLimitType ? `(${streamEvent.data.rateLimitType})` : undefined,
      ].filter((line): line is string => line !== undefined).join(' ');

      return [
        {
          type: 'rate_limited',
          message,
          ...(step ? { step } : {}),
        },
        {
          type: streamEvent.data.status === 'rejected' ? 'error' : 'progress',
          message,
          step,
        },
      ];
    }
    default:
      return [];
  }
}

function sourceSuffix(
  path: string,
  sources: StepProviderInfo['providerOptionsSources'],
  showSource: boolean,
): string {
  if (!showSource) return '';
  const source = sources?.[path];
  return source ? ` (source: ${source})` : '';
}

function emitProviderOptionLines(
  out: OutInfo,
  stepProvider: ProviderType,
  providerInfo: StepProviderInfo,
  showSource: boolean,
): void {
  const options = providerInfo.providerOptions;
  if (!options) return;
  const sources = providerInfo.providerOptionsSources;

  if (stepProvider === 'claude' || stepProvider === 'claude-sdk') {
    const baseUrl = options.claude?.baseUrl;
    if (baseUrl !== undefined) {
      out.info(`Base URL: ${CONFIGURED_PROVIDER_OPTION_VALUE}${sourceSuffix('claude.baseUrl', sources, showSource)}`);
    }
    const effort = options.claude?.effort;
    if (effort !== undefined) {
      out.info(`Effort: ${effort}${sourceSuffix('claude.effort', sources, showSource)}`);
    }
  } else if (stepProvider === 'codex') {
    const baseUrl = options.codex?.baseUrl;
    if (baseUrl !== undefined) {
      out.info(`Base URL: ${CONFIGURED_PROVIDER_OPTION_VALUE}${sourceSuffix('codex.baseUrl', sources, showSource)}`);
    }
    const effort = options.codex?.reasoningEffort;
    if (effort !== undefined) {
      out.info(`Reasoning effort: ${effort}${sourceSuffix('codex.reasoningEffort', sources, showSource)}`);
    }
  } else if (stepProvider === 'opencode') {
    const variant = options.opencode?.variant;
    if (variant !== undefined) {
      out.info(`Variant: ${variant}${sourceSuffix('opencode.variant', sources, showSource)}`);
    }
  } else if (stepProvider === 'copilot') {
    const effort = options.copilot?.effort;
    if (effort !== undefined) {
      out.info(`Effort: ${effort}${sourceSuffix('copilot.effort', sources, showSource)}`);
    }
  } else if (stepProvider === 'kiro') {
    const agent = options.kiro?.agent;
    if (agent !== undefined) {
      out.info(`Agent: ${agent}${sourceSuffix('kiro.agent', sources, showSource)}`);
    }
  }
}

function resolveAnalyticsAttribution(
  iteration: number,
  providerInfo: StepProviderInfo | undefined,
  currentProvider: ProviderType | undefined,
  configuredModel: string | undefined,
): { iteration: number; provider: string; model: string } {
  const provider = providerInfo?.provider ?? currentProvider;
  if (provider === undefined) {
    return { iteration, provider: '(not applicable)', model: '(not applicable)' };
  }
  const model = providerInfo?.modelSource !== undefined
    ? providerInfo.model ?? '(default)'
    : providerInfo?.model
      ?? (provider === currentProvider ? configuredModel : undefined)
      ?? '(default)';
  return { iteration, provider, model };
}

export function bindWorkflowExecutionEvents(
  deps: WorkflowExecutionEventBridgeDeps,
): WorkflowExecutionEventBridge {
  const usageContextByStepScope = new Map<string, UsageEventLogContext>();
  const analyticsContextByStepScope = new Map<string, {
    iteration: number;
    provider: string;
    model: string;
  }>();
  const canReadResumePoint = (): boolean => typeof deps.engine.getResumePoint === 'function';
  const canReadEngineState = (): boolean => typeof deps.engine.getState === 'function';
  const getResumePoint = (): WorkflowExecutionOptions['resumePoint'] => {
    if (!canReadResumePoint()) {
      return undefined;
    }
    return deps.engine.getResumePoint();
  };
  const state: WorkflowExecutionEventState = {
    currentIteration: 0,
    lastResumePoint: deps.initialResumePoint,
    sessionLog: deps.sessionLog,
  };
  const eventSinkDispatchState = {
    current: Promise.resolve(),
    hasError: false,
    firstError: undefined as unknown,
  };
  const pendingToolCallIds: string[] = [];
  const pendingPermissionRequestIds: string[] = [];
  let confirmationSequence = 0;
  const nextConfirmationId = (): string => {
    confirmationSequence += 1;
    return `confirmation-${confirmationSequence}`;
  };
  const onEventSinkFailure = (error: unknown): void => {
    if (!state.abortReason) {
      state.abortReason = `Workflow event sink failed: ${getEventSinkErrorMessage(error)}`;
    }
    deps.engine.abort();
  };
  const syncLatestResumePoint = (): void => {
    if (!canReadResumePoint()) {
      return;
    }
    state.lastResumePoint = getResumePoint();
    deps.runMetaManager.updateResumePoint(state.lastResumePoint);
  };
  const initialFindingsState = canReadEngineState() ? deps.engine.getState().findings : undefined;
  deps.analyticsEmitter.seedFindingContractFindingIds(
    initialFindingsState !== undefined
      ? initialFindingsState.open.items.map((finding) => finding.id)
      : [],
  );

  deps.engine.on('phase:start', (step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration, scope) => {
    if (state.currentStepName === undefined) {
      throw new Error(`Phase ${phase} started before a resumable step was recorded`);
    }
    deps.runMetaManager.updatePhase(state.currentStepName, iteration, phase);
    deps.sessionLogger.onPhaseStart(
      step,
      phase,
      phaseName,
      instruction,
      promptParts,
      requireEventScope(scope, 'phase:start').stack,
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('phase:complete', (step, phase, phaseName, content, phaseStatus, phaseError, phaseExecutionId, iteration, scope) => {
    if (state.currentStepName === undefined) {
      throw new Error(`Phase ${phase} completed before a resumable step was recorded`);
    }
    deps.runMetaManager.updatePhase(state.currentStepName, iteration, phase);
    deps.sessionLogger.setIteration(state.currentIteration);
    deps.sessionLogger.onPhaseComplete(
      step,
      phase,
      phaseName,
      content,
      phaseStatus,
      phaseError,
      requireEventScope(scope, 'phase:complete').stack,
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('phase:judge_stage', (step, phase, phaseName, entry, phaseExecutionId, iteration, scope) => {
    deps.sessionLogger.onJudgeStage(
      step,
      phase,
      phaseName,
      entry,
      requireEventScope(scope, 'phase:judge_stage').stack,
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('workflow_call:start', (lifecycle) => {
    deps.sessionLogger.onWorkflowCallStart(lifecycle);
  });

  deps.engine.on('workflow_call:complete', (lifecycle) => {
    deps.sessionLogger.onWorkflowCallComplete(lifecycle);
  });

  deps.engine.on('step:start', (
    step,
    iteration,
    instruction,
    providerInfo,
    _workflowName,
    resumeStepName,
    stepIteration,
    maxSteps,
    scope,
  ) => {
    const eventScope = requireEventScope(scope, 'step:start');
    state.currentIteration = iteration;
    state.currentStepName = resumeStepName;
    state.lastResumePoint = getResumePoint();
    deps.runMetaManager.updateStep(resumeStepName, iteration, state.lastResumePoint);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'step_started',
        step: step.name,
        iteration,
        maxSteps,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'progress',
        message: `Starting step "${step.name}" (${iteration}/${maxSteps})`,
        step: step.name,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );

    const safeStepName = sanitizeTerminalText(step.name);
    const safePersonaDisplayName = sanitizeTerminalText(step.personaDisplayName);
    deps.prefixWriter?.setStepContext({
      stepName: safeStepName,
      iteration,
      maxSteps,
      stepIteration,
    });
    deps.out.info(`[${iteration}/${maxSteps}] ${safeStepName} (${safePersonaDisplayName})`);

    if (isProviderBackedWorkflowStep(step)) {
      const stepProvider = providerInfo?.provider;
      if (stepProvider === undefined || providerInfo === undefined) {
        throw new Error(`Step "${step.name}" started without resolved provider information`);
      }
      const stepModel = providerInfo.model ?? '(default)';
      const stepScopeKey = buildWorkflowStepScopeKey(step.name, eventScope.stack);
      usageContextByStepScope.set(stepScopeKey, {
        provider: stepProvider,
        providerModel: stepModel,
        step: step.name,
        stepType: detectStepType(step),
      });
      const showSource = isDebugEnabled() || isVerboseConsole();
      const providerSourceSuffix = showSource && providerInfo.providerSource
        ? ` (source: ${providerInfo.providerSource})`
        : '';
      const modelSourceSuffix = showSource && providerInfo.modelSource
        ? ` (source: ${providerInfo.modelSource})`
        : '';
      deps.out.info(`Provider: ${stepProvider}${providerSourceSuffix}`);
      deps.out.info(`Model: ${stepModel}${modelSourceSuffix}`);
      emitProviderOptionLines(deps.out, stepProvider, providerInfo, showSource);
    }
    if (isCountableWorkflowStep(step)) {
      const stepScopeKey = buildWorkflowStepScopeKey(step.name, eventScope.stack);
      analyticsContextByStepScope.set(stepScopeKey, resolveAnalyticsAttribution(
        iteration,
        providerInfo,
        deps.currentProvider,
        deps.configuredModel,
      ));
    }

    if (!deps.prefixWriter) {
      const stepIndex = deps.workflowConfig.steps.findIndex((workflowStep) => workflowStep.name === step.name);
      deps.displayRef.current = new StreamDisplay(safePersonaDisplayName, isQuietMode(), {
        iteration,
        maxSteps,
        stepIndex: stepIndex >= 0 ? stepIndex : 0,
        totalSteps: deps.workflowConfig.steps.length,
      });
      deps.handlerRef.current = null;
    }

    deps.sessionLogger.onStepStart(
      step,
      iteration,
      instruction,
      eventScope.stack,
      providerInfo,
    );
  });

  deps.engine.on('step:complete', (step, response, instruction, resumeStepName, scope) => {
    const eventScope = requireEventScope(scope, 'step:complete');
    const stepScopeKey = buildWorkflowStepScopeKey(step.name, eventScope.stack);
    syncLatestResumePoint();
    state.lastStepContent = response.content;
    state.lastStepName = resumeStepName;
    state.currentStepName = state.lastStepName;

    if (deps.displayRef.current) {
      deps.displayRef.current.flush();
      deps.displayRef.current = null;
    }
    deps.prefixWriter?.flush();
    deps.out.blankLine();

    if (response.matchedRuleIndex != null && step.rules) {
      const rule = step.rules[response.matchedRuleIndex];
      const methodLabel = response.matchedRuleMethod ? ` (${response.matchedRuleMethod})` : '';
      deps.out.status('Status', rule ? `${formatWorkflowRuleCondition(rule.condition)}${methodLabel}` : response.status);
    } else {
      deps.out.status('Status', response.status);
    }

    if (response.error) {
      deps.out.error(`Error: ${response.error}`);
      emitWorkflowExecutionEvent(
        deps.eventSink,
        {
          type: 'error',
          message: response.error,
          step: step.name,
        },
        onEventSinkFailure,
        eventSinkDispatchState,
      );
    }
    if (response.sessionId) {
      deps.out.status('Session', response.sessionId);
    }
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'step_completed',
        step: step.name,
        status: response.status,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'progress',
        message: `Completed step "${step.name}" with status ${response.status}`,
        step: step.name,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );

    if (isProviderBackedWorkflowStep(step)) {
      const usageContext = usageContextByStepScope.get(stepScopeKey);
      if (!usageContext) {
        throw new Error(`Usage context is missing for completed step "${step.name}"`);
      }
      updateUsageForStepCompletion(deps.usageEventLogger, usageContext, response);
    }
    if (isCountableWorkflowStep(step)) {
      const analyticsContext = analyticsContextByStepScope.get(stepScopeKey);
      if (analyticsContext === undefined) {
        throw new Error(`Analytics context is missing for completed step "${step.name}"`);
      }
      deps.analyticsEmitter.onStepComplete(step, response, analyticsContext);
    }
    usageContextByStepScope.delete(stepScopeKey);
    analyticsContextByStepScope.delete(stepScopeKey);
    deps.sessionLogger.onStepComplete(
      step,
      response,
      instruction,
      eventScope.stack,
    );
  });

  deps.engine.on('routing:decision', (step, response, instruction, providerInfo, stepType, durationMs, iteration, workflowName, scope) => {
    requireEventScope(scope, 'routing:decision');
    deps.analyticsEmitter.onRoutingDecision?.(
      step,
      response,
      instruction,
      providerInfo,
      stepType,
      durationMs,
      iteration,
      workflowName,
    );
  });

  deps.engine.on('step:rate_limited', (step, response) => {
    if (deps.displayRef.current) {
      deps.displayRef.current.flush();
    }
    deps.prefixWriter?.flush();
    const message = response.error ?? `Step "${step.name}" hit a rate limit`;
    if (deps.shouldNotifyRateLimit) {
      playWarningSound();
      notifyWarning('TAKT', message);
    }
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'rate_limited',
        message,
        step: step.name,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'error',
        message,
        step: step.name,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });

  deps.engine.on('step:blocked', (step, response) => {
    const confirmationId = nextConfirmationId();
    const message = extractBlockedPrompt(response.content);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'blocked',
        confirmationId,
        message,
        step: step.name,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'confirmation_requested',
        confirmationId,
        message,
        step: step.name,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });

  deps.engine.on('step:report', (_step, filePath, fileName, iteration, scope) => {
    requireEventScope(scope, 'step:report');
    reportStepFile(filePath, fileName, deps.out);
    deps.analyticsEmitter.onStepReport(_step, filePath, iteration);
  });

  deps.engine.on('findings:ledger', (ledger, iteration, scope) => {
    requireEventScope(scope, 'findings:ledger');
    deps.analyticsEmitter.onFindingLedgerUpdated(ledger, iteration);
  });

  deps.engine.on('workflow:complete', (workflowState) => {
    syncLatestResumePoint();
    state.sessionLog = { ...state.sessionLog, iterations: workflowState.iteration };
    state.sessionLog = finalizeWorkflowSuccess(
      state.sessionLog,
      deps.task,
      deps.workflowConfig.name,
      state.lastStepContent,
      state.lastStepName,
      deps.projectCwd,
      deps.out.warn,
    );
    deps.sessionLogger.onWorkflowComplete(workflowState);
    deps.runMetaManager.finalize('completed', workflowState.iteration);
    deps.writeTraceReportOnce({
      status: 'completed',
      iterations: workflowState.iteration,
      endTime: new Date().toISOString(),
    });
    reportWorkflowCompletion(
      deps.out,
      state.sessionLog,
      workflowState.iteration,
      deps.ndjsonLogPath,
      deps.shouldNotifyWorkflowComplete,
      deps.traceDiscovery,
    );
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'completed',
        success: true,
        reportDirectory: deps.reportDirectory,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });

  deps.engine.on('workflow:abort', (workflowState, reason, kind) => {
    interruptAllQueries();
    syncLatestResumePoint();
    if (deps.displayRef.current) {
      deps.displayRef.current.flush();
      deps.displayRef.current = null;
    }
    deps.prefixWriter?.flush();
    state.abortReason = reason;
    state.abortKind = kind;
    state.sessionLog = { ...state.sessionLog, iterations: workflowState.iteration };
    state.sessionLog = finalizeWorkflowAbort(
      state.sessionLog,
      reason,
      deps.task,
      deps.workflowConfig.name,
      state.lastStepName,
      deps.projectCwd,
      deps.out.warn,
    );
    deps.sessionLogger.onWorkflowAbort(workflowState, reason);
    deps.runMetaManager.finalize('aborted', workflowState.iteration);
    deps.writeTraceReportOnce({
      status: 'aborted',
      iterations: workflowState.iteration,
      reason,
      endTime: new Date().toISOString(),
    });
    reportWorkflowAbort(
      deps.out,
      state.sessionLog,
      workflowState.iteration,
      reason,
      deps.ndjsonLogPath,
      deps.shouldNotifyWorkflowAbort,
      deps.traceDiscovery,
    );
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'completed',
        success: false,
        reportDirectory: deps.reportDirectory,
        reason,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });

  return {
    state,
    syncLatestResumePoint,
    emitRunStarted(event): void {
      emitWorkflowExecutionEvent(
        deps.eventSink,
        event,
        onEventSinkFailure,
        eventSinkDispatchState,
      );
    },
    emitWorkflowFailed(event): void {
      emitWorkflowExecutionEvent(
        deps.eventSink,
        event,
        onEventSinkFailure,
        eventSinkDispatchState,
      );
    },
    emitProviderOutput(event: StreamEvent): void {
      const outputEvents = createOutputEvents(
        event,
        state.currentStepName,
        pendingToolCallIds,
        pendingPermissionRequestIds,
      );
      for (const outputEvent of outputEvents) {
        emitWorkflowExecutionEvent(
          deps.eventSink,
          outputEvent,
          onEventSinkFailure,
          eventSinkDispatchState,
        );
      }
    },
    async flushEventSink(): Promise<void> {
      await eventSinkDispatchState.current;
      if (eventSinkDispatchState.hasError) {
        throw eventSinkDispatchState.firstError;
      }
    },
  };
}
