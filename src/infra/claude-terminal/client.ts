import { randomUUID } from 'node:crypto';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { AgentResponse } from '../../core/models/index.js';
import {
  AGENT_FAILURE_CATEGORIES,
  classifyAbortSignalReason,
  type AgentFailureCategory,
} from '../../shared/types/agent-failure.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { prepareClaudeMcpConfig } from '../claude/mcp-config.js';
import { buildClaudeTerminalCommand } from './command.js';
import { normalizeClaudeTerminalResponse } from './response-normalizer.js';
import { ProjectClaudeTranscriptReader } from './transcript-reader.js';
import { TmuxTerminalBackend } from './tmux-backend.js';
import type {
  ClaudeTerminalBackendName,
  ClaudeTerminalCallOptions,
  ClaudeTerminalEvent,
  ClaudeTerminalTranscript,
  ClaudeTranscriptBaseline,
  TerminalBackend,
  TerminalSession,
} from './types.js';

const DEFAULT_BACKEND: ClaudeTerminalBackendName = 'tmux';
const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const log = createLogger('claude-terminal');

class ClaudeTerminalAbortError extends Error {
  constructor(readonly reason: unknown) {
    super('Claude terminal execution aborted.');
  }
}

function createErrorResponse(
  agentName: string,
  message: string,
  failureCategory: AgentFailureCategory = AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
  sessionId?: string,
): AgentResponse {
  return {
    persona: agentName,
    status: 'error',
    content: message,
    timestamp: new Date(),
    sessionId,
    error: message,
    failureCategory,
    providerUsage: {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
    },
  };
}

function createAbortResponse(agentName: string, reason: unknown, sessionId?: string): AgentResponse {
  const failure = classifyAbortSignalReason(reason);
  return createErrorResponse(agentName, failure.reason, failure.category, sessionId);
}

function resolveTerminalBackend(
  backendName: ClaudeTerminalBackendName,
  backend: TerminalBackend | undefined,
): TerminalBackend {
  if (backend) {
    return backend;
  }
  if (backendName === 'tmux') {
    return new TmuxTerminalBackend();
  }
  throw new Error(`Unsupported Claude terminal backend: ${backendName}`);
}

function emitInit(options: ClaudeTerminalCallOptions, sessionId: string): void {
  if (!options.onStream || !options.model) {
    return;
  }
  options.onStream({
    type: 'init',
    data: {
      model: options.model,
      sessionId,
    },
  });
}

function getUnsupportedCallOptionMessage(options: ClaudeTerminalCallOptions): string | undefined {
  if (options.maxTurns !== undefined) {
    return 'provider: claude-terminal does not support maxTurns because Claude Code terminal mode has no verified --max-turns option.';
  }
  return undefined;
}

function collectInteractiveEvents(events: ClaudeTerminalEvent[]): ClaudeTerminalEvent[] {
  return events.filter((event) =>
    event.type === 'permission_request' || event.type === 'ask_user_question'
  );
}

function formatPermissionDecision(decision: Awaited<ReturnType<NonNullable<ClaudeTerminalCallOptions['onPermissionRequest']>>>): string {
  if (decision.behavior === 'allow') {
    if (decision.updatedInput || decision.updatedPermissions) {
      throw new Error('Claude terminal provider cannot apply updated permission input or rules.');
    }
    return 'yes';
  }
  if (decision.behavior === 'deny') {
    if (decision.interrupt === true) {
      throw new Error('Claude terminal provider cannot interrupt a terminal permission request from callback output.');
    }
    return decision.message ? `no\n${decision.message}` : 'no';
  }
  throw new Error('Claude terminal permission callback returned an invalid decision.');
}

function formatQuestionAnswers(answers: Record<string, string>): string {
  const answerText = Object.values(answers).filter((value) => value.length > 0).join('\n');
  if (answerText.length === 0) {
    throw new Error('Claude terminal ask-user callback returned no answer text.');
  }
  return answerText;
}

async function buildInteractiveEventReply(
  event: ClaudeTerminalEvent,
  options: ClaudeTerminalCallOptions,
): Promise<string> {
  if (event.type === 'permission_request') {
    if (!options.onPermissionRequest) {
      throw new Error('Claude terminal provider received a permission request event but no onPermissionRequest handler is configured.');
    }
    const decision = await options.onPermissionRequest({
      toolName: event.tool,
      input: event.input,
    });
    return formatPermissionDecision(decision);
  }

  if (event.type === 'ask_user_question') {
    if (!options.onAskUserQuestion) {
      throw new Error('Claude terminal provider received an ask-user question event but no onAskUserQuestion handler is configured.');
    }
    const answers = await options.onAskUserQuestion({ questions: event.questions });
    return formatQuestionAnswers(answers);
  }

  throw new Error('Claude terminal provider cannot reply to a non-interactive transcript event.');
}

