/**
 * OpenCode SDK integration for agent interactions
 *
 * Uses @opencode-ai/sdk/v2 for native TypeScript integration.
 * Follows the same patterns as the Codex client.
 */

import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:net';
import type { AgentResponse } from '../../core/models/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { mapsToOpenCodeEditPermission } from './allowedTools.js';
import { AskUserQuestionDeniedError } from '../../core/workflow/ask-user-question-error.js';
import { createLogger, getErrorMessage, createStreamDiagnostics, type StreamDiagnostics } from '../../shared/utils/index.js';
import {
  getNestedObservabilityEnvFingerprint,
  runWithNestedObservabilityProcessEnv,
} from '../../shared/telemetry/index.js';
import { parseProviderModel } from '../../shared/utils/providerModel.js';
import {
  buildOpenCodePermissionRuleset,
  buildOpenCodePromptTools,
  buildOpenCodeSessionPermission,
  resolveOpenCodePermissionReply,
  type OpenCodeCallOptions,
} from './types.js';
import {
  type OpenCodeStreamEvent,
  type OpenCodePart,
  type OpenCodeTextPart,
  type OpenCodeToolPart,
  createStreamTrackingState,
  emitInit,
  emitText,
  emitPermissionAsked,
  emitPermissionSummary,
  emitResult,
  handlePartUpdated,
} from './OpenCodeStreamHandler.js';
import { UnavailableToolLoopDetector } from './unavailable-tool-loop.js';
import { buildRateLimitedResponseFields, containsRateLimitError } from '../rate-limit/detection.js';

export type { OpenCodeCallOptions } from './types.js';

const TAKT_AGENT = 'takt';
const TAKT_AGENT_REVIEW = 'takt-review';
const TAKT_AGENT_REPORT = 'takt-report';

function selectTaktAgent(allowedTools: readonly string[] | undefined): string {
  if (allowedTools !== undefined && allowedTools.length === 0) {
    return TAKT_AGENT_REPORT;
  }
  const hasBash = allowedTools === undefined
    || allowedTools.some((t) => t.trim().toLowerCase() === 'bash');
  const hasEdit = allowedTools === undefined
    || allowedTools.some((t) => mapsToOpenCodeEditPermission(t));
  if (hasEdit && hasBash) {
    return TAKT_AGENT;
  }
  return TAKT_AGENT_REVIEW;
}

const log = createLogger('opencode-sdk');
const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_RETRY_MAX_ATTEMPTS = 3;
const OPENCODE_RETRY_BASE_DELAY_MS = 250;
const OPENCODE_INTERACTION_TIMEOUT_MS = 5000;
const OPENCODE_SERVER_START_TIMEOUT_MS = 60000;
const OPENCODE_RETRYABLE_ERROR_PATTERNS = [
  'stream disconnected before completion',
  'transport error',
  'network error',
  'error decoding response body',
  'econnreset',
  'etimedout',
  'eai_again',
  'fetch failed',
  'failed to start server on port',
  'timeout waiting for server',
];
type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];
type OpenCodeSessionSnapshot = NonNullable<Awaited<ReturnType<OpencodeClient['session']['get']>>['data']>;
type OpenCodeAbortCause = 'timeout' | 'external' | 'prompt';

interface SharedServer {
  client: OpencodeClient;
  close: () => void;
  model: string;
  apiKey?: string;
  busy: boolean;
  queue: SharedServerQueueEntry[];
}

interface SharedServerQueueEntry {
  resolve: (acquired: AcquiredOpenCodeClient) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface SharedServerEntry {
  server?: SharedServer;
  initPromise?: Promise<SharedServer>;
}

interface AcquiredOpenCodeClient {
  client: OpencodeClient;
  release: () => void;
}

const sharedServers = new Map<string, SharedServerEntry>();

async function acquireClient(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  abortSignal?: AbortSignal,
): Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  const key = buildSharedServerKey(model, apiKey, childProcessEnv);
  const entry = getSharedServerEntry(key);

  if (entry.initPromise) {
    const server = await entry.initPromise;
    throwIfAborted(abortSignal);
    return acquireSharedServer(server, abortSignal);
  }

  if (entry.server) {
    return acquireSharedServer(entry.server, abortSignal);
  }

