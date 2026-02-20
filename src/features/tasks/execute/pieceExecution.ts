/**
 * Piece execution logic
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PieceEngine, type IterationLimitRequest, type UserInputRequest } from '../../../core/piece/index.js';
import type { PieceConfig } from '../../../core/models/index.js';
import type { PieceExecutionResult, PieceExecutionOptions } from './types.js';
import { detectRuleIndex } from '../../../shared/utils/ruleIndex.js';
import { interruptAllQueries } from '../../../infra/claude/query-manager.js';
import { callAiJudge } from '../../../agents/ai-judge.js';

export type { PieceExecutionResult, PieceExecutionOptions };

import {
  loadPersonaSessions,
  updatePersonaSession,
  loadWorktreeSessions,
  updateWorktreeSession,
  resolvePieceConfigValues,
  saveSessionState,
  type SessionState,
} from '../../../infra/config/index.js';
import { isQuietMode } from '../../../shared/context.js';
import {
  header as rawHeader,
  info as rawInfo,
  warn as rawWarn,
  error as rawError,
  success as rawSuccess,
  status as rawStatus,
  blankLine as rawBlankLine,
  StreamDisplay,
} from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import {
  generateSessionId,
  createSessionLog,
  finalizeSessionLog,
  initNdjsonLog,
  appendNdjsonLine,
  type NdjsonStepStart,
  type NdjsonStepComplete,
  type NdjsonPieceComplete,
  type NdjsonPieceAbort,
  type NdjsonPhaseStart,
  type NdjsonPhaseComplete,
  type NdjsonInteractiveStart,
  type NdjsonInteractiveEnd,
} from '../../../infra/fs/index.js';
import {
  createLogger,
  notifySuccess,
  notifyError,
  preventSleep,
  playWarningSound,
  isDebugEnabled,
  writePromptLog,
  generateReportDir,
  isValidReportDirName,
} from '../../../shared/utils/index.js';
import type { PromptLogRecord } from '../../../shared/utils/index.js';
import {
  createProviderEventLogger,
  isProviderEventsEnabled,
} from '../../../shared/utils/providerEventLogger.js';
import { selectOption, promptInput } from '../../../shared/prompt/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import { ShutdownManager } from './shutdownManager.js';
import { buildRunPaths } from '../../../core/piece/run/run-paths.js';
import { resolveMovementProviderModel } from '../../../core/piece/provider-resolution.js';
import { resolveRuntimeConfig } from '../../../core/runtime/runtime-environment.js';
import { writeFileAtomic, ensureDir } from '../../../infra/config/index.js';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import {
  initAnalyticsWriter,
  writeAnalyticsEvent,
  parseFindingsFromReport,
  extractDecisionFromReport,
  inferSeverity,
  emitFixActionEvents,
  emitRebuttalEvents,
} from '../../analytics/index.js';
import type { MovementResultEvent, ReviewFindingEvent } from '../../analytics/index.js';

const log = createLogger('piece');

/**
 * Output facade — routes through TaskPrefixWriter when task prefix is active,
 * or falls through to the raw module functions for single-task execution.
 */
