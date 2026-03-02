/**
 * Piece execution logic
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PieceEngine, createDenyAskUserQuestionHandler } from '../../../core/piece/index.js';
import type { PieceConfig } from '../../../core/models/index.js';
import type { PieceExecutionResult, PieceExecutionOptions } from './types.js';
import { detectRuleIndex } from '../../../shared/utils/ruleIndex.js';
import { interruptAllQueries } from '../../../infra/claude/query-manager.js';
import { callAiJudge } from '../../../agents/ai-judge.js';
import { loadPersonaSessions, updatePersonaSession, loadWorktreeSessions, updateWorktreeSession, resolvePieceConfigValues, saveSessionState, type SessionState } from '../../../infra/config/index.js';
import { isQuietMode } from '../../../shared/context.js';
import { StreamDisplay } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { generateSessionId, createSessionLog, finalizeSessionLog, initNdjsonLog } from '../../../infra/fs/index.js';
import { createLogger, notifySuccess, notifyError, preventSleep, generateReportDir, isValidReportDirName } from '../../../shared/utils/index.js';
import { createProviderEventLogger, isProviderEventsEnabled } from '../../../shared/utils/providerEventLogger.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { buildRunPaths } from '../../../core/piece/run/run-paths.js';
import { resolveRuntimeConfig } from '../../../core/runtime/runtime-environment.js';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import { initAnalyticsWriter } from '../../analytics/index.js';
import { SessionLogger } from './sessionLogger.js';
import { AbortHandler } from './abortHandler.js';
import { AnalyticsEmitter } from './analyticsEmitter.js';
import { createOutputFns, createPrefixedStreamHandler } from './outputFns.js';
import { RunMetaManager } from './runMeta.js';
import { createIterationLimitHandler, createUserInputHandler } from './iterationLimitHandler.js';

export type { PieceExecutionResult, PieceExecutionOptions };

const log = createLogger('piece');

function assertTaskPrefixPair(
  taskPrefix: string | undefined,
  taskColorIndex: number | undefined,
): void {
  if ((taskPrefix != null) !== (taskColorIndex != null)) {
    throw new Error('taskPrefix and taskColorIndex must be provided together');
  }
}

function truncate(str: string, maxLength: number): string {
  return str.length <= maxLength ? str : str.slice(0, maxLength) + '...';
}

function formatElapsedTime(startTime: string, endTime: string): string {
  const elapsedSec = (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000;
  if (elapsedSec < 60) return `${elapsedSec.toFixed(1)}s`;
  return `${Math.floor(elapsedSec / 60)}m ${Math.floor(elapsedSec % 60)}s`;
}

/**
 * Execute a piece and handle all events
 */
