import { interruptAllQueries } from '../../../infra/claude/query-manager.js';
import type { WorkflowState } from '../../../core/models/index.js';
import { formatWorkflowRuleCondition } from '../../../core/models/workflow-rule-condition.js';
import type { WorkflowEngine } from '../../../core/workflow/index.js';
import type { SessionLog } from '../../../infra/fs/index.js';
import type { StepProviderInfo, WorkflowAbortKind } from '../../../core/workflow/types.js';
import type { RunFailure } from '../../../core/workflow/run/run-meta.js';
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
import type { AnalyticsStepContext } from './analyticsEmitter.js';
import { detectStepType, isQuietMode } from './workflowExecutionBootstrap.js';
import {
  buildWorkflowScopeIdentity,
  buildWorkflowStepScopeKey,
} from './workflowStepScope.js';
import {
  reportStepFile,
  updateUsageForStepCompletion,
} from './workflowExecutionReporting.js';
import {
  type WorkflowTerminalPayloadFactory,
  type WorkflowTerminalPublicationPayload,
} from './workflowTerminalPayload.js';
import {
  resolveWorkflowAbortPublicationStatus,
} from './workflowTerminalStatus.js';
import {
  RunCleanupError,
  RunLiveDeliveryError,
  RunProjectionError,
  type RunFinalizationIssue,
} from './workflowRunExecution.js';

export interface WorkflowExecutionEventState {
  abortReason?: string;
  abortKind?: WorkflowAbortKind;
  failure?: RunFailure;
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
  currentProvider: ProviderType;
  configuredModel: string | undefined;
  out: ReturnType<typeof import('./outputFns.js').createOutputFns>;
  prefixWriter: import('../../../shared/ui/TaskPrefixWriter.js').TaskPrefixWriter | undefined;
  displayRef: { current: StreamDisplay | null };
  handlerRef: { current: ReturnType<StreamDisplay['createHandler']> | null };
  usageEventLogger: UsageEventLogger;
  analyticsEmitter: import('./analyticsEmitter.js').AnalyticsEmitter;
  sessionLogger: import('./sessionLogger.js').SessionLogger;
  runMetaManager: import('./runMeta.js').RunMetaManager;
  shouldNotifyRateLimit: boolean;
  initialResumePoint: WorkflowExecutionOptions['resumePoint'];
  sessionLog: SessionLog;
  eventSink: WorkflowExecutionOptions['eventSink'];
  terminalPayloads: WorkflowTerminalPayloadFactory;
}

export interface WorkflowExecutionEventBridge {
  state: WorkflowExecutionEventState;
  syncLatestResumePoint: () => void;
  getFinalizationIssues: () => readonly RunFinalizationIssue[];
  getStagedAbort: () => {
    readonly iteration: number;
    readonly reason: string;
    readonly kind: WorkflowAbortKind;
    readonly status: 'aborted' | 'failed';
  } | undefined;
  emitRunStarted: (event: Extract<WorkflowExecutionEvent, { type: 'run_started' }>) => void;
  stageWorkflowFailure: (
    iteration: number,
    reason: string,
    status: 'aborted' | 'failed',
  ) => void;
  stageHeartbeatFailure: (
    iteration: number,
    reason: string,
    status: 'aborted' | 'failed',
  ) => void;
  prepareTerminalPublicationPayload: () => WorkflowTerminalPublicationPayload;
  emitProviderOutput: (event: StreamEvent) => void;
  emitTerminalFeedback: (
    event: Extract<WorkflowExecutionEvent, { type: 'completed' }>,
  ) => void;
  flushEventSink: () => Promise<void>;
}