interface OutputFns {
  header: (title: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  status: (label: string, value: string, color?: 'green' | 'yellow' | 'red') => void;
  blankLine: () => void;
  logLine: (text: string) => void;
}

interface RunMeta {
  task: string;
  piece: string;
  runSlug: string;
  runRoot: string;
  reportDirectory: string;
  contextDirectory: string;
  logsDirectory: string;
  status: 'running' | 'completed' | 'aborted';
  startTime: string;
  endTime?: string;
  iterations?: number;
}

function assertTaskPrefixPair(
  taskPrefix: string | undefined,
  taskColorIndex: number | undefined
): void {
  const hasTaskPrefix = taskPrefix != null;
  const hasTaskColorIndex = taskColorIndex != null;
  if (hasTaskPrefix !== hasTaskColorIndex) {
    throw new Error('taskPrefix and taskColorIndex must be provided together');
  }
}

function toJudgmentMatchMethod(
  matchedRuleMethod: string | undefined,
): string | undefined {
  if (!matchedRuleMethod) return undefined;
  if (matchedRuleMethod === 'structured_output') return 'structured_output';
  if (matchedRuleMethod === 'ai_judge' || matchedRuleMethod === 'ai_judge_fallback') return 'ai_judge';
  if (matchedRuleMethod === 'phase3_tag' || matchedRuleMethod === 'phase1_tag') return 'tag_fallback';
  return undefined;
}

function createOutputFns(prefixWriter: TaskPrefixWriter | undefined): OutputFns {
  if (!prefixWriter) {
    return {
      header: rawHeader,
      info: rawInfo,
      warn: rawWarn,
      error: rawError,
      success: rawSuccess,
      status: rawStatus,
      blankLine: rawBlankLine,
      logLine: (text: string) => console.log(text),
    };
  }
  return {
    header: (title: string) => prefixWriter.writeLine(`=== ${title} ===`),
    info: (message: string) => prefixWriter.writeLine(`[INFO] ${message}`),
    warn: (message: string) => prefixWriter.writeLine(`[WARN] ${message}`),
    error: (message: string) => prefixWriter.writeLine(`[ERROR] ${message}`),
    success: (message: string) => prefixWriter.writeLine(message),
    status: (label: string, value: string) => prefixWriter.writeLine(`${label}: ${value}`),
    blankLine: () => prefixWriter.writeLine(''),
    logLine: (text: string) => prefixWriter.writeLine(text),
  };
}

/**
 * Create a stream handler that routes all stream events through TaskPrefixWriter.
 * Text and tool_output are line-buffered; block events are output per-line with prefix.
 */
function createPrefixedStreamHandler(
  writer: TaskPrefixWriter,
): (event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]) => void {
  return (event) => {
    switch (event.type) {
      case 'text':
        writer.writeChunk(event.data.text);
        break;
      case 'tool_use':
        writer.writeLine(`[tool] ${event.data.tool}`);
        break;
      case 'tool_result': {
        const label = event.data.isError ? '✗' : '✓';
        writer.writeLine(`  ${label} ${event.data.content}`);
        break;
      }
      case 'tool_output':
        writer.writeChunk(event.data.output);
        break;
      case 'thinking':
        writer.writeChunk(event.data.thinking);
        break;
      case 'init':
      case 'result':
      case 'error':
        break;
    }
  };
}

/**
 * Truncate string to maximum length
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '...';
}

/**
 * Format elapsed time in human-readable format
 */