  entry.initPromise = createSharedServer(model, apiKey, childProcessEnv)
    .then((server) => {
      entry.server = server;
      return server;
    })
    .finally(() => {
      entry.initPromise = undefined;
    });

  const server = await entry.initPromise;
  throwIfAborted(abortSignal);
  return acquireSharedServer(server, abortSignal);
}

function buildSharedServerKey(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): string {
  return JSON.stringify([model, apiKey, getNestedObservabilityEnvFingerprint(childProcessEnv)]);
}

function getSharedServerEntry(key: string): SharedServerEntry {
  const existing = sharedServers.get(key);
  if (existing) {
    return existing;
  }

  const entry: SharedServerEntry = {};
  sharedServers.set(key, entry);
  return entry;
}

async function createSharedServer(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Promise<SharedServer> {
  const port = await getFreePort();
  const { client, server } = await runWithNestedObservabilityProcessEnv(childProcessEnv, () =>
    createOpencode({
      port,
      config: {
        model,
        small_model: model,
        // Session-level permission rules are rewritten whenever a prompt
        // carries a tools map (OpenCode materializes the map into
        // session.permission), so session-scoped denies do not survive the
        // first prompt. Server-config permission is outside that rewrite and
        // is the only layer that reliably keeps out-of-workspace access a
        // soft tool error instead of an ask (which would depend on the
        // user's global OpenCode config).
        permission: { external_directory: 'deny' },
        ...(apiKey ? { provider: { opencode: { options: { apiKey } } } } : {}),
        agent: {
          [TAKT_AGENT]: {
            prompt: loadTemplate('opencode_agent_prompt', 'en', {
              listFilesMethod: 'runs bash ls to list files in the directory',
            }),
            tools: { task: false },
          },
          [TAKT_AGENT_REVIEW]: {
            prompt: loadTemplate('opencode_review_agent_prompt', 'en', {
              listFilesMethod: 'uses read tool on the directory to list files',
            }),
            tools: { task: false },
          },
          [TAKT_AGENT_REPORT]: {
            prompt: loadTemplate('opencode_report_agent_prompt', 'en'),
          },
        },
      },
      timeout: OPENCODE_SERVER_START_TIMEOUT_MS,
    })
  );
  log.debug('OpenCode server started with TAKT agents', {
    agents: [TAKT_AGENT, TAKT_AGENT_REVIEW, TAKT_AGENT_REPORT],
    model,
    port,
  });

  const closeServer = (): void => {
    try {
      server.close();
    } catch (error) {
      log.debug(`Failed to close OpenCode server: ${getErrorMessage(error)}`, { model });
    }
  };

  log.debug('OpenCode server started', { model, port });
  return { client, close: closeServer, model, apiKey, busy: false, queue: [] };
}

function acquireSharedServer(
  server: SharedServer,
  abortSignal?: AbortSignal,
): AcquiredOpenCodeClient | Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  if (!server.busy) {
    server.busy = true;
    return { client: server.client, release: createReleaseHandle(server) };
  }

  return new Promise((resolve, reject) => {
    const entry: SharedServerQueueEntry = { resolve, reject, signal: abortSignal };
    if (abortSignal) {
      entry.onAbort = () => {
        removeQueuedClient(server, entry);
        reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      };
      abortSignal.addEventListener('abort', entry.onAbort, { once: true });
    }
    server.queue.push(entry);
  });
}

export async function getOpenCodeSessionSnapshot(
  model: string,
  sessionID: string,
  directory: string,
  apiKey?: string,
): Promise<OpenCodeSessionSnapshot> {
  const { client, release } = await acquireClient(model, apiKey, undefined);
  try {
    const result = await client.session.get({ sessionID, directory });
    if (!result.data) {
      throw new Error(`OpenCode session not found: ${sessionID}`);
    }
    return result.data;
  } finally {
    release();
  }
}

export type OpenCodeSessionMessages = NonNullable<Awaited<ReturnType<OpencodeClient['session']['messages']>>['data']>;

export async function getOpenCodeSessionMessages(
  model: string,
  sessionID: string,
  directory: string,
  apiKey?: string,
): Promise<OpenCodeSessionMessages> {
  const { client, release } = await acquireClient(model, apiKey, undefined);
  try {
    const result = await client.session.messages({ sessionID, directory });
    if (!result.data) {
      throw new Error(`OpenCode session messages not found: ${sessionID}`);
    }
    return result.data;
  } finally {
    release();
  }
}

