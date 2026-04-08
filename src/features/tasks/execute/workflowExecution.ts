import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine, createDenyAskUserQuestionHandler } from '../../../core/workflow/index.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowExecutionResult, WorkflowExecutionOptions, ExceededInfo } from './types.js';
import { DefaultStructuredCaller, PromptBasedStructuredCaller } from '../../../agents/structured-caller.js';
import { detectRuleIndex } from '../../../shared/utils/ruleIndex.js';
import { interruptAllQueries } from '../../../infra/claude/query-manager.js';
import { loadPersonaSessions, updatePersonaSession, loadWorktreeSessions, updateWorktreeSession, resolveWorkflowConfigValues, saveSessionState, type SessionState } from '../../../infra/config/index.js';
import { getProvider } from '../../../infra/providers/index.js';
import { isQuietMode } from '../../../shared/context.js';
import { StreamDisplay } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { generateSessionId, createSessionLog, finalizeSessionLog, initNdjsonLog } from '../../../infra/fs/index.js';
import { createLogger, notifySuccess, notifyError, preventSleep, generateReportDir, isValidReportDirName, getDebugPromptsLogFile } from '../../../shared/utils/index.js';
import { createProviderEventLogger, isProviderEventsEnabled } from '../../../shared/utils/providerEventLogger.js';
import { createUsageEventLogger, isUsageEventsEnabled } from '../../../shared/utils/usageEventLogger.js';
import { USAGE_MISSING_REASONS } from '../../../core/logging/contracts.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { resolveRuntimeConfig } from '../../../core/runtime/runtime-environment.js';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import { initAnalyticsWriter } from '../../analytics/index.js';
import { SessionLogger } from './sessionLogger.js';
import { AbortHandler } from './abortHandler.js';
import { AnalyticsEmitter } from './analyticsEmitter.js';
import { createOutputFns, createPrefixedStreamHandler } from './outputFns.js';
import { RunMetaManager } from './runMeta.js';
import { createIterationLimitHandler, createUserInputHandler } from './iterationLimitHandler.js';
import { assertTaskPrefixPair, truncate, formatElapsedTime, detectStepType } from './workflowExecutionUtils.js';
import { createTraceReportWriter } from './traceReportWriter.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
export type { WorkflowExecutionResult, WorkflowExecutionOptions }; const log = createLogger('workflow');
export async function executeWorkflow(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
): Promise<WorkflowExecutionResult> {
  const { headerPrefix = 'Running Workflow:', interactiveUserInput = false } = options;
  const projectCwd = options.projectCwd;
  const safeWorkflowName = sanitizeTerminalText(workflowConfig.name);
  assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);
  const prefixWriter = options.taskPrefix != null
    ? new TaskPrefixWriter({ taskName: options.taskPrefix, colorIndex: options.taskColorIndex!, displayLabel: options.taskDisplayLabel })
    : undefined;
  const out = createOutputFns(prefixWriter);
  const isRetry = Boolean(options.startStep || options.retryNote);
  log.debug('Session mode', { isRetry, isWorktree: cwd !== projectCwd });
  out.header(`${headerPrefix} ${safeWorkflowName}`);
  const workflowSessionId = generateSessionId();
  const runSlug = options.reportDirName ?? generateReportDir(task);
  if (!isValidReportDirName(runSlug)) throw new Error(`Invalid reportDirName: ${runSlug}`);
  const runPaths = buildRunPaths(cwd, runSlug);
  const runMetaManager = new RunMetaManager(runPaths, task, workflowConfig.name);
  let sessionLog = createSessionLog(task, projectCwd, workflowConfig.name);
  const displayRef: { current: StreamDisplay | null } = { current: null };
  const streamHandler = prefixWriter
    ? createPrefixedStreamHandler(prefixWriter)
    : (event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]): void => {
        if (!displayRef.current || event.type === 'result') return;
        displayRef.current.createHandler()(event);
      };
  const isWorktree = cwd !== projectCwd;
  const globalConfig = resolveWorkflowConfigValues(projectCwd, ['notificationSound', 'notificationSoundEvents', 'provider', 'runtime', 'preventSleep', 'model', 'logging', 'analytics']);
  const traceReportMode = globalConfig.logging?.trace === true ? 'full' : 'redacted';
  const allowSensitiveData = traceReportMode === 'full';
  const ndjsonLogPath = initNdjsonLog(
    workflowSessionId,
    sanitizeTextForStorage(task, allowSensitiveData),
    workflowConfig.name,
    { logsDir: runPaths.logsAbs },
  );
  const sessionLogger = new SessionLogger(ndjsonLogPath, allowSensitiveData);
  if (options.interactiveMetadata) sessionLogger.writeInteractiveMetadata(options.interactiveMetadata);
  const shouldNotify = globalConfig.notificationSound !== false;
  const shouldNotifyIterationLimit = shouldNotify && globalConfig.notificationSoundEvents?.iterationLimit !== false;
  const shouldNotifyWorkflowComplete = shouldNotify && globalConfig.notificationSoundEvents?.workflowComplete !== false;
  const shouldNotifyWorkflowAbort = shouldNotify && globalConfig.notificationSoundEvents?.workflowAbort !== false;
  const currentProvider = options.provider ?? globalConfig.provider;
  if (!currentProvider) throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
  const configuredModel = options.model ?? globalConfig.model;
  const effectiveWorkflowConfig: WorkflowConfig = {
    ...workflowConfig,
    runtime: resolveRuntimeConfig(globalConfig.runtime, workflowConfig.runtime),
    ...(options.maxStepsOverride !== undefined ? { maxSteps: options.maxStepsOverride } : {}),
  };
  const providerEventLogger = createProviderEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: workflowSessionId,
    runId: runSlug,
    provider: currentProvider,
    step: options.startStep ?? workflowConfig.initialStep,
    enabled: isProviderEventsEnabled(globalConfig),
  });
  const usageEventLogger = createUsageEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: workflowSessionId,
    runId: runSlug,
    provider: currentProvider,
    providerModel: configuredModel ?? '(default)',
    step: options.startStep ?? workflowConfig.initialStep,
    stepType: 'normal',
    enabled: isUsageEventsEnabled(globalConfig),
  });
  initAnalyticsWriter(globalConfig.analytics?.enabled === true, globalConfig.analytics?.eventsPath ?? join(getGlobalConfigDir(), 'analytics', 'events'));
  if (globalConfig.preventSleep) preventSleep();
  const analyticsEmitter = new AnalyticsEmitter(runSlug, currentProvider, configuredModel ?? '(default)');
  const structuredCaller = getProvider(currentProvider).supportsStructuredOutput
    ? new DefaultStructuredCaller()
    : new PromptBasedStructuredCaller();
  const savedSessions = isRetry ? (isWorktree
    ? loadWorktreeSessions(projectCwd, cwd, currentProvider)
    : loadPersonaSessions(projectCwd, currentProvider)) : {};
  const sessionUpdateHandler = isWorktree ? (personaName: string, personaSessionId: string) =>
    updateWorktreeSession(projectCwd, cwd, personaName, personaSessionId, currentProvider) : (persona: string, personaSessionId: string) =>
    updatePersonaSession(projectCwd, persona, personaSessionId, currentProvider);
  const iterationLimitHandler = createIterationLimitHandler(
    out,
    displayRef,
    shouldNotifyIterationLimit,
    (request) => {
      exceededInfo = {
        currentStep: request.currentStep,
        newMaxSteps: request.maxSteps + workflowConfig.maxSteps,
        currentIteration: request.currentIteration,
      };
    },
  );
  const onUserInput = interactiveUserInput ? createUserInputHandler(out, displayRef) : undefined;
  let abortReason: string | undefined;
  let exceededInfo: ExceededInfo | undefined;
  let lastStepContent: string | undefined;
  let lastStepName: string | undefined;
  const writeTraceReportOnce = createTraceReportWriter({
    sessionLogger,
    ndjsonLogPath,
    tracePath: join(runPaths.runRootAbs, 'trace.md'),
    workflowName: workflowConfig.name,
    task,
    runSlug,
    promptLogPath: getDebugPromptsLogFile() ?? undefined,
    mode: traceReportMode,
    logger: log,
  });
  let currentIteration = 0;
  const stepIterations = new Map<string, number>();
  let engine: WorkflowEngine | null = null;
  const runAbortController = new AbortController();
  const abortHandler = new AbortHandler({ externalSignal: options.abortSignal, internalController: runAbortController, getEngine: () => engine });
  try {
    engine = new WorkflowEngine(effectiveWorkflowConfig, cwd, task, {
      abortSignal: runAbortController.signal,
      onStream: providerEventLogger.wrapCallback(streamHandler),
      onUserInput,
      initialSessions: savedSessions,
      onSessionUpdate: sessionUpdateHandler,
      onIterationLimit: iterationLimitHandler,
      onAskUserQuestion: createDenyAskUserQuestionHandler(),
      projectCwd,
      language: options.language,
      provider: currentProvider,
      model: configuredModel,
      providerOptions: options.providerOptions,
      providerOptionsSource: options.providerOptionsSource,
      providerOptionsOriginResolver: options.providerOptionsOriginResolver,
      personaProviders: options.personaProviders,
      providerProfiles: options.providerProfiles,
      interactive: interactiveUserInput,
      detectRuleIndex,
      structuredCaller,
      startStep: options.startStep,
      retryNote: options.retryNote,
      reportDirName: runSlug,
      taskPrefix: options.taskPrefix,
      taskColorIndex: options.taskColorIndex,
      initialIteration: options.initialIterationOverride,
    });
    abortHandler.install();
    engine.on('phase:start', (step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration) => {
      log.debug('Phase starting', { step: step.name, phase, phaseName });
      sessionLogger.onPhaseStart(step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration);
    });
    engine.on('phase:complete', (step, phase, phaseName, content, phaseStatus, phaseError, phaseExecutionId, iteration) => {
      log.debug('Phase completed', { step: step.name, phase, phaseName, status: phaseStatus });
      sessionLogger.setIteration(currentIteration);
      sessionLogger.onPhaseComplete(step, phase, phaseName, content, phaseStatus, phaseError, phaseExecutionId, iteration);
    });
    engine.on('phase:judge_stage', (step, phase, phaseName, entry, phaseExecutionId, iteration) => {
      sessionLogger.onJudgeStage(step, phase, phaseName, entry, phaseExecutionId, iteration);
    });
    engine.on('step:start', (step, iteration, instruction, providerInfo) => {
      log.debug('Step starting', { step: step.name, persona: step.personaDisplayName, iteration });
      currentIteration = iteration;
      const stepIteration = (stepIterations.get(step.name) ?? 0) + 1;
      stepIterations.set(step.name, stepIteration);
      const safeStepName = sanitizeTerminalText(step.name);
      const safePersonaDisplayName = sanitizeTerminalText(step.personaDisplayName);
      prefixWriter?.setStepContext({ stepName: safeStepName, iteration, maxSteps: effectiveWorkflowConfig.maxSteps, stepIteration });
      out.info(`[${iteration}/${effectiveWorkflowConfig.maxSteps}] ${safeStepName} (${safePersonaDisplayName})`);
      const stepProvider = providerInfo.provider ?? currentProvider;
      const stepModel = providerInfo.model ?? (stepProvider === currentProvider ? configuredModel : undefined) ?? '(default)';
      providerEventLogger.setStep(step.name);
      providerEventLogger.setProvider(stepProvider);
      usageEventLogger.setStep(step.name, detectStepType(step));
      usageEventLogger.setProvider(stepProvider, stepModel);
      out.info(`Provider: ${stepProvider}`);
      out.info(`Model: ${stepModel}`);
      if (instruction) log.debug('Step instruction', instruction);
      analyticsEmitter.updateProviderInfo(iteration, stepProvider, stepModel);
      if (!prefixWriter) {
        const stepIndex = workflowConfig.steps.findIndex((workflowStep) => workflowStep.name === step.name);
        displayRef.current = new StreamDisplay(safePersonaDisplayName, isQuietMode(), { iteration, maxSteps: effectiveWorkflowConfig.maxSteps, stepIndex: stepIndex >= 0 ? stepIndex : 0, totalSteps: workflowConfig.steps.length });
      }
      sessionLogger.onStepStart(step, iteration, instruction);
    });
    engine.on('step:complete', (step, response, instruction) => {
      log.debug('Step completed', { step: step.name, status: response.status, matchedRuleIndex: response.matchedRuleIndex, matchedRuleMethod: response.matchedRuleMethod, contentLength: response.content.length, sessionId: response.sessionId, error: response.error });
      lastStepContent = response.content;
      lastStepName = step.name;
      if (displayRef.current) { displayRef.current.flush(); displayRef.current = null; }
      prefixWriter?.flush();
      out.blankLine();
      if (response.matchedRuleIndex != null && step.rules) {
        const rule = step.rules[response.matchedRuleIndex];
        const methodLabel = response.matchedRuleMethod ? ` (${response.matchedRuleMethod})` : '';
        out.status('Status', rule ? `${rule.condition}${methodLabel}` : response.status);
      } else {
        out.status('Status', response.status);
      }
      if (response.error) out.error(`Error: ${response.error}`);
      if (response.sessionId) out.status('Session', response.sessionId);
      usageEventLogger.logUsage({ success: response.status === 'done', usage: response.providerUsage ?? { usageMissing: true, reason: USAGE_MISSING_REASONS.NOT_AVAILABLE } });
      sessionLogger.onStepComplete(step, response, instruction);
      analyticsEmitter.onStepComplete(step, response);
      sessionLog = { ...sessionLog, iterations: sessionLog.iterations + 1 };
    });
    engine.on('step:report', (step, filePath, fileName) => {
      out.logLine(`\n📄 Report: ${fileName}\n`);
      out.logLine(readFileSync(filePath, 'utf-8'));
      analyticsEmitter.onStepReport(step, filePath);
    });
    engine.on('workflow:complete', (state) => {
      log.info('Workflow completed successfully', { iterations: state.iteration });
      sessionLog = finalizeSessionLog(sessionLog, 'completed');
      sessionLogger.onWorkflowComplete(state);
      runMetaManager.finalize('completed', state.iteration);
      writeTraceReportOnce({
        status: 'completed',
        iterations: state.iteration,
        endTime: new Date().toISOString(),
      });
      try {
        saveSessionState(projectCwd, { status: 'success', taskResult: truncate(lastStepContent ?? '', 1000), timestamp: new Date().toISOString(), workflowName: workflowConfig.name, taskContent: truncate(task, 200), lastStep: lastStepName } satisfies SessionState);
      } catch (error) { log.error('Failed to save session state', { error }); }
      const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
      out.success(`Workflow completed (${state.iteration} iterations${elapsed ? `, ${elapsed}` : ''})`);
      out.info(`Session log: ${ndjsonLogPath}`);
      if (shouldNotifyWorkflowComplete) notifySuccess('TAKT', getLabel('workflow.notifyComplete', undefined, { iteration: String(state.iteration) }));
    });
    engine.on('workflow:abort', (state, reason) => {
      interruptAllQueries();
      log.error('Workflow aborted', { reason, iterations: state.iteration });
      if (displayRef.current) { displayRef.current.flush(); displayRef.current = null; }
      prefixWriter?.flush();
      abortReason = reason;
      sessionLog = finalizeSessionLog(sessionLog, 'aborted');
      sessionLogger.onWorkflowAbort(state, reason);
      runMetaManager.finalize('aborted', state.iteration);
      writeTraceReportOnce({
        status: 'aborted',
        iterations: state.iteration,
        reason,
        endTime: new Date().toISOString(),
      });
      try {
        saveSessionState(projectCwd, { status: reason === 'user_interrupted' ? 'user_stopped' : 'error', errorMessage: reason, timestamp: new Date().toISOString(), workflowName: workflowConfig.name, taskContent: truncate(task, 200), lastStep: lastStepName } satisfies SessionState);
      } catch (error) { log.error('Failed to save session state', { error }); }
      const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
      out.error(`Workflow aborted after ${state.iteration} iterations${elapsed ? ` (${elapsed})` : ''}: ${reason}`);
      out.info(`Session log: ${ndjsonLogPath}`);
      if (shouldNotifyWorkflowAbort) notifyError('TAKT', getLabel('workflow.notifyAbort', undefined, { reason }));
    });
    const finalState = await engine.run();
    return {
      success: finalState.status === 'completed',
      reason: abortReason,
      lastStep: lastStepName,
      lastMessage: lastStepContent,
      exceeded: exceededInfo != null,
      ...(exceededInfo ? { exceededInfo } : {}),
    };
  } catch (error) {
    if (!runMetaManager.isFinalized) runMetaManager.finalize('aborted');
    throw error;
  } finally { prefixWriter?.flush(); abortHandler.cleanup(); }
}