type WorkflowTerminalIntent =
  | {
      readonly kind: 'completed';
      readonly workflowState: WorkflowState;
      readonly endTime: string;
    }
  | {
      readonly kind: 'aborted';
      readonly workflowState: WorkflowState;
      readonly reason: string;
      readonly abortKind: WorkflowAbortKind;
      readonly failure: RunFailure;
      readonly status: 'aborted' | 'failed';
      readonly endTime: string;
    }
  | {
      readonly kind: 'failure';
      readonly iteration: number;
      readonly reason: string;
      readonly status: 'aborted' | 'failed';
      readonly endTime: string;
    };

type OutInfo = { info: (line: string) => void };

function resolveStepProviderContext(
  providerInfo: StepProviderInfo,
  currentProvider: ProviderType,
  configuredModel: string | undefined,
): {
  readonly provider: ProviderType;
  readonly model: string;
} {
  const provider = providerInfo.provider ?? currentProvider;
  const model = providerInfo.modelSource !== undefined
    ? providerInfo.model ?? '(default)'
    : providerInfo.model
      ?? (provider === currentProvider ? configuredModel : undefined)
      ?? '(default)';
  return { provider, model };
}

function emitWorkflowExecutionEvent(
  sink: WorkflowExecutionOptions['eventSink'],
  event: WorkflowExecutionEvent,
  onFailure: (error: unknown) => void,
  dispatchState: {
    current: Promise<void>;
  },
): void {
  if (!sink) {
    return;
  }
  const dispatch = dispatchState.current.then(() => sink(event)).then(
    () => undefined,
    (error) => {
      onFailure(error);
    },
  );
  dispatchState.current = dispatch;
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

export function bindWorkflowExecutionEvents(
  deps: WorkflowExecutionEventBridgeDeps,
): WorkflowExecutionEventBridge {
  const stepContextsByScope = new Map<string, {
    readonly usage: UsageEventLogContext;
    readonly analytics: AnalyticsStepContext;
  }>();
  const canReadResumePoint = (): boolean => typeof deps.engine.getResumePoint === 'function';
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
  };
  const pendingToolCallIds: string[] = [];
  const pendingPermissionRequestIds: string[] = [];
  let terminalIntent: WorkflowTerminalIntent | undefined;
  const finalizationIssues: RunFinalizationIssue[] = [];
  let preparedTerminalPublication:
    WorkflowTerminalPublicationPayload | undefined;
  let confirmationSequence = 0;
  const nextConfirmationId = (): string => {
    confirmationSequence += 1;
    return `confirmation-${confirmationSequence}`;
  };
  const onEventSinkFailure = (error: unknown): void => {
    finalizationIssues.push(new RunLiveDeliveryError(error));
  };
  const syncLatestResumePoint = (): void => {
    if (!canReadResumePoint()) {
      return;
    }
    state.lastResumePoint = getResumePoint();
    deps.runMetaManager.updateResumePoint(state.lastResumePoint);
  };
  const captureTerminalProjection = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      finalizationIssues.push(new RunProjectionError('meta', error));
    }
  };
  const captureTerminalCleanup = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      finalizationIssues.push(new RunCleanupError(error));
    }
  };
  deps.engine.on('phase:start', (
    step,
    phase,
    phaseName,
    instruction,
    promptParts,
    phaseExecutionId,
    iteration,
    workflowStack,
  ) => {
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
      workflowStack,
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('phase:complete', (
    step,
    phase,
    phaseName,
    content,
    phaseStatus,
    phaseError,
    phaseExecutionId,
    iteration,
    workflowStack,
  ) => {
    if (state.currentStepName === undefined) {
      throw new Error(`Phase ${phase} completed before a resumable step was recorded`);
    }
    deps.runMetaManager.updatePhase(state.currentStepName, iteration, phase);
    deps.sessionLogger.onPhaseComplete(
      step,
      phase,
      phaseName,
      content,
      phaseStatus,
      phaseError,
      workflowStack,
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('phase:judge_stage', (
    step,
    phase,
    phaseName,
    entry,
    phaseExecutionId,
    iteration,
    workflowStack,
  ) => {
    deps.sessionLogger.onJudgeStage(
      step,
      phase,
      phaseName,
      entry,
      workflowStack,
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
    workflowName,
    resumeStepName,
    stepIteration,
    workflowStack,
    findingScopeIdentity,
    findingIds,
  ) => {
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
        maxSteps: deps.workflowConfig.maxSteps,
      },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
    emitWorkflowExecutionEvent(
      deps.eventSink,
      {
        type: 'progress',
        message: `Starting step "${step.name}" (${iteration}/${deps.workflowConfig.maxSteps})`,
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
      maxSteps: deps.workflowConfig.maxSteps,
      stepIteration,
    });
    deps.out.info(`[${iteration}/${deps.workflowConfig.maxSteps}] ${safeStepName} (${safePersonaDisplayName})`);

    const {
      provider: stepProvider,
      model: stepModel,
    } = resolveStepProviderContext(
      providerInfo,
      deps.currentProvider,
      deps.configuredModel,
    );
    const stepScopeKey = buildWorkflowStepScopeKey(step.name, workflowStack);
    const analyticsScopeIdentity = findingScopeIdentity
      ?? buildWorkflowScopeIdentity(workflowName, workflowStack);
    if (findingScopeIdentity !== undefined) {
      if (findingIds === undefined) {
        throw new Error(
          `Finding IDs are missing for scope "${findingScopeIdentity}"`,
        );
      }
      deps.analyticsEmitter.setFindingContractFindingIds(
        findingScopeIdentity,
        findingIds,
      );
    }
    stepContextsByScope.set(stepScopeKey, {
      usage: {
        provider: stepProvider,
        providerModel: stepModel,
        step: step.name,
        stepType: detectStepType(step),
      },
      analytics: {
        iteration,
        workflowName,
        scopeIdentity: analyticsScopeIdentity,
        provider: stepProvider,
        model: stepModel,
      },
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
    if (!deps.prefixWriter) {
      const stepIndex = deps.workflowConfig.steps.findIndex((workflowStep) => workflowStep.name === step.name);
      deps.displayRef.current = new StreamDisplay(safePersonaDisplayName, isQuietMode(), {
        iteration,
        maxSteps: deps.workflowConfig.maxSteps,
        stepIndex: stepIndex >= 0 ? stepIndex : 0,
        totalSteps: deps.workflowConfig.steps.length,
      });
      deps.handlerRef.current = null;
    }

    deps.sessionLogger.onStepStart(step, iteration, instruction, workflowStack, providerInfo);
  });

  deps.engine.on('step:complete', (
    step,
    response,
    instruction,
    resumeStepName,
    workflowStack,
  ) => {
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

    const stepScopeKey = buildWorkflowStepScopeKey(step.name, workflowStack);
    const stepContext = stepContextsByScope.get(stepScopeKey);
    if (stepContext === undefined) {
      throw new Error(`Execution context is missing for completed step "${step.name}"`);
    }
    const stepType = detectStepType(step);
    if (stepType !== 'parallel' && stepType !== 'team_leader') {
      updateUsageForStepCompletion(
        deps.usageEventLogger,
        stepContext.usage,
        response,
      );
    }
    stepContextsByScope.delete(stepScopeKey);
    deps.sessionLogger.onStepComplete(step, response, instruction, workflowStack);
    deps.analyticsEmitter.onStepComplete(step, response, stepContext.analytics);
    state.sessionLog = { ...state.sessionLog, iterations: state.sessionLog.iterations + 1 };
  });

  deps.engine.on('routing:decision', (step, response, instruction, providerInfo, stepType, durationMs, iteration, workflowName) => {
    deps.analyticsEmitter.onRoutingDecision?.(
      step,
      response,
      instruction,
      providerInfo,
      stepType,
      durationMs,
      iteration,
      workflowName ?? deps.workflowConfig.name,
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

  deps.engine.on('step:report', (step, filePath, fileName, context) => {
    reportStepFile(filePath, fileName, deps.out);
    if (
      context.findingScopeIdentity !== undefined
      && context.findingIds === undefined
    ) {
      throw new Error(
        `Finding IDs are missing for scope "${context.findingScopeIdentity}"`,
      );
    }
    const scopeIdentity = context.findingScopeIdentity
      ?? buildWorkflowScopeIdentity(
        context.workflowName,
        context.workflowStack,
      );
    deps.analyticsEmitter.onStepReport(
      step,
      filePath,
      {
        iteration: context.iteration,
        workflowName: context.workflowName,
        scopeIdentity,
        provider: context.provider,
        model: context.model,
      },
    );
  });

  deps.engine.on('findings:ledger', (ledger, context) => {
    deps.analyticsEmitter.onFindingLedgerUpdated(ledger, context);
  });

  deps.engine.on('companion:start', (payload) => {
    deps.analyticsEmitter.onCompanionEvent('companion:start', payload);
    deps.out.info(`Companion start for step "${sanitizeTerminalText(payload.step)}"`);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      { type: 'companion', action: 'start', ...payload },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });
  deps.engine.on('companion:pool_selected', (payload) => {
    deps.analyticsEmitter.onCompanionEvent('companion:pool_selected', payload);
    deps.out.info(`Companion pool_selected for step "${sanitizeTerminalText(payload.step)}"`);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      { type: 'companion', action: 'pool_selected', ...payload },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });
  deps.engine.on('companion:finding', (payload) => {
    deps.analyticsEmitter.onCompanionEvent('companion:finding', payload);
    deps.out.info(`Companion finding for step "${sanitizeTerminalText(payload.step)}"`);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      { type: 'companion', action: 'finding', ...payload },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });
  deps.engine.on('companion:fix_round', (payload) => {
    deps.analyticsEmitter.onCompanionEvent('companion:fix_round', payload);
    deps.out.info(`Companion fix_round for step "${sanitizeTerminalText(payload.step)}"`);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      { type: 'companion', action: 'fix_round', ...payload },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });
  deps.engine.on('companion:complete', (payload) => {
    deps.analyticsEmitter.onCompanionEvent('companion:complete', payload);
    deps.out.info(`Companion complete for step "${sanitizeTerminalText(payload.step)}"`);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      { type: 'companion', action: 'complete', ...payload },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });
  deps.engine.on('companion:review_round', (payload) => {
    deps.analyticsEmitter.onCompanionEvent('companion:review_round', payload);
    deps.sessionLogger.onCompanionReviewRound(payload);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      { type: 'companion', action: 'review_round', ...payload },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });
  deps.engine.on('companion:queue_coalesced', (payload) => {
    deps.analyticsEmitter.onCompanionEvent('companion:queue_coalesced', payload);
    deps.sessionLogger.onCompanionQueueCoalesced(payload);
    emitWorkflowExecutionEvent(
      deps.eventSink,
      { type: 'companion', action: 'queue_coalesced', ...payload },
      onEventSinkFailure,
      eventSinkDispatchState,
    );
  });

  deps.engine.on('workflow:complete', (workflowState) => {
    if (terminalIntent === undefined) {
      terminalIntent = {
        kind: 'completed',
        workflowState,
        endTime: new Date().toISOString(),
      };
    }
    captureTerminalProjection(syncLatestResumePoint);
  });

  deps.engine.on('workflow:abort', (workflowState, reason, kind, failure) => {
    if (terminalIntent === undefined) {
      const runFailure: RunFailure = {
        step: failure.step,
        error: failure.error,
      };
      state.abortReason = reason;
      state.abortKind = kind;
      state.failure = runFailure;
      terminalIntent = {
        kind: 'aborted',
        workflowState,
        reason,
        abortKind: kind,
        failure: runFailure,
        status: resolveWorkflowAbortPublicationStatus(kind),
        endTime: new Date().toISOString(),
      };
    }
    captureTerminalCleanup(interruptAllQueries);
    captureTerminalProjection(syncLatestResumePoint);
    const display = deps.displayRef.current;
    if (display !== null) {
      deps.displayRef.current = null;
      captureTerminalCleanup(() => display.flush());
    }
    captureTerminalCleanup(() => deps.prefixWriter?.flush());
  });

  const createWorkflowFailureIntent = (
    iteration: number,
    reason: string,
    status: 'aborted' | 'failed',
  ): WorkflowTerminalIntent => ({
    kind: 'failure',
    iteration,
    reason,
    status,
    endTime: new Date().toISOString(),
  });

  const applyWorkflowFailureIntent = (
    intent: WorkflowTerminalIntent,
    reason: string,
  ): void => {
    state.abortReason = reason;
    state.abortKind = 'runtime_error';
    terminalIntent = intent;
    captureTerminalProjection(syncLatestResumePoint);
  };

  const stageWorkflowFailure = (
    iteration: number,
    reason: string,
    status: 'aborted' | 'failed',
  ): void => {
    if (
      terminalIntent?.kind === 'aborted'
      || terminalIntent?.kind === 'failure'
    ) {
      return;
    }
    applyWorkflowFailureIntent(
      createWorkflowFailureIntent(iteration, reason, status),
      reason,
    );
  };

  const stageHeartbeatFailure = (
    iteration: number,
    reason: string,
    status: 'aborted' | 'failed',
  ): void => {
    applyWorkflowFailureIntent(
      createWorkflowFailureIntent(iteration, reason, status),
      reason,
    );
  };

  const prepareTerminalPublicationPayload =
    (): WorkflowTerminalPublicationPayload => {
      if (preparedTerminalPublication !== undefined) {
        return preparedTerminalPublication;
      }
      if (terminalIntent === undefined) {
        throw new Error('Workflow terminal result was not staged');
      }
      const status = terminalIntent.kind === 'completed'
        ? 'completed'
        : terminalIntent.status;
      const iterations = terminalIntent.kind === 'failure'
        ? terminalIntent.iteration
        : terminalIntent.workflowState.iteration;
      const reason = terminalIntent.kind === 'completed'
        ? undefined
        : terminalIntent.reason;
      const failure = terminalIntent.kind === 'aborted'
        ? terminalIntent.failure
        : undefined;
      preparedTerminalPublication = deps.terminalPayloads.create({
        status,
        iterations,
        ...(reason === undefined ? {} : { reason }),
        ...(failure === undefined ? {} : { failure }),
        lastStepContent: state.lastStepContent,
        lastStepName: state.lastStepName,
        sessionLog: state.sessionLog,
        endTime: terminalIntent.endTime,
      });
      return preparedTerminalPublication;
    };

  return {
    state,
    syncLatestResumePoint,
    getFinalizationIssues: () => [...finalizationIssues],
    getStagedAbort: () => (
      terminalIntent?.kind === 'aborted'
        ? {
            iteration: terminalIntent.workflowState.iteration,
            reason: terminalIntent.reason,
            kind: terminalIntent.abortKind,
            status: terminalIntent.status,
          }
        : undefined
    ),
    emitRunStarted(event): void {
      emitWorkflowExecutionEvent(
        deps.eventSink,
        event,
        onEventSinkFailure,
        eventSinkDispatchState,
      );
    },
    stageWorkflowFailure,
    stageHeartbeatFailure,
    prepareTerminalPublicationPayload,
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
    emitTerminalFeedback(event): void {
      emitWorkflowExecutionEvent(
        deps.eventSink,
        event,
        onEventSinkFailure,
        eventSinkDispatchState,
      );
    },
    async flushEventSink(): Promise<void> {
      await eventSinkDispatchState.current;
    },
  };
}