function releaseClient(server: SharedServer): void {
  const next = server.queue.shift();
  if (next) {
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.resolve({ client: server.client, release: createReleaseHandle(server) });
    return;
  }
  server.busy = false;
}

function removeQueuedClient(server: SharedServer, entry: SharedServerQueueEntry): void {
  server.queue = server.queue.filter((queued) => queued !== entry);
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
  }
}

function createReleaseHandle(server: SharedServer): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseClient(server);
  };
}

export function resetSharedServer(): void {
  for (const entry of sharedServers.values()) {
    entry.server?.close();
  }
  sharedServers.clear();
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutErrorMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutErrorMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      operation(controller.signal),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function extractOpenCodeErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const value = error as { message?: unknown; data?: { message?: unknown }; name?: unknown };
  if (typeof value.message === 'string' && value.message.length > 0) {
    return value.message;
  }
  if (typeof value.data?.message === 'string' && value.data.message.length > 0) {
    return value.data.message;
  }
  if (typeof value.name === 'string' && value.name.length > 0) {
    return value.name;
  }
  return undefined;
}

function stripPromptEcho(
  chunk: string,
  echoState: { remainingPrompts: string[] },
): string {
  if (!chunk) return '';
  if (echoState.remainingPrompts.length === 0) return chunk;

  const matchingPrompts = echoState.remainingPrompts.filter((remainingPrompt) => (
    remainingPrompt.startsWith(chunk) || chunk.startsWith(remainingPrompt)
  ));
  if (matchingPrompts.length === 0) {
    echoState.remainingPrompts = [];
    return chunk;
  }

  const consumedPrompt = matchingPrompts
    .filter((remainingPrompt) => chunk.startsWith(remainingPrompt))
    .sort((a, b) => b.length - a.length)[0];
  if (consumedPrompt !== undefined) {
    const visible = chunk.slice(consumedPrompt.length);
    echoState.remainingPrompts = [];
    return visible;
  }

  echoState.remainingPrompts = matchingPrompts.map((remainingPrompt) => (
    remainingPrompt.slice(chunk.length)
  ));
  return '';
}

function buildPromptEchoCandidates(prompt: string, systemPrompt: string | undefined): string[] {
  const prompts = [prompt];
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    prompts.unshift(`${systemPrompt}\n\n${prompt}`);
  }

  return Array.from(new Set(prompts)).filter((candidate) => candidate.length > 0);
}

type OpenCodeQuestionOption = {
  label: string;
  description: string;
};

type OpenCodeQuestionInfo = {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
};

type OpenCodeQuestionAskedProperties = {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
};

function toQuestionInput(props: OpenCodeQuestionAskedProperties): {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
} {
  return {
    questions: props.questions.map((item) => ({
      question: item.question,
      header: item.header,
      options: item.options.map((opt) => ({
        label: opt.label,
        description: opt.description,
      })),
      multiSelect: item.multiple,
    })),
  };
}

function toQuestionAnswers(
  props: OpenCodeQuestionAskedProperties,
  answers: Record<string, string>,
): Array<Array<string>> {
  return props.questions.map((item) => {
    const key = item.header || item.question;
    const value = answers[key];
    if (!value) return [];
    return [value];
  });
}

function buildPermissionRejectedMessage(permission: string | undefined): string {
  if (permission && permission.length > 0) {
    return `OpenCode permission rejected: ${permission}`;
  }
  return 'OpenCode permission rejected';
}

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate free TCP port')));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Client for OpenCode SDK agent interactions.
 *
 * Handles session management, streaming event conversion,
 * permission auto-reply, and response processing.
 */
