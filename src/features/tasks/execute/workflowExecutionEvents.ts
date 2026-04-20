import { interruptAllQueries } from '../../../infra/claude/query-manager.js';
import type { WorkflowResumePointEntry } from '../../../core/models/index.js';
import type { WorkflowEngine } from '../../../core/workflow/index.js';
import type { SessionLog } from '../../../infra/fs/index.js';
import type { StepProviderInfo } from '../../../core/workflow/types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { StreamDisplay } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { isDebugEnabled, isVerboseConsole } from '../../../shared/utils/debug.js';
import type { ExceededInfo, WorkflowExecutionOptions } from './types.js';
import { detectStepType, isQuietMode } from './workflowExecutionBootstrap.js';
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
  exceededInfo?: ExceededInfo;
  lastStepContent?: string;
  lastStepName?: string;
  lastResumePoint?: WorkflowExecutionOptions['resumePoint'];
  currentIteration: number;
  sessionLog: SessionLog;
}

interface WorkflowExecutionEventBridgeDeps {
  engine: WorkflowEngine;
  workflowConfig: {
    name: string;
    steps: Array<{ name: string }>;
    maxSteps: number;
  };
  task: string;
  projectCwd: string;
  currentProvider: string;
  configuredModel: string | undefined;
  out: ReturnType<typeof import('./outputFns.js').createOutputFns>;
  prefixWriter: import('../../../shared/ui/TaskPrefixWriter.js').TaskPrefixWriter | undefined;
  displayRef: { current: StreamDisplay | null };
  handlerRef: { current: ReturnType<StreamDisplay['createHandler']> | null };
  providerEventLogger: ReturnType<typeof import('../../../shared/utils/providerEventLogger.js').createProviderEventLogger>;
  usageEventLogger: ReturnType<typeof import('../../../shared/utils/usageEventLogger.js').createUsageEventLogger>;
  analyticsEmitter: import('./analyticsEmitter.js').AnalyticsEmitter;
  sessionLogger: import('./sessionLogger.js').SessionLogger;
  runMetaManager: import('./runMeta.js').RunMetaManager;
  ndjsonLogPath: string;
  shouldNotifyWorkflowComplete: boolean;
  shouldNotifyWorkflowAbort: boolean;
  writeTraceReportOnce: ReturnType<typeof import('./traceReportWriter.js').createTraceReportWriter>;
  getCurrentWorkflowStack: () => WorkflowResumePointEntry[] | undefined;
  initialResumePoint: WorkflowExecutionOptions['resumePoint'];
  sessionLog: SessionLog;
}

export interface WorkflowExecutionEventBridge {
  state: WorkflowExecutionEventState;
  syncLatestResumePoint: () => void;
}

type OutInfo = { info: (line: string) => void };

function sourceSuffix(
  path: string,
  sources: StepProviderInfo['providerOptionsSources'],
  showSource: boolean,
): string {
  if (!showSource) return '';
  const source = sources?.[path];
  return source ? ` (source: ${source})` : '';
}

function emitEffortLines(
  out: OutInfo,
  stepProvider: ProviderType,
  providerInfo: StepProviderInfo,
  showSource: boolean,
): void {
  const options = providerInfo.providerOptions;
  if (!options) return;
  const sources = providerInfo.providerOptionsSources;

  if (stepProvider === 'claude' || stepProvider === 'claude-sdk') {
    const effort = options.claude?.effort;
    if (effort !== undefined) {
      out.info(`Effort: ${effort}${sourceSuffix('claude.effort', sources, showSource)}`);
    }
  } else if (stepProvider === 'codex') {
    const effort = options.codex?.reasoningEffort;
    if (effort !== undefined) {
      out.info(`Reasoning effort: ${effort}${sourceSuffix('codex.reasoningEffort', sources, showSource)}`);
    }
  } else if (stepProvider === 'copilot') {
    const effort = options.copilot?.effort;
    if (effort !== undefined) {
      out.info(`Effort: ${effort}${sourceSuffix('copilot.effort', sources, showSource)}`);
    }
  }
}

