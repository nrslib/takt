/**
 * Piece execution logic
 */

import { readFileSync } from 'node:fs';
import { PieceEngine, type IterationLimitRequest, type UserInputRequest } from '../../../core/piece/index.js';
import type { PieceConfig } from '../../../core/models/index.js';
import type { PieceExecutionResult, PieceExecutionOptions } from './types.js';
import { callAiJudge, detectRuleIndex, interruptAllQueries } from '../../../infra/claude/index.js';

export type { PieceExecutionResult, PieceExecutionOptions };

import {
  loadPersonaSessions,
  updatePersonaSession,
  loadWorktreeSessions,
  updateWorktreeSession,
  loadGlobalConfig,
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
  updateLatestPointer,
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
} from '../../../shared/utils/index.js';
import type { PromptLogRecord } from '../../../shared/utils/index.js';
import { selectOption, promptInput } from '../../../shared/prompt/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { installSigIntHandler } from './sigintHandler.js';

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

  // When taskPrefix is set (parallel execution), route all output through TaskPrefixWriter
  const prefixWriter = options.taskPrefix
    ? new TaskPrefixWriter({ taskName: options.taskPrefix, colorIndex: options.taskColorIndex ?? 0 })
    : undefined;
  const out = createOutputFns(prefixWriter);

  // Always continue from previous sessions (use /clear to reset)
  log.debug('Continuing session (use /clear to reset)');

  out.header(`${headerPrefix} ${pieceConfig.name}`);

  const pieceSessionId = generateSessionId();
  let sessionLog = createSessionLog(task, projectCwd, pieceConfig.name);

  // Initialize NDJSON log file + pointer at piece start
  const ndjsonLogPath = initNdjsonLog(pieceSessionId, task, pieceConfig.name, projectCwd);
  updateLatestPointer(sessionLog, pieceSessionId, projectCwd, { copyToPrevious: true });

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

  // Load saved agent sessions for continuity (from project root or clone-specific storage)
  const isWorktree = cwd !== projectCwd;
  const globalConfig = loadGlobalConfig();
  const shouldNotify = globalConfig.notificationSound !== false;
  const currentProvider = globalConfig.provider ?? 'claude';

  // Prevent macOS idle sleep if configured
  if (globalConfig.preventSleep) {
    preventSleep();
  }
  const savedSessions = isWorktree
    ? loadWorktreeSessions(projectCwd, cwd, currentProvider)
    : loadPersonaSessions(projectCwd, currentProvider);

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
        maxIterations: String(request.maxIterations),
      })
    );
    out.info(getLabel('piece.iterationLimit.currentMovement', undefined, { currentMovement: request.currentMovement }));

    if (shouldNotify) {
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
        pieceConfig.maxIterations += additionalIterations;
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

  const engine = new PieceEngine(pieceConfig, cwd, task, {
    onStream: streamHandler,
    onUserInput,
    initialSessions: savedSessions,
    onSessionUpdate: sessionUpdateHandler,
    onIterationLimit: iterationLimitHandler,
    projectCwd,
    language: options.language,
    provider: options.provider,
    model: options.model,
    interactive: interactiveUserInput,
    detectRuleIndex,
    callAiJudge,
    startMovement: options.startMovement,
    retryNote: options.retryNote,
  });

  let abortReason: string | undefined;
  let lastMovementContent: string | undefined;
  let lastMovementName: string | undefined;
  let currentIteration = 0;
  const phasePrompts = new Map<string, string>();

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
    out.info(`[${iteration}/${pieceConfig.maxIterations}] ${step.name} (${step.personaDisplayName})`);

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
        maxIterations: pieceConfig.maxIterations,
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
    const record: NdjsonStepComplete = {
      type: 'step_complete',
      step: step.name,
      persona: response.persona,
      status: response.status,
      content: response.content,
      instruction,
      ...(response.matchedRuleIndex != null ? { matchedRuleIndex: response.matchedRuleIndex } : {}),
      ...(response.matchedRuleMethod ? { matchedRuleMethod: response.matchedRuleMethod } : {}),
      ...(response.error ? { error: response.error } : {}),
      timestamp: response.timestamp.toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, record);


    // Update in-memory log for pointer metadata (immutable)
    sessionLog = { ...sessionLog, iterations: sessionLog.iterations + 1 };
    updateLatestPointer(sessionLog, pieceSessionId, projectCwd);
  });

  engine.on('movement:report', (_step, filePath, fileName) => {
    const content = readFileSync(filePath, 'utf-8');
    out.logLine(`\n📄 Report: ${fileName}\n`);
    out.logLine(content);
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
    updateLatestPointer(sessionLog, pieceSessionId, projectCwd);

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
    if (shouldNotify) {
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
    updateLatestPointer(sessionLog, pieceSessionId, projectCwd);

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
    if (shouldNotify) {
      notifyError('TAKT', getLabel('piece.notifyAbort', undefined, { reason }));
    }
  });

  // Suppress EPIPE errors from SDK child process stdin after interrupt.
  // When interruptAllQueries() kills the child process, the SDK may still
  // try to write to the dead process's stdin pipe, causing an unhandled
  // EPIPE error on the Socket. This handler catches it gracefully.
  const onEpipe = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
  };

  const abortEngine = () => {
    process.on('uncaughtException', onEpipe);
    interruptAllQueries();
    engine.abort();
  };

  // SIGINT handling: when abortSignal is provided (parallel mode), delegate to caller
  const useExternalAbort = Boolean(options.abortSignal);

  let onAbortSignal: (() => void) | undefined;
  let sigintCleanup: (() => void) | undefined;

  if (useExternalAbort) {
    onAbortSignal = abortEngine;
    options.abortSignal!.addEventListener('abort', onAbortSignal, { once: true });
  } else {
    const handler = installSigIntHandler(abortEngine);
    sigintCleanup = handler.cleanup;
  }

  try {
    const finalState = await engine.run();

    return {
      success: finalState.status === 'completed',
      reason: abortReason,
    };
  } finally {
    prefixWriter?.flush();
    sigintCleanup?.();
    if (onAbortSignal && options.abortSignal) {
      options.abortSignal.removeEventListener('abort', onAbortSignal);
    }
    process.removeListener('uncaughtException', onEpipe);
  }
}