function formatElapsedTime(startTime: string, endTime: string): string {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const elapsedMs = end - start;
  const elapsedSec = elapsedMs / 1000;

  if (elapsedSec < 60) {
    return `${elapsedSec.toFixed(1)}s`;
  }

  const minutes = Math.floor(elapsedSec / 60);
  const seconds = Math.floor(elapsedSec % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Execute a piece and handle all events
 */
export async function executePiece(
  pieceConfig: PieceConfig,
  task: string,
  cwd: string,
  options: PieceExecutionOptions
): Promise<PieceExecutionResult> {
  const {
    headerPrefix = 'Running Piece:',
    interactiveUserInput = false,
  } = options;

  // projectCwd is where .takt/ lives (project root, not the clone)
  const projectCwd = options.projectCwd;
  assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);

  // When taskPrefix is set (parallel execution), route all output through TaskPrefixWriter
  const prefixWriter = options.taskPrefix != null
    ? new TaskPrefixWriter({
      taskName: options.taskPrefix,
      colorIndex: options.taskColorIndex!,
      displayLabel: options.taskDisplayLabel,
    })
    : undefined;
  const out = createOutputFns(prefixWriter);

  // Retry reuses saved sessions; normal runs start fresh
  const isRetry = Boolean(options.startMovement || options.retryNote);
  log.debug('Session mode', { isRetry, isWorktree: cwd !== projectCwd });

  out.header(`${headerPrefix} ${pieceConfig.name}`);

  const pieceSessionId = generateSessionId();
  const runSlug = options.reportDirName ?? generateReportDir(task);
  if (!isValidReportDirName(runSlug)) {
    throw new Error(`Invalid reportDirName: ${runSlug}`);
  }
  const runPaths = buildRunPaths(cwd, runSlug);

  const runMeta: RunMeta = {
    task,
    piece: pieceConfig.name,
    runSlug: runPaths.slug,
    runRoot: runPaths.runRootRel,
    reportDirectory: runPaths.reportsRel,
    contextDirectory: runPaths.contextRel,
    logsDirectory: runPaths.logsRel,
    status: 'running',
    startTime: new Date().toISOString(),
  };
  ensureDir(runPaths.runRootAbs);
  writeFileAtomic(runPaths.metaAbs, JSON.stringify(runMeta, null, 2));
  let isMetaFinalized = false;
  const finalizeRunMeta = (status: 'completed' | 'aborted', iterations?: number): void => {
    writeFileAtomic(runPaths.metaAbs, JSON.stringify({
      ...runMeta,
      status,
      endTime: new Date().toISOString(),
      ...(iterations != null ? { iterations } : {}),
    } satisfies RunMeta, null, 2));
    isMetaFinalized = true;
  };

  let sessionLog = createSessionLog(task, projectCwd, pieceConfig.name);

  // Initialize NDJSON log file at run-scoped logs directory
  const ndjsonLogPath = initNdjsonLog(pieceSessionId, task, pieceConfig.name, {
    logsDir: runPaths.logsAbs,
  });

  // Write interactive mode records if interactive mode was used before this piece
  if (options.interactiveMetadata) {
    const startRecord: NdjsonInteractiveStart = {
      type: 'interactive_start',
      timestamp: new Date().toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, startRecord);

    const endRecord: NdjsonInteractiveEnd = {
      type: 'interactive_end',
      confirmed: options.interactiveMetadata.confirmed,
      ...(options.interactiveMetadata.task ? { task: options.interactiveMetadata.task } : {}),
      timestamp: new Date().toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, endRecord);
  }

  // Track current display for streaming
  const displayRef: { current: StreamDisplay | null } = { current: null };

  // Create stream handler — when prefixWriter is active, use it for line-buffered
  // output to prevent mid-line interleaving between concurrent tasks.
  // When not in parallel mode, delegate to StreamDisplay as before.
  const streamHandler = prefixWriter
    ? createPrefixedStreamHandler(prefixWriter)
    : (event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]): void => {
        if (!displayRef.current) return;
        if (event.type === 'result') return;
        displayRef.current.createHandler()(event);
      };

  // Load saved agent sessions only on retry; normal runs start with empty sessions
  const isWorktree = cwd !== projectCwd;
  const globalConfig = resolvePieceConfigValues(
    projectCwd,
    ['notificationSound', 'notificationSoundEvents', 'provider', 'runtime', 'preventSleep', 'model', 'observability', 'analytics'],
  );
  const shouldNotify = globalConfig.notificationSound !== false;
  const notificationSoundEvents = globalConfig.notificationSoundEvents;
  const shouldNotifyIterationLimit = shouldNotify && notificationSoundEvents?.iterationLimit !== false;
  const shouldNotifyPieceComplete = shouldNotify && notificationSoundEvents?.pieceComplete !== false;
  const shouldNotifyPieceAbort = shouldNotify && notificationSoundEvents?.pieceAbort !== false;
  const currentProvider = globalConfig.provider;
  const effectivePieceConfig: PieceConfig = {
    ...pieceConfig,
    runtime: resolveRuntimeConfig(globalConfig.runtime, pieceConfig.runtime),
  };
  const providerEventLogger = createProviderEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: pieceSessionId,
    runId: runSlug,
    provider: currentProvider,
    movement: options.startMovement ?? pieceConfig.initialMovement,
    enabled: isProviderEventsEnabled(globalConfig),
  });

  const analyticsEnabled = globalConfig.analytics?.enabled === true;
  const eventsDir = globalConfig.analytics?.eventsPath
    ?? join(getGlobalConfigDir(), 'analytics', 'events');
  initAnalyticsWriter(analyticsEnabled, eventsDir);

  // Prevent macOS idle sleep if configured
  if (globalConfig.preventSleep) {
    preventSleep();
  }
  const savedSessions = isRetry
    ? (isWorktree
        ? loadWorktreeSessions(projectCwd, cwd, currentProvider)
        : loadPersonaSessions(projectCwd, currentProvider))
    : {};

  // Session update handler - persist session IDs when they change
  // Clone sessions are stored separately per clone path
  const sessionUpdateHandler = isWorktree
    ? (personaName: string, personaSessionId: string): void => {
        updateWorktreeSession(projectCwd, cwd, personaName, personaSessionId, currentProvider);
      }
    : (persona: string, personaSessionId: string): void => {
        updatePersonaSession(projectCwd, persona, personaSessionId, currentProvider);
      };

  const iterationLimitHandler = async (
    request: IterationLimitRequest
  ): Promise<number | null> => {
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }

    out.blankLine();
    out.warn(
      getLabel('piece.iterationLimit.maxReached', undefined, {
        currentIteration: String(request.currentIteration),
        maxMovements: String(request.maxMovements),
      })
    );
    out.info(getLabel('piece.iterationLimit.currentMovement', undefined, { currentMovement: request.currentMovement }));

    if (shouldNotifyIterationLimit) {
      playWarningSound();
    }

    const action = await selectOption(getLabel('piece.iterationLimit.continueQuestion'), [
      {
        label: getLabel('piece.iterationLimit.continueLabel'),
        value: 'continue',
        description: getLabel('piece.iterationLimit.continueDescription'),
      },
      { label: getLabel('piece.iterationLimit.stopLabel'), value: 'stop' },
    ]);

    if (action !== 'continue') {
      return null;
    }

    while (true) {
      const input = await promptInput(getLabel('piece.iterationLimit.inputPrompt'));
      if (!input) {
        return null;
      }

      const additionalIterations = Number.parseInt(input, 10);
      if (Number.isInteger(additionalIterations) && additionalIterations > 0) {
        pieceConfig.maxMovements = request.maxMovements + additionalIterations;
        return additionalIterations;
      }

      out.warn(getLabel('piece.iterationLimit.invalidInput'));
    }
  };

  const onUserInput = interactiveUserInput
    ? async (request: UserInputRequest): Promise<string | null> => {
        if (displayRef.current) {
          displayRef.current.flush();
          displayRef.current = null;
        }
        out.blankLine();
        out.info(request.prompt.trim());
        const input = await promptInput(getLabel('piece.iterationLimit.userInputPrompt'));
        return input && input.trim() ? input.trim() : null;
      }
    : undefined;

  let abortReason: string | undefined;
  let lastMovementContent: string | undefined;
  let lastMovementName: string | undefined;
  let currentIteration = 0;
  let currentMovementProvider = currentProvider;
  let currentMovementModel = globalConfig.model ?? '(default)';
  const phasePrompts = new Map<string, string>();
  const movementIterations = new Map<string, number>();
  let engine: PieceEngine | null = null;
  let onAbortSignal: (() => void) | undefined;
  let shutdownManager: ShutdownManager | undefined;
  let onEpipe: ((err: NodeJS.ErrnoException) => void) | undefined;
  const runAbortController = new AbortController();

  try {
    engine = new PieceEngine(effectivePieceConfig, cwd, task, {
      abortSignal: runAbortController.signal,
      onStream: providerEventLogger.wrapCallback(streamHandler),
      onUserInput,
      initialSessions: savedSessions,
      onSessionUpdate: sessionUpdateHandler,
      onIterationLimit: iterationLimitHandler,
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

    engine.on('phase:start', (step, phase, phaseName, instruction) => {
    log.debug('Phase starting', { step: step.name, phase, phaseName });
    const record: NdjsonPhaseStart = {
      type: 'phase_start',
      step: step.name,
      phase,
      phaseName,
      timestamp: new Date().toISOString(),
      ...(instruction ? { instruction } : {}),
    };
    appendNdjsonLine(ndjsonLogPath, record);

    if (isDebugEnabled()) {
      phasePrompts.set(`${step.name}:${phase}`, instruction);
    }
  });

    engine.on('phase:complete', (step, phase, phaseName, content, phaseStatus, phaseError) => {
    log.debug('Phase completed', { step: step.name, phase, phaseName, status: phaseStatus });
    const record: NdjsonPhaseComplete = {
      type: 'phase_complete',
      step: step.name,
      phase,
      phaseName,
      status: phaseStatus,
      content,
      timestamp: new Date().toISOString(),
      ...(phaseError ? { error: phaseError } : {}),
    };
    appendNdjsonLine(ndjsonLogPath, record);

    const promptKey = `${step.name}:${phase}`;
    const prompt = phasePrompts.get(promptKey);
    phasePrompts.delete(promptKey);

    if (isDebugEnabled()) {
      if (prompt) {
        const promptRecord: PromptLogRecord = {
          movement: step.name,
          phase,
          iteration: currentIteration,
          prompt,
          response: content,
          timestamp: new Date().toISOString(),
        };
        writePromptLog(promptRecord);
      }
    }
  });

    engine.on('movement:start', (step, iteration, instruction) => {
    log.debug('Movement starting', { step: step.name, persona: step.personaDisplayName, iteration });
    currentIteration = iteration;
    const movementIteration = (movementIterations.get(step.name) ?? 0) + 1;
    movementIterations.set(step.name, movementIteration);
    prefixWriter?.setMovementContext({
      movementName: step.name,
      iteration,
      maxMovements: pieceConfig.maxMovements,
      movementIteration,
    });
    out.info(`[${iteration}/${pieceConfig.maxMovements}] ${step.name} (${step.personaDisplayName})`);
    const resolved = resolveMovementProviderModel({
      step,
      provider: options.provider,
      model: options.model,
      personaProviders: options.personaProviders,
    });
    const movementProvider = resolved.provider ?? 'claude';
    const resolvedModel = resolved.model;
    const movementModel = resolvedModel ?? '(default)';
    currentMovementProvider = movementProvider;
    currentMovementModel = movementModel;
    providerEventLogger.setMovement(step.name);
    providerEventLogger.setProvider(movementProvider);
    out.info(`Provider: ${movementProvider}`);
    out.info(`Model: ${movementModel}`);

    // Log prompt content for debugging
    if (instruction) {
      log.debug('Step instruction', instruction);
    }

    // Find movement index for progress display
    const movementIndex = pieceConfig.movements.findIndex((m) => m.name === step.name);
    const totalMovements = pieceConfig.movements.length;

    // In parallel mode, StreamDisplay is not used (prefixWriter handles output).
    // In single mode, StreamDisplay renders stream events directly.
    if (!prefixWriter) {
      const quiet = isQuietMode();
      const agentLabel = step.personaDisplayName;
      displayRef.current = new StreamDisplay(agentLabel, quiet, {
        iteration,
        maxMovements: pieceConfig.maxMovements,
        movementIndex: movementIndex >= 0 ? movementIndex : 0,
        totalMovements,
      });
    }

    // Write step_start record to NDJSON log
    const record: NdjsonStepStart = {
      type: 'step_start',
      step: step.name,
      persona: step.personaDisplayName,
      iteration,
      timestamp: new Date().toISOString(),
      ...(instruction ? { instruction } : {}),
    };
    appendNdjsonLine(ndjsonLogPath, record);

  });

    engine.on('movement:complete', (step, response, instruction) => {
    log.debug('Movement completed', {
      step: step.name,
      status: response.status,
      matchedRuleIndex: response.matchedRuleIndex,
      matchedRuleMethod: response.matchedRuleMethod,
      contentLength: response.content.length,
      sessionId: response.sessionId,
      error: response.error,
    });

    // Capture last movement output for session state
    lastMovementContent = response.content;
    lastMovementName = step.name;

    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }
    prefixWriter?.flush();
    out.blankLine();

    if (response.matchedRuleIndex != null && step.rules) {
      const rule = step.rules[response.matchedRuleIndex];
      if (rule) {
        const methodLabel = response.matchedRuleMethod ? ` (${response.matchedRuleMethod})` : '';
        out.status('Status', `${rule.condition}${methodLabel}`);
      } else {
        out.status('Status', response.status);
      }
    } else {
      out.status('Status', response.status);
    }

    if (response.error) {
      out.error(`Error: ${response.error}`);
    }
    if (response.sessionId) {
      out.status('Session', response.sessionId);
    }

    // Write step_complete record to NDJSON log
    const matchMethod = toJudgmentMatchMethod(response.matchedRuleMethod);
    const record: NdjsonStepComplete = {
      type: 'step_complete',
      step: step.name,
      persona: response.persona,
      status: response.status,
      content: response.content,
      instruction,
      ...(response.matchedRuleIndex != null ? { matchedRuleIndex: response.matchedRuleIndex } : {}),
      ...(response.matchedRuleMethod ? { matchedRuleMethod: response.matchedRuleMethod } : {}),
      ...(matchMethod ? { matchMethod } : {}),
      ...(response.error ? { error: response.error } : {}),
      timestamp: response.timestamp.toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, record);

    const decisionTag = (response.matchedRuleIndex != null && step.rules)
      ? (step.rules[response.matchedRuleIndex]?.condition ?? response.status)
      : response.status;
    const movementResultEvent: MovementResultEvent = {
      type: 'movement_result',
      movement: step.name,
      provider: currentMovementProvider,
      model: currentMovementModel,
      decisionTag,
      iteration: currentIteration,
      runId: runSlug,
      timestamp: response.timestamp.toISOString(),
    };
    writeAnalyticsEvent(movementResultEvent);

    if (step.edit === true && step.name.includes('fix')) {
      emitFixActionEvents(response.content, currentIteration, runSlug, response.timestamp);
    }

    if (step.name.includes('no_fix')) {
      emitRebuttalEvents(response.content, currentIteration, runSlug, response.timestamp);
    }

    // Update in-memory log for pointer metadata (immutable)
    sessionLog = { ...sessionLog, iterations: sessionLog.iterations + 1 };
  });

    engine.on('movement:report', (step, filePath, fileName) => {
    const content = readFileSync(filePath, 'utf-8');
    out.logLine(`\n📄 Report: ${fileName}\n`);
    out.logLine(content);

    if (step.edit === false) {
      const decision = extractDecisionFromReport(content);
      if (decision) {
        const findings = parseFindingsFromReport(content);
        for (const finding of findings) {
          const event: ReviewFindingEvent = {
            type: 'review_finding',
            findingId: finding.findingId,
            status: finding.status,
            ruleId: finding.ruleId,
            severity: inferSeverity(finding.findingId),
            decision,
            file: finding.file,
            line: finding.line,
            iteration: currentIteration,
            runId: runSlug,
            timestamp: new Date().toISOString(),
          };
          writeAnalyticsEvent(event);
        }
      }
    }
  });

    engine.on('piece:complete', (state) => {
    log.info('Piece completed successfully', { iterations: state.iteration });
    sessionLog = finalizeSessionLog(sessionLog, 'completed');

    // Write piece_complete record to NDJSON log
    const record: NdjsonPieceComplete = {
      type: 'piece_complete',
      iterations: state.iteration,
      endTime: new Date().toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, record);
      finalizeRunMeta('completed', state.iteration);

    // Save session state for next interactive mode
    try {
      const sessionState: SessionState = {
        status: 'success',
        taskResult: truncate(lastMovementContent ?? '', 1000),
        timestamp: new Date().toISOString(),
        pieceName: pieceConfig.name,
        taskContent: truncate(task, 200),
        lastMovement: lastMovementName,
      };
      saveSessionState(projectCwd, sessionState);
    } catch (error) {
      log.error('Failed to save session state', { error });
    }

    const elapsed = sessionLog.endTime
      ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime)
      : '';
    const elapsedDisplay = elapsed ? `, ${elapsed}` : '';

    out.success(`Piece completed (${state.iteration} iterations${elapsedDisplay})`);
    out.info(`Session log: ${ndjsonLogPath}`);
    if (shouldNotifyPieceComplete) {
      notifySuccess('TAKT', getLabel('piece.notifyComplete', undefined, { iteration: String(state.iteration) }));
    }
  });

    engine.on('piece:abort', (state, reason) => {
    interruptAllQueries();
    log.error('Piece aborted', { reason, iterations: state.iteration });
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }
    prefixWriter?.flush();
    abortReason = reason;
    sessionLog = finalizeSessionLog(sessionLog, 'aborted');

    // Write piece_abort record to NDJSON log
    const record: NdjsonPieceAbort = {
      type: 'piece_abort',
      iterations: state.iteration,
      reason,
      endTime: new Date().toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, record);
      finalizeRunMeta('aborted', state.iteration);

    // Save session state for next interactive mode
    try {
      const sessionState: SessionState = {
        status: reason === 'user_interrupted' ? 'user_stopped' : 'error',
        errorMessage: reason,
        timestamp: new Date().toISOString(),
        pieceName: pieceConfig.name,
        taskContent: truncate(task, 200),
        lastMovement: lastMovementName,
      };
      saveSessionState(projectCwd, sessionState);
    } catch (error) {
      log.error('Failed to save session state', { error });
    }

    const elapsed = sessionLog.endTime
      ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime)
      : '';
    const elapsedDisplay = elapsed ? ` (${elapsed})` : '';

    out.error(`Piece aborted after ${state.iteration} iterations${elapsedDisplay}: ${reason}`);
    out.info(`Session log: ${ndjsonLogPath}`);
    if (shouldNotifyPieceAbort) {
      notifyError('TAKT', getLabel('piece.notifyAbort', undefined, { reason }));
    }
  });

    // Suppress EPIPE errors from SDK child process stdin after interrupt.
    // When interruptAllQueries() kills the child process, the SDK may still
    // try to write to the dead process's stdin pipe, causing an unhandled
    // EPIPE error on the Socket. This handler catches it gracefully.
    onEpipe = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      throw err;
    };

    const abortEngine = () => {
      if (!engine || !onEpipe) {
        throw new Error('Abort handler invoked before PieceEngine initialization');
      }
      if (!runAbortController.signal.aborted) {
        runAbortController.abort();
      }
      process.on('uncaughtException', onEpipe);
      interruptAllQueries();
      engine.abort();
    };

    // SIGINT handling: when abortSignal is provided (parallel mode), delegate to caller
    const useExternalAbort = Boolean(options.abortSignal);
    if (useExternalAbort) {
      onAbortSignal = abortEngine;
      if (options.abortSignal!.aborted) {
        abortEngine();
      } else {
        options.abortSignal!.addEventListener('abort', onAbortSignal, { once: true });
      }
    } else {
      shutdownManager = new ShutdownManager({
        callbacks: {
          onGraceful: abortEngine,
          onForceKill: () => process.exit(EXIT_SIGINT),
        },
      });
      shutdownManager.install();
    }

    const finalState = await engine.run();

    return {
      success: finalState.status === 'completed',
      reason: abortReason,
      lastMovement: lastMovementName,
      lastMessage: lastMovementContent,
    };
  } catch (error) {
    if (!isMetaFinalized) {
      finalizeRunMeta('aborted');
    }
    throw error;
  } finally {
    prefixWriter?.flush();
    shutdownManager?.cleanup();
    if (onAbortSignal && options.abortSignal) {
      options.abortSignal.removeEventListener('abort', onAbortSignal);
    }
    if (onEpipe) {
      process.removeListener('uncaughtException', onEpipe);
    }
  }
}