export async function callClaudeTerminal(
  agentName: string,
  prompt: string,
  options: ClaudeTerminalCallOptions,
): Promise<AgentResponse> {
  const backendName = options.backend ?? DEFAULT_BACKEND;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.transcriptPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const keepSession = options.keepSession === true;
  const terminalBackend = resolveTerminalBackend(backendName, options.terminalBackend);
  const transcriptReader = options.transcriptReader ?? new ProjectClaudeTranscriptReader();
  const claudeSessionId = options.sessionId ?? randomUUID();
  let responseSessionId: string | undefined = options.sessionId;
  let terminalSession: TerminalSession | undefined;
  let stopRequested = false;
  let cleanup: (() => Promise<void>) | undefined;
  let abortHandler: (() => void) | undefined;
  let aborted = false;
  let pendingStart: Promise<TerminalSession> | undefined;

  async function stopSession(): Promise<void> {
    if (!terminalSession || stopRequested) {
      return;
    }
    stopRequested = true;
    await terminalBackend.stop(terminalSession);
  }

  function stopPendingSessionOnResolve(startPromise: Promise<TerminalSession>): void {
    startPromise
      .then(async (session) => {
        try {
          await terminalBackend.stop(session);
        } catch (error) {
          log.error('Failed to stop Claude terminal session', {
            error: getErrorMessage(error),
            session: session.name,
          });
        }
      })
      .catch((error) => {
        log.error('Claude terminal session start failed after abort', {
          error: getErrorMessage(error),
        });
      });
  }

  if (options.abortSignal?.aborted) {
    return createAbortResponse(agentName, options.abortSignal.reason, responseSessionId);
  }

  const unsupportedMessage = getUnsupportedCallOptionMessage(options);
  if (unsupportedMessage) {
    return createErrorResponse(agentName, unsupportedMessage, AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR, responseSessionId);
  }

  function withAbort<T>(operation: () => Promise<T>): Promise<T> {
    const signal = options.abortSignal;
    if (!signal) {
      return operation();
    }
    if (signal.aborted) {
      aborted = true;
      return Promise.reject(new ClaudeTerminalAbortError(signal.reason));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        aborted = true;
        reject(new ClaudeTerminalAbortError(signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      let operationPromise: Promise<T>;
      try {
        operationPromise = operation();
      } catch (error) {
        signal.removeEventListener('abort', onAbort);
        reject(error);
        return;
      }
      operationPromise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  if (options.abortSignal) {
    abortHandler = () => {
      aborted = true;
    };
    options.abortSignal?.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const prepared = await prepareClaudeMcpConfig(options.mcpServers);
    cleanup = prepared.cleanup;
    if (options.abortSignal?.aborted) {
      throw new ClaudeTerminalAbortError(options.abortSignal.reason);
    }
    const command = buildClaudeTerminalCommand({
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      model: options.model,
      effort: options.effort,
      allowedTools: options.allowedTools,
      mcpConfigPath: prepared.path,
      permissionMode: options.permissionMode,
      bypassPermissions: options.bypassPermissions,
      sessionId: options.sessionId,
      newSessionId: options.sessionId ? undefined : claudeSessionId,
      systemPrompt: options.systemPrompt,
      outputSchema: options.outputSchema,
    });

    const startedSession = await withAbort(() => {
      const startPromise = terminalBackend.start({
        cwd: options.cwd,
        backend: backendName,
        command,
        childProcessEnv: options.childProcessEnv,
      });
      pendingStart = startPromise;
      return startPromise;
    });
    terminalSession = startedSession;
    responseSessionId = claudeSessionId;
    if (options.abortSignal?.aborted) {
      return createAbortResponse(agentName, options.abortSignal.reason, responseSessionId);
    }
    let baseline: ClaudeTranscriptBaseline = await withAbort(() => transcriptReader.readBaseline({
      cwd: options.cwd,
      sessionId: claudeSessionId,
    }));
    await withAbort(() => terminalBackend.pasteText(startedSession, prompt));

    const session = await withAbort(() => transcriptReader.findSession({
      cwd: options.cwd,
      sessionId: claudeSessionId,
      timeoutMs,
      pollIntervalMs,
      abortSignal: options.abortSignal,
    }));
    responseSessionId = session.sessionId;
    emitInit(options, session.sessionId);

    const handledEvents: ClaudeTerminalEvent[] = [];
    let response: ClaudeTerminalTranscript;
    while (true) {
      response = await withAbort(() => transcriptReader.waitForAssistantResponse({
        session,
        baseline,
        cwd: options.cwd,
        timeoutMs,
        pollIntervalMs,
        abortSignal: options.abortSignal,
      }));

      handledEvents.push(...response.events);
      const interactiveEvents = collectInteractiveEvents(response.events);
      if (interactiveEvents.length === 0) {
        break;
      }

      baseline = await withAbort(() => transcriptReader.readBaseline({
        cwd: options.cwd,
        sessionId: session.sessionId,
      }));
      for (const event of interactiveEvents) {
        const reply = await withAbort(() => buildInteractiveEventReply(event, options));
        await withAbort(() => terminalBackend.pasteText(startedSession, reply));
      }
    }

    return normalizeClaudeTerminalResponse({
      agentName,
      sessionId: response.sessionId,
      assistantText: response.assistantText,
      events: handledEvents,
      outputSchema: options.outputSchema,
      onStream: options.onStream,
    });
  } catch (error) {
    if (error instanceof ClaudeTerminalAbortError) {
      return createAbortResponse(agentName, error.reason, responseSessionId);
    }
    return createErrorResponse(agentName, getErrorMessage(error), AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR, responseSessionId);
  } finally {
    if (abortHandler) {
      options.abortSignal?.removeEventListener('abort', abortHandler);
    }
    try {
      if (aborted && !terminalSession && pendingStart) {
        stopPendingSessionOnResolve(pendingStart);
      }
      if (!keepSession || aborted) {
        try {
          await stopSession();
        } catch (error) {
          log.error('Failed to stop Claude terminal session', {
            error: getErrorMessage(error),
            session: terminalSession?.name,
          });
        }
      }
    } finally {
      try {
        await cleanup?.();
      } catch (error) {
        log.error('Failed to clean up Claude terminal resources', {
          error: getErrorMessage(error),
        });
      }
    }
  }
}