export function bindWorkflowExecutionEvents(
  deps: WorkflowExecutionEventBridgeDeps,
): WorkflowExecutionEventBridge {
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
  const stepIterations = new Map<string, number>();
  const syncLatestResumePoint = (): void => {
    if (!canReadResumePoint()) {
      return;
    }
    state.lastResumePoint = getResumePoint();
    deps.runMetaManager.updateResumePoint(state.lastResumePoint);
  };

  deps.engine.on('phase:start', (step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration) => {
    deps.sessionLogger.onPhaseStart(
      step,
      phase,
      phaseName,
      instruction,
      promptParts,
      deps.getCurrentWorkflowStack(),
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('phase:complete', (step, phase, phaseName, content, phaseStatus, phaseError, phaseExecutionId, iteration) => {
    deps.sessionLogger.setIteration(state.currentIteration);
    deps.sessionLogger.onPhaseComplete(
      step,
      phase,
      phaseName,
      content,
      phaseStatus,
      phaseError,
      deps.getCurrentWorkflowStack(),
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('phase:judge_stage', (step, phase, phaseName, entry, phaseExecutionId, iteration) => {
    deps.sessionLogger.onJudgeStage(
      step,
      phase,
      phaseName,
      entry,
      deps.getCurrentWorkflowStack(),
      phaseExecutionId,
      iteration,
    );
  });

  deps.engine.on('step:start', (step, iteration, instruction, providerInfo) => {
    state.currentIteration = iteration;
    state.lastResumePoint = getResumePoint();
    deps.runMetaManager.updateStep(step.name, iteration, state.lastResumePoint);

    const stepIteration = (stepIterations.get(step.name) ?? 0) + 1;
    stepIterations.set(step.name, stepIteration);

    const safeStepName = sanitizeTerminalText(step.name);
    const safePersonaDisplayName = sanitizeTerminalText(step.personaDisplayName);
    deps.prefixWriter?.setStepContext({
      stepName: safeStepName,
      iteration,
      maxSteps: deps.workflowConfig.maxSteps,
      stepIteration,
    });
    deps.out.info(`[${iteration}/${deps.workflowConfig.maxSteps}] ${safeStepName} (${safePersonaDisplayName})`);

    const stepProvider = providerInfo.provider ?? deps.currentProvider;
    const stepModel = providerInfo.model ?? (stepProvider === deps.currentProvider ? deps.configuredModel : undefined) ?? '(default)';
    deps.providerEventLogger.setStep(step.name);
    deps.providerEventLogger.setProvider(stepProvider);
    deps.usageEventLogger.setStep(step.name, detectStepType(step));
    deps.usageEventLogger.setProvider(stepProvider, stepModel);
    const showSource = isDebugEnabled() || isVerboseConsole();
    const providerSourceSuffix = showSource && providerInfo.providerSource
      ? ` (source: ${providerInfo.providerSource})`
      : '';
    const modelSourceSuffix = showSource && providerInfo.modelSource
      ? ` (source: ${providerInfo.modelSource})`
      : '';
    deps.out.info(`Provider: ${stepProvider}${providerSourceSuffix}`);
    deps.out.info(`Model: ${stepModel}${modelSourceSuffix}`);
    emitEffortLines(deps.out, stepProvider, providerInfo, showSource);
    deps.analyticsEmitter.updateProviderInfo(iteration, stepProvider, stepModel);

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

    deps.sessionLogger.onStepStart(step, iteration, instruction, state.lastResumePoint?.stack, providerInfo);
  });

  deps.engine.on('step:complete', (step, response, instruction) => {
    syncLatestResumePoint();
    state.lastStepContent = response.content;
    state.lastStepName = step.name;

    if (deps.displayRef.current) {
      deps.displayRef.current.flush();
      deps.displayRef.current = null;
    }
    deps.prefixWriter?.flush();
    deps.out.blankLine();

    if (response.matchedRuleIndex != null && step.rules) {
      const rule = step.rules[response.matchedRuleIndex];
      const methodLabel = response.matchedRuleMethod ? ` (${response.matchedRuleMethod})` : '';
      deps.out.status('Status', rule ? `${rule.condition}${methodLabel}` : response.status);
    } else {
      deps.out.status('Status', response.status);
    }

    if (response.error) {
      deps.out.error(`Error: ${response.error}`);
    }
    if (response.sessionId) {
      deps.out.status('Session', response.sessionId);
    }

    updateUsageForStepCompletion(deps.usageEventLogger, response);
    deps.sessionLogger.onStepComplete(step, response, instruction, deps.getCurrentWorkflowStack());
    deps.analyticsEmitter.onStepComplete(step, response);
    state.sessionLog = { ...state.sessionLog, iterations: state.sessionLog.iterations + 1 };
  });

  deps.engine.on('step:report', (_step, filePath, fileName) => {
    reportStepFile(filePath, fileName, deps.out);
    deps.analyticsEmitter.onStepReport(_step, filePath);
  });

  deps.engine.on('workflow:complete', (workflowState) => {
    syncLatestResumePoint();
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
    );
  });

  deps.engine.on('workflow:abort', (workflowState, reason) => {
    interruptAllQueries();
    syncLatestResumePoint();
    if (deps.displayRef.current) {
      deps.displayRef.current.flush();
      deps.displayRef.current = null;
    }
    deps.prefixWriter?.flush();
    state.abortReason = reason;
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
    );
  });

  return {
    state,
    syncLatestResumePoint,
  };
}