export class OpenCodeClient {
  private isRetriableError(message: string, aborted: boolean, abortCause?: OpenCodeAbortCause): boolean {
    if (abortCause === 'timeout') {
      return true;
    }

    if (abortCause === 'prompt') {
      const lower = message.toLowerCase();
      return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
    }

    if (aborted || abortCause) {
      return false;
    }

    const lower = message.toLowerCase();
    return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  private async waitForRetryDelay(
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const delayMs = OPENCODE_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, delayMs);

      const onAbort = (): void => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private buildRateLimitedResponse(
    agentType: string,
    sessionId: string | undefined,
    message: string,
  ): AgentResponse {
    return {
      persona: agentType,
      timestamp: new Date(),
      sessionId,
      ...buildRateLimitedResponseFields('opencode', 'sdk_error', message),
    };
  }

  /** Call OpenCode with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    for (let attempt = 1; attempt <= OPENCODE_RETRY_MAX_ATTEMPTS; attempt++) {
      let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamAbortController = new AbortController();
      const timeoutMessage = `OpenCode stream timed out after ${Math.floor(OPENCODE_STREAM_IDLE_TIMEOUT_MS / 60000)} minutes of inactivity`;
      let abortCause: OpenCodeAbortCause | undefined;
      let diagRef: StreamDiagnostics | undefined;
      let release: (() => void) | undefined;
      let opencodeApiClient: OpencodeClient | undefined;
      let sessionId: string | undefined = options.sessionId;
      let promptCompletion: Promise<unknown> | undefined;
      let promptCompletionWait: Promise<void> | undefined;
      let promptError: string | undefined;
      const interactionTimeoutMs = options.interactionTimeoutMs ?? OPENCODE_INTERACTION_TIMEOUT_MS;
      const promptCompletionTimeoutMessage = 'OpenCode prompt completion timed out';

      const awaitPromptCompletion = (): Promise<void> => {
        if (!promptCompletion) {
          return Promise.resolve();
        }

        promptCompletionWait ??= (async () => {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              promptCompletion,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                  reject(new Error(promptCompletionTimeoutMessage));
                }, interactionTimeoutMs);
              }),
            ]);
          } catch (error) {
            promptError ??= getErrorMessage(error);
          } finally {
            if (timeoutId !== undefined) {
              clearTimeout(timeoutId);
            }
          }
        })();
        return promptCompletionWait;
      };

      const resetIdleTimeout = (): void => {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        idleTimeoutId = setTimeout(() => {
          diagRef?.onIdleTimeoutFired();
          abortCause = 'timeout';
          streamAbortController.abort();
        }, OPENCODE_STREAM_IDLE_TIMEOUT_MS);
      };

      const onExternalAbort = (): void => {
        abortCause = 'external';
        streamAbortController.abort();
      };

      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          abortCause = 'external';
          streamAbortController.abort();
        } else {
          options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      try {
        log.debug('Starting OpenCode session', {
          agentType,
          model: options.model,
          hasSystemPrompt: !!options.systemPrompt,
          attempt,
        });

        const diag = createStreamDiagnostics('opencode-sdk', { agentType, model: options.model, attempt });
        diagRef = diag;

        const parsedModel = parseProviderModel(options.model, 'OpenCode model');
        const fullModel = `${parsedModel.providerID}/${parsedModel.modelID}`;

        const acquired = await acquireClient(
          fullModel,
          options.opencodeApiKey,
          options.childProcessEnv,
          options.abortSignal,
        );
        opencodeApiClient = acquired.client;
        release = acquired.release;
        if (streamAbortController.signal.aborted) {
          release();
          release = undefined;
          throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
        }
        const permissionRuleset = buildOpenCodePermissionRuleset(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        // The session is created once per step and reused across phases: a
        // session-scoped deny can never be escalated later, and recreating the
        // session drops the conversation history the report/judgment phases
        // depend on. Per-phase tool restriction rides on the explicit prompt
        // tools map below instead.
        const appliedPermissionRuleset = sessionId === undefined;
        const sessionPermission = buildOpenCodeSessionPermission(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        if (sessionId === undefined) {
          const sessionResult = await opencodeApiClient.session.create({
            directory: options.cwd,
            permission: sessionPermission,
          });

          sessionId = sessionResult.data?.id;
          if (!sessionId) {
            throw new Error('Failed to create OpenCode session');
          }
        }

        const activeSessionId = sessionId;
        if (activeSessionId === undefined) {
          throw new Error('OpenCode session ID is required');
        }

        const { stream } = await opencodeApiClient.event.subscribe(
          { directory: options.cwd },
          { signal: streamAbortController.signal },
        );
        resetIdleTimeout();
        diag.onConnected();
        if (appliedPermissionRuleset) {
          emitPermissionSummary(options.onStream, {
            sessionId: activeSessionId,
            ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
            ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
            ...(options.networkAccess !== undefined ? { networkAccess: options.networkAccess } : {}),
            resolvedPermissions: sessionPermission,
          });
        }

        const agentName = selectTaktAgent(options.allowedTools);
        // OpenCode persists the last explicit tools map on the session, so
        // every prompt sends the full map for its own phase (see
        // buildOpenCodePromptTools).
        const promptTools = buildOpenCodePromptTools(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        log.debug('Selecting OpenCode agent', {
          agentName,
          allowedTools: options.allowedTools,
          promptTools,
        });
        const promptPayload: Record<string, unknown> = {
          sessionID: activeSessionId,
          directory: options.cwd,
          model: parsedModel,
          tools: promptTools,
          ...(agentName !== undefined ? { agent: agentName } : {}),
          ...(options.variant !== undefined ? { variant: options.variant } : {}),
          ...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
          parts: [{ type: 'text' as const, text: prompt }],
        };
        const promptPayloadForSdk = promptPayload as unknown as Parameters<typeof opencodeApiClient.session.promptAsync>[0];
        promptCompletion = opencodeApiClient.session.promptAsync(promptPayloadForSdk, {
          signal: streamAbortController.signal,
        }).catch((error) => {
          promptError = getErrorMessage(error);
          if (!streamAbortController.signal.aborted) {
            abortCause = 'prompt';
            streamAbortController.abort();
          }
        });

        emitInit(options.onStream, options.model, activeSessionId);

        let content = '';
        let success = true;
        let failureMessage = '';
        const state = createStreamTrackingState();
        const unavailableToolLoopDetector = new UnavailableToolLoopDetector();
        const echoState = { remainingPrompts: buildPromptEchoCandidates(prompt, options.systemPrompt) };
        const textOffsets = new Map<string, number>();
        const textContentParts = new Map<string, string>();

        // Consume a raw text delta for a part: strip the prompt echo, stream the
        // visible portion, accumulate it, and advance the part's raw offset in
        // lockstep. Sharing this keeps content and offset consistent whether the
        // text arrives via `message.part.delta` or a full-snapshot
        // `message.part.updated` — some providers emit both for the same part.
        const consumeTextDelta = (partId: string, rawDelta: string): void => {
          if (!rawDelta) return;
          const visibleDelta = stripPromptEcho(rawDelta, echoState);
          if (visibleDelta) {
            emitText(options.onStream, visibleDelta);
            const previous = textContentParts.get(partId) ?? '';
            textContentParts.set(partId, `${previous}${visibleDelta}`);
          }
          const prevOffset = textOffsets.get(partId) ?? 0;
          textOffsets.set(partId, prevOffset + rawDelta.length);
        };

        for await (const event of stream) {
          if (streamAbortController.signal.aborted) break;
          resetIdleTimeout();

          const sseEvent = event as OpenCodeStreamEvent;
          diag.onFirstEvent(sseEvent.type);
          diag.onEvent(sseEvent.type);
          if (sseEvent.type === 'message.part.updated') {
            const props = sseEvent.properties as { part: OpenCodePart; delta?: string };
            const part = props.part;
            const delta = props.delta;

            if (part.type === 'text') {
              unavailableToolLoopDetector.reset();
              const textPart = part as OpenCodeTextPart;
              const prev = textOffsets.get(textPart.id) ?? 0;
              const rawDelta = delta
                ?? (textPart.text.length > prev ? textPart.text.slice(prev) : '');
              consumeTextDelta(textPart.id, rawDelta);
              continue;
            }

            if (part.type === 'tool') {
              const toolPart = part as OpenCodeToolPart;
              const loopError = toolPart.state.status === 'error'
                ? unavailableToolLoopDetector.observe(
                  toolPart.callID || toolPart.id,
                  toolPart.tool,
                  toolPart.state.error,
                )
                : undefined;
              if (toolPart.state.status === 'completed') {
                unavailableToolLoopDetector.reset();
              }
              handlePartUpdated(part, delta, options.onStream, state);
              if (loopError !== undefined) {
                success = false;
                failureMessage = loopError;
                diag.onStreamError('message.part.updated', loopError);
                break;
              }
              continue;
            }

            handlePartUpdated(part, delta, options.onStream, state);
            continue;
          }

          if (sseEvent.type === 'message.part.delta') {
            const deltaProps = sseEvent.properties as {
              sessionID: string;
              partID: string;
              field: string;
              delta: string;
            };
            if (deltaProps.field === 'text' && deltaProps.delta) {
              unavailableToolLoopDetector.reset();
              consumeTextDelta(deltaProps.partID, deltaProps.delta);
            }
            continue;
          }

          if (sseEvent.type === 'permission.asked') {
            const permProps = sseEvent.properties as {
              id: string;
              sessionID: string;
              permission?: string;
              patterns?: string[];
              always?: string[];
            };
            if (permProps.sessionID === activeSessionId) {
              try {
                const reply = resolveOpenCodePermissionReply(
                  options.permissionMode,
                  permProps.permission,
                  options.allowedTools !== undefined ? permissionRuleset : undefined,
                );
                emitPermissionAsked(options.onStream, {
                  requestId: permProps.id,
                  sessionId: permProps.sessionID,
                  permission: permProps.permission ?? '',
                  patterns: Array.isArray(permProps.patterns) ? permProps.patterns : [],
                  always: Array.isArray(permProps.always) ? permProps.always : [],
                  reply,
                });
                await withTimeout(
                  (signal) => opencodeApiClient!.permission.reply({
                    requestID: permProps.id,
                    directory: options.cwd,
                    reply,
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode permission reply timed out',
                );
                if (reply === 'reject') {
                  // A rejected permission is a per-tool failure, not a fatal
                  // one: OpenCode returns the rejection to the model as a tool
                  // error and generation continues (verified against a live
                  // server). Aborting here used to turn a single stray
                  // out-of-workspace access into a whole-step failure.
                  log.info(buildPermissionRejectedMessage(permProps.permission), {
                    permission: permProps.permission,
                    patterns: permProps.patterns,
                  });
                }
              } catch (e) {
                success = false;
                failureMessage = getErrorMessage(e);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === 'question.asked') {
            const questionProps = sseEvent.properties as OpenCodeQuestionAskedProperties;
            if (questionProps.sessionID === activeSessionId) {
              const rejectQuestion = (): Promise<unknown> =>
                withTimeout(
                  (signal) => opencodeApiClient!.question.reject({
                    requestID: questionProps.id,
                    directory: options.cwd,
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode question reject timed out',
                );

              if (!options.onAskUserQuestion) {
                try {
                  await rejectQuestion();
                } catch (e) {
                  success = false;
                  failureMessage = getErrorMessage(e);
                  break;
                }
                continue;
              }

              try {
                const answers = await options.onAskUserQuestion(toQuestionInput(questionProps));
                await withTimeout(
                  (signal) => opencodeApiClient!.question.reply({
                    requestID: questionProps.id,
                    directory: options.cwd,
                    answers: toQuestionAnswers(questionProps, answers),
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode question reply timed out',
                );
              } catch (e) {
                if (e instanceof AskUserQuestionDeniedError) {
                  try {
                    await rejectQuestion();
                  } catch (rejectErr) {
                    success = false;
                    failureMessage = getErrorMessage(rejectErr);
                    break;
                  }
                } else {
                  success = false;
                  failureMessage = getErrorMessage(e);
                  break;
                }
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.updated') {
            const messageProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                time?: { completed?: number };
                error?: unknown;
              };
            };
            const info = messageProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              const streamError = extractOpenCodeErrorMessage(info?.error);
              if (streamError) {
                success = false;
                failureMessage = streamError;
                diag.onStreamError('message.updated', streamError);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.completed') {
            const completedProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                error?: unknown;
              };
            };
            const info = completedProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              const streamError = extractOpenCodeErrorMessage(info?.error);
              if (streamError) {
                success = false;
                failureMessage = streamError;
                diag.onStreamError('message.completed', streamError);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.failed') {
            const failedProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                error?: unknown;
              };
            };
            const info = failedProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              success = false;
              failureMessage = extractOpenCodeErrorMessage(info?.error) ?? 'OpenCode message failed';
              diag.onStreamError('message.failed', failureMessage);
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.status') {
            const statusProps = sseEvent.properties as {
              sessionID?: string;
              status?: { type?: string };
            };
            if (statusProps.sessionID === activeSessionId && statusProps.status?.type === 'idle') {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.idle') {
            const idleProps = sseEvent.properties as { sessionID: string };
            if (idleProps.sessionID === activeSessionId) {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.error') {
            const errorProps = sseEvent.properties as {
              sessionID?: string;
              error?: unknown;
            };
            if (!errorProps.sessionID || errorProps.sessionID === activeSessionId) {
              success = false;
              failureMessage = extractOpenCodeErrorMessage(errorProps.error) ?? 'OpenCode session error';
              diag.onStreamError('session.error', failureMessage);
              break;
            }
            continue;
          }
        }

        // The idle watchdog and external aborts cancel the stream. If the
        // iterator ends without throwing, the loop falls through with
        // success still true - do not let a timed-out or aborted stream
        // pass as a completed call (a stalled stream after a rejected
        // permission would otherwise be reported as done).
        if (success && streamAbortController.signal.aborted && (abortCause === 'timeout' || abortCause === 'external')) {
          success = false;
          failureMessage = abortCause === 'timeout' ? timeoutMessage : OPENCODE_STREAM_ABORTED_MESSAGE;
        }

        content = [...textContentParts.values()].join('\n');
        if (!success && !streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
        await awaitPromptCompletion();
        if (promptError !== undefined) {
          if (success) {
            success = false;
            failureMessage = promptError;
          } else if (!failureMessage) {
            failureMessage = promptError;
          }
        }
        diag.onCompleted(success ? 'normal' : 'error', success ? undefined : failureMessage);

        if (!success) {
          const message = failureMessage || 'OpenCode execution failed';
          if (containsRateLimitError(message)) {
            const rateLimitedResponse = this.buildRateLimitedResponse(agentType, activeSessionId, message);
            emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, activeSessionId);
            return rateLimitedResponse;
          }
          const retriable = this.isRetriableError(message, streamAbortController.signal.aborted, abortCause);
          if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
            log.info('Retrying OpenCode call after transient failure', { agentType, attempt, message });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          emitResult(options.onStream, false, message, activeSessionId);
          return {
            persona: agentType,
            status: 'error',
            content: message,
            timestamp: new Date(),
            sessionId: activeSessionId,
          };
        }

        const trimmed = content.trim();
        emitResult(options.onStream, true, trimmed, activeSessionId);

        return {
          persona: agentType,
          status: 'done',
          content: trimmed,
          timestamp: new Date(),
          sessionId: activeSessionId,
        };
      } catch (error) {
        const message = getErrorMessage(error);
        const errorMessage = streamAbortController.signal.aborted
          ? abortCause === 'timeout'
            ? timeoutMessage
            : abortCause === 'prompt' && promptError !== undefined
              ? promptError
              : OPENCODE_STREAM_ABORTED_MESSAGE
          : message;

        if (containsRateLimitError(errorMessage)) {
          const rateLimitedResponse = this.buildRateLimitedResponse(agentType, sessionId, errorMessage);
          if (sessionId) {
            emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, sessionId);
          }
          return rateLimitedResponse;
        }

        diagRef?.onCompleted(
          abortCause === 'timeout' ? 'timeout' : streamAbortController.signal.aborted && abortCause !== 'prompt' ? 'abort' : 'error',
          errorMessage,
        );

        const retriable = this.isRetriableError(errorMessage, streamAbortController.signal.aborted, abortCause);
        if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
          log.info('Retrying OpenCode call after transient exception', { agentType, attempt, errorMessage });
          await this.waitForRetryDelay(attempt, options.abortSignal);
          continue;
        }

        if (sessionId) {
          emitResult(options.onStream, false, errorMessage, sessionId);
        }

        return {
          persona: agentType,
          status: 'error',
          content: errorMessage,
          timestamp: new Date(),
          sessionId,
        };
      } finally {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onExternalAbort);
        }
        if (!streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
        await awaitPromptCompletion();
        release?.();
      }
    }

    throw new Error('Unreachable: OpenCode retry loop exhausted without returning');
  }

  /** Call OpenCode with a custom agent configuration (system prompt + prompt) */
  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, {
      ...options,
      systemPrompt,
    });
  }
}

const defaultClient = new OpenCodeClient();

export async function callOpenCode(
  agentType: string,
  prompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callOpenCodeCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}