export async function executePiece(
  pieceConfig: PieceConfig,
  task: string,
  cwd: string,
  options: PieceExecutionOptions,
): Promise<PieceExecutionResult> {
  const { headerPrefix = 'Running Piece:', interactiveUserInput = false } = options;
  const projectCwd = options.projectCwd;
  assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);

  const prefixWriter = options.taskPrefix != null
    ? new TaskPrefixWriter({ taskName: options.taskPrefix, colorIndex: options.taskColorIndex!, displayLabel: options.taskDisplayLabel })
    : undefined;
  const out = createOutputFns(prefixWriter);

  const isRetry = Boolean(options.startMovement || options.retryNote);
  log.debug('Session mode', { isRetry, isWorktree: cwd !== projectCwd });
  out.header(`${headerPrefix} ${pieceConfig.name}`);

  const pieceSessionId = generateSessionId();
  const runSlug = options.reportDirName ?? generateReportDir(task);
  if (!isValidReportDirName(runSlug)) throw new Error(`Invalid reportDirName: ${runSlug}`);

  const runPaths = buildRunPaths(cwd, runSlug);
  const runMetaManager = new RunMetaManager(runPaths, task, pieceConfig.name);

  let sessionLog = createSessionLog(task, projectCwd, pieceConfig.name);
  const ndjsonLogPath = initNdjsonLog(pieceSessionId, task, pieceConfig.name, { logsDir: runPaths.logsAbs });
  const sessionLogger = new SessionLogger(ndjsonLogPath);

  if (options.interactiveMetadata) {
    sessionLogger.writeInteractiveMetadata(options.interactiveMetadata);
  }

  const displayRef: { current: StreamDisplay | null } = { current: null };
  const streamHandler = prefixWriter
    ? createPrefixedStreamHandler(prefixWriter)
    : (event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]): void => {
        if (!displayRef.current || event.type === 'result') return;
        displayRef.current.createHandler()(event);
      };

  const isWorktree = cwd !== projectCwd;
  const globalConfig = resolvePieceConfigValues(
    projectCwd,
    ['notificationSound', 'notificationSoundEvents', 'provider', 'runtime', 'preventSleep', 'model', 'observability', 'analytics'],
  );
  const shouldNotify = globalConfig.notificationSound !== false;
  const nse = globalConfig.notificationSoundEvents;
  const shouldNotifyIterationLimit = shouldNotify && nse?.iterationLimit !== false;
  const shouldNotifyPieceComplete = shouldNotify && nse?.pieceComplete !== false;
  const shouldNotifyPieceAbort = shouldNotify && nse?.pieceAbort !== false;
  const currentProvider = globalConfig.provider;
  if (!currentProvider) throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
  const configuredModel = options.model ?? globalConfig.model;

  const effectivePieceConfig: PieceConfig = { ...pieceConfig, runtime: resolveRuntimeConfig(globalConfig.runtime, pieceConfig.runtime) };
  const providerEventLogger = createProviderEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: pieceSessionId,
    runId: runSlug,
    provider: currentProvider,
    movement: options.startMovement ?? pieceConfig.initialMovement,
    enabled: isProviderEventsEnabled(globalConfig),
  });

  initAnalyticsWriter(globalConfig.analytics?.enabled === true, globalConfig.analytics?.eventsPath ?? join(getGlobalConfigDir(), 'analytics', 'events'));
  if (globalConfig.preventSleep) preventSleep();

  const analyticsEmitter = new AnalyticsEmitter(runSlug, currentProvider, configuredModel ?? '(default)');
  const savedSessions = isRetry
    ? (isWorktree ? loadWorktreeSessions(projectCwd, cwd, currentProvider) : loadPersonaSessions(projectCwd, currentProvider))
    : {};
  const sessionUpdateHandler = isWorktree
    ? (personaName: string, personaSessionId: string) => updateWorktreeSession(projectCwd, cwd, personaName, personaSessionId, currentProvider)
    : (persona: string, personaSessionId: string) => updatePersonaSession(projectCwd, persona, personaSessionId, currentProvider);

  const iterationLimitHandler = createIterationLimitHandler(out, displayRef, shouldNotifyIterationLimit);
  const onUserInput = interactiveUserInput ? createUserInputHandler(out, displayRef) : undefined;

  let abortReason: string | undefined;
  let lastMovementContent: string | undefined;
  let lastMovementName: string | undefined;
  let currentIteration = 0;
  const movementIterations = new Map<string, number>();
  let engine: PieceEngine | null = null;
  const runAbortController = new AbortController();
  const abortHandler = new AbortHandler({ externalSignal: options.abortSignal, internalController: runAbortController, getEngine: () => engine });

  try {
    engine = new PieceEngine(effectivePieceConfig, cwd, task, {
      abortSignal: runAbortController.signal,
      onStream: providerEventLogger.wrapCallback(streamHandler),
      onUserInput,
      initialSessions: savedSessions,
      onSessionUpdate: sessionUpdateHandler,
      onIterationLimit: iterationLimitHandler,
      onAskUserQuestion: createDenyAskUserQuestionHandler(),
      projectCwd,
      language: options.language,
      provider: options.provider,
      model: options.model,
      providerOptions: options.providerOptions,
      providerOptionsSource: options.providerOptionsSource,
      personaProviders: options.personaProviders,
      providerProfiles: options.providerProfiles,
      interactive: interactiveUserInput,
      detectRuleIndex,
      callAiJudge,
      startMovement: options.startMovement,
      retryNote: options.retryNote,
      reportDirName: runSlug,
      taskPrefix: options.taskPrefix,
      taskColorIndex: options.taskColorIndex,
    });

    abortHandler.install();

    engine.on('phase:start', (step, phase, phaseName, instruction) => {
      log.debug('Phase starting', { step: step.name, phase, phaseName });
      sessionLogger.onPhaseStart(step, phase, phaseName, instruction);
    });

    engine.on('phase:complete', (step, phase, phaseName, content, phaseStatus, phaseError) => {
      log.debug('Phase completed', { step: step.name, phase, phaseName, status: phaseStatus });
      sessionLogger.setIteration(currentIteration);
      sessionLogger.onPhaseComplete(step, phase, phaseName, content, phaseStatus, phaseError);
    });

    engine.on('movement:start', (step, iteration, instruction, providerInfo) => {
      log.debug('Movement starting', { step: step.name, persona: step.personaDisplayName, iteration });
      currentIteration = iteration;
      const movementIteration = (movementIterations.get(step.name) ?? 0) + 1;
      movementIterations.set(step.name, movementIteration);
      prefixWriter?.setMovementContext({ movementName: step.name, iteration, maxMovements: pieceConfig.maxMovements, movementIteration });
      out.info(`[${iteration}/${pieceConfig.maxMovements}] ${step.name} (${step.personaDisplayName})`);
      const movementProvider = providerInfo.provider ?? currentProvider;
      const movementModel = providerInfo.model ?? (movementProvider === currentProvider ? configuredModel : undefined) ?? '(default)';
      providerEventLogger.setMovement(step.name);
      providerEventLogger.setProvider(movementProvider);
      out.info(`Provider: ${movementProvider}`);
      out.info(`Model: ${movementModel}`);
      if (instruction) log.debug('Step instruction', instruction);
      analyticsEmitter.updateProviderInfo(iteration, movementProvider, movementModel);
      if (!prefixWriter) {
        const movementIndex = pieceConfig.movements.findIndex((m) => m.name === step.name);
        displayRef.current = new StreamDisplay(step.personaDisplayName, isQuietMode(), {
          iteration,
          maxMovements: pieceConfig.maxMovements,
          movementIndex: movementIndex >= 0 ? movementIndex : 0,
          totalMovements: pieceConfig.movements.length,
        });
      }
      sessionLogger.onMovementStart(step, iteration, instruction);
    });

    engine.on('movement:complete', (step, response, instruction) => {
      log.debug('Movement completed', { step: step.name, status: response.status, matchedRuleIndex: response.matchedRuleIndex, matchedRuleMethod: response.matchedRuleMethod, contentLength: response.content.length, sessionId: response.sessionId, error: response.error });
      lastMovementContent = response.content;
      lastMovementName = step.name;
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
      sessionLogger.onMovementComplete(step, response, instruction);
      analyticsEmitter.onMovementComplete(step, response);
      sessionLog = { ...sessionLog, iterations: sessionLog.iterations + 1 };
    });

    engine.on('movement:report', (step, filePath, fileName) => {
      out.logLine(`\n📄 Report: ${fileName}\n`);
      out.logLine(readFileSync(filePath, 'utf-8'));
      analyticsEmitter.onMovementReport(step, filePath);
    });

    engine.on('piece:complete', (state) => {
      log.info('Piece completed successfully', { iterations: state.iteration });
      sessionLog = finalizeSessionLog(sessionLog, 'completed');
      sessionLogger.onPieceComplete(state);
      runMetaManager.finalize('completed', state.iteration);
      try {
        saveSessionState(projectCwd, { status: 'success', taskResult: truncate(lastMovementContent ?? '', 1000), timestamp: new Date().toISOString(), pieceName: pieceConfig.name, taskContent: truncate(task, 200), lastMovement: lastMovementName } satisfies SessionState);
      } catch (error) { log.error('Failed to save session state', { error }); }
      const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
      out.success(`Piece completed (${state.iteration} iterations${elapsed ? `, ${elapsed}` : ''})`);
      out.info(`Session log: ${ndjsonLogPath}`);
      if (shouldNotifyPieceComplete) notifySuccess('TAKT', getLabel('piece.notifyComplete', undefined, { iteration: String(state.iteration) }));
    });

    engine.on('piece:abort', (state, reason) => {
      interruptAllQueries();
      log.error('Piece aborted', { reason, iterations: state.iteration });
      if (displayRef.current) { displayRef.current.flush(); displayRef.current = null; }
      prefixWriter?.flush();
      abortReason = reason;
      sessionLog = finalizeSessionLog(sessionLog, 'aborted');
      sessionLogger.onPieceAbort(state, reason);
      runMetaManager.finalize('aborted', state.iteration);
      try {
        saveSessionState(projectCwd, { status: reason === 'user_interrupted' ? 'user_stopped' : 'error', errorMessage: reason, timestamp: new Date().toISOString(), pieceName: pieceConfig.name, taskContent: truncate(task, 200), lastMovement: lastMovementName } satisfies SessionState);
      } catch (error) { log.error('Failed to save session state', { error }); }
      const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
      out.error(`Piece aborted after ${state.iteration} iterations${elapsed ? ` (${elapsed})` : ''}: ${reason}`);
      out.info(`Session log: ${ndjsonLogPath}`);
      if (shouldNotifyPieceAbort) notifyError('TAKT', getLabel('piece.notifyAbort', undefined, { reason }));
    });

    const finalState = await engine.run();
    return { success: finalState.status === 'completed', reason: abortReason, lastMovement: lastMovementName, lastMessage: lastMovementContent };
  } catch (error) {
    if (!runMetaManager.isFinalized) runMetaManager.finalize('aborted');
    throw error;
  } finally {
    prefixWriter?.flush();
    abortHandler.cleanup();
  }
}
