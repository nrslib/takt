/**
 * OpenCode SDK integration for agent interactions
 *
 * Uses @opencode-ai/sdk/v2 for native TypeScript integration.
 * Follows the same patterns as the Codex client.
 */

import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:net';
import type { AgentResponse } from '../../core/models/index.js';
import { createLogger, getErrorMessage, createStreamDiagnostics, parseStructuredOutput, type StreamDiagnostics } from '../../shared/utils/index.js';
import { parseProviderModel } from '../../shared/utils/providerModel.js';
import {
  buildOpenCodePermissionConfig,
  buildOpenCodePermissionRuleset,
  mapToOpenCodePermissionReply,
  mapToOpenCodeTools,
  type OpenCodeCallOptions,
} from './types.js';
import {
  type OpenCodeStreamEvent,
  type OpenCodePart,
  type OpenCodeTextPart,
  createStreamTrackingState,
  emitInit,
  emitText,
  emitResult,
  handlePartUpdated,
} from './OpenCodeStreamHandler.js';

export type { OpenCodeCallOptions } from './types.js';

const log = createLogger('opencode-sdk');
const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_RETRY_MAX_ATTEMPTS = 3;
const OPENCODE_RETRY_BASE_DELAY_MS = 250;
const OPENCODE_INTERACTION_TIMEOUT_MS = 5000;
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
];

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

function getCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function stripPromptEcho(
  chunk: string,
  echoState: { remainingPrompt: string },
): string {
  if (!chunk) return '';
  if (!echoState.remainingPrompt) return chunk;

  const consumeLength = getCommonPrefixLength(chunk, echoState.remainingPrompt);
  if (consumeLength > 0) {
    echoState.remainingPrompt = echoState.remainingPrompt.slice(consumeLength);
    return chunk.slice(consumeLength);
  }

  return chunk;
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
  private isRetriableError(message: string, aborted: boolean, abortCause?: 'timeout' | 'external'): boolean {
    if (aborted || abortCause) {
      return false;
    }

    const lower = message.toLowerCase();
    return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  private async waitForRetryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
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

  /** Build a prompt suffix that instructs the agent to return JSON matching the schema */
  private buildStructuredOutputSuffix(schema: Record<string, unknown>): string {
    return [
      '',
      '---',
      'IMPORTANT: You MUST respond with ONLY a valid JSON object matching this schema. No other text, no markdown code blocks, no explanation.',
      '```',
      JSON.stringify(schema, null, 2),
      '```',
    ].join('\n');
  }

  /** Call OpenCode with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    const basePrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    // OpenCode SDK does not natively support structured output via outputFormat.
    // Inject JSON output instructions into the prompt to make the agent return JSON.
    const fullPrompt = options.outputSchema
      ? `${basePrompt}${this.buildStructuredOutputSuffix(options.outputSchema)}`
      : basePrompt;

    for (let attempt = 1; attempt <= OPENCODE_RETRY_MAX_ATTEMPTS; attempt++) {
      let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamAbortController = new AbortController();
      const timeoutMessage = `OpenCode stream timed out after ${Math.floor(OPENCODE_STREAM_IDLE_TIMEOUT_MS / 60000)} minutes of inactivity`;
      let abortCause: 'timeout' | 'external' | undefined;
      let diagRef: StreamDiagnostics | undefined;
      let serverClose: (() => void) | undefined;
      let opencodeApiClient: Awaited<ReturnType<typeof createOpencode>>['client'] | undefined;

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
        const port = await getFreePort();
        const permission = buildOpenCodePermissionConfig(options.permissionMode, options.networkAccess);
        const config = {
          model: fullModel,
          small_model: fullModel,
          permission,
          ...(options.opencodeApiKey
            ? { provider: { opencode: { options: { apiKey: options.opencodeApiKey } } } }
            : {}),
        };
        const { client, server } = await createOpencode({
          port,
          signal: streamAbortController.signal,
          config,
        });
        opencodeApiClient = client;
        serverClose = server.close;

        const sessionResult = options.sessionId
          ? { data: { id: options.sessionId } }
          : await client.session.create({
            directory: options.cwd,
            permission: buildOpenCodePermissionRuleset(options.permissionMode, options.networkAccess),
          });

        const sessionId = sessionResult.data?.id;
        if (!sessionId) {
          throw new Error('Failed to create OpenCode session');
        }
        const { stream } = await client.event.subscribe(
          { directory: options.cwd },
          { signal: streamAbortController.signal },
        );
        resetIdleTimeout();
        diag.onConnected();

        const tools = mapToOpenCodeTools(options.allowedTools);
        const promptPayload: Record<string, unknown> = {
          sessionID: sessionId,
          directory: options.cwd,
          model: parsedModel,
          ...(tools ? { tools } : {}),
          parts: [{ type: 'text' as const, text: fullPrompt }],
        };
        if (options.outputSchema) {
          promptPayload.outputFormat = {
            type: 'json_schema',
            schema: options.outputSchema,
          };
        }

        // OpenCode SDK types do not yet expose outputFormat even though runtime accepts it.
        const promptPayloadForSdk = promptPayload as unknown as Parameters<typeof client.session.promptAsync>[0];
        await client.session.promptAsync(promptPayloadForSdk, {
          signal: streamAbortController.signal,
        });

        emitInit(options.onStream, options.model, sessionId);

        let content = '';
        let success = true;
        let failureMessage = '';
        const state = createStreamTrackingState();
        const echoState = { remainingPrompt: fullPrompt };
        const textOffsets = new Map<string, number>();
        const textContentParts = new Map<string, string>();

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
              const textPart = part as OpenCodeTextPart;
              const prev = textOffsets.get(textPart.id) ?? 0;
              const rawDelta = delta
                ?? (textPart.text.length > prev ? textPart.text.slice(prev) : '');

              textOffsets.set(textPart.id, textPart.text.length);

              if (rawDelta) {
                const visibleDelta = stripPromptEcho(rawDelta, echoState);
                if (visibleDelta) {
                  emitText(options.onStream, visibleDelta);
                  const previous = textContentParts.get(textPart.id) ?? '';
                  textContentParts.set(textPart.id, `${previous}${visibleDelta}`);
                }
              }
              continue;
            }

            handlePartUpdated(part, delta, options.onStream, state);
            continue;
          }

          if (sseEvent.type === 'permission.asked') {
            const permProps = sseEvent.properties as {
              id: string;
              sessionID: string;
            };
            if (permProps.sessionID === sessionId) {
              const reply = options.permissionMode
                ? mapToOpenCodePermissionReply(options.permissionMode)
                : 'once';
              await withTimeout(
                (signal) => client.permission.reply({
                  requestID: permProps.id,
                  directory: options.cwd,
                  reply,
                }, { signal }),
                OPENCODE_INTERACTION_TIMEOUT_MS,
                'OpenCode permission reply timed out',
              );
            }
            continue;
          }

          if (sseEvent.type === 'question.asked') {
            const questionProps = sseEvent.properties as OpenCodeQuestionAskedProperties;
            if (questionProps.sessionID === sessionId) {
              if (!options.onAskUserQuestion) {
                await withTimeout(
                  (signal) => client.question.reject({
                    requestID: questionProps.id,
                    directory: options.cwd,
                  }, { signal }),
                  OPENCODE_INTERACTION_TIMEOUT_MS,
                  'OpenCode question reject timed out',
                );
                continue;
              }

              try {
                const answers = await options.onAskUserQuestion(toQuestionInput(questionProps));
                await withTimeout(
                  (signal) => client.question.reply({
                    requestID: questionProps.id,
                    directory: options.cwd,
                    answers: toQuestionAnswers(questionProps, answers),
                  }, { signal }),
                  OPENCODE_INTERACTION_TIMEOUT_MS,
                  'OpenCode question reply timed out',
                );
              } catch {
                await withTimeout(
                  (signal) => client.question.reject({
                    requestID: questionProps.id,
                    directory: options.cwd,
                  }, { signal }),
                  OPENCODE_INTERACTION_TIMEOUT_MS,
                  'OpenCode question reject timed out',
                );
                success = false;
                failureMessage = 'OpenCode question handling failed';
                break;
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
            const isCurrentAssistantMessage = info?.sessionID === sessionId && info.role === 'assistant';
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
            const isCurrentAssistantMessage = info?.sessionID === sessionId && info.role === 'assistant';
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
            const isCurrentAssistantMessage = info?.sessionID === sessionId && info.role === 'assistant';
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
            if (statusProps.sessionID === sessionId && statusProps.status?.type === 'idle') {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.idle') {
            const idleProps = sseEvent.properties as { sessionID: string };
            if (idleProps.sessionID === sessionId) {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.error') {
            const errorProps = sseEvent.properties as {
              sessionID?: string;
              error?: { name: string; data: { message: string } };
            };
            if (!errorProps.sessionID || errorProps.sessionID === sessionId) {
              success = false;
              failureMessage = errorProps.error?.data?.message ?? 'OpenCode session error';
              diag.onStreamError('session.error', failureMessage);
              break;
            }
            continue;
          }
        }

        content = [...textContentParts.values()].join('\n');
        diag.onCompleted(success ? 'normal' : 'error', success ? undefined : failureMessage);

        if (!success) {
          const message = failureMessage || 'OpenCode execution failed';
          const retriable = this.isRetriableError(message, streamAbortController.signal.aborted, abortCause);
          if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
            log.info('Retrying OpenCode call after transient failure', { agentType, attempt, message });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          emitResult(options.onStream, false, message, sessionId);
          return {
            persona: agentType,
            status: 'error',
            content: message,
            timestamp: new Date(),
            sessionId,
          };
        }

        const trimmed = content.trim();
        const structuredOutput = parseStructuredOutput(trimmed, !!options.outputSchema);
        emitResult(options.onStream, true, trimmed, sessionId);

        return {
          persona: agentType,
          status: 'done',
          content: trimmed,
          timestamp: new Date(),
          sessionId,
          structuredOutput,
        };
      } catch (error) {
        const message = getErrorMessage(error);
        const errorMessage = streamAbortController.signal.aborted
          ? abortCause === 'timeout'
            ? timeoutMessage
            : OPENCODE_STREAM_ABORTED_MESSAGE
          : message;

        diagRef?.onCompleted(
          abortCause === 'timeout' ? 'timeout' : streamAbortController.signal.aborted ? 'abort' : 'error',
          errorMessage,
        );

        const retriable = this.isRetriableError(errorMessage, streamAbortController.signal.aborted, abortCause);
        if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
          log.info('Retrying OpenCode call after transient exception', { agentType, attempt, errorMessage });
          await this.waitForRetryDelay(attempt, options.abortSignal);
          continue;
        }

        if (options.sessionId) {
          emitResult(options.onStream, false, errorMessage, options.sessionId);
        }

        return {
          persona: agentType,
          status: 'error',
          content: errorMessage,
          timestamp: new Date(),
          sessionId: options.sessionId,
        };
      } finally {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onExternalAbort);
        }
        if (opencodeApiClient) {
          const disposeAbortController = new AbortController();
          const disposeTimeoutId = setTimeout(() => {
            disposeAbortController.abort();
          }, 3000);
          try {
            await opencodeApiClient.instance.dispose(
              { directory: options.cwd },
              { signal: disposeAbortController.signal },
            );
          } catch {
            // Ignore dispose errors during cleanup.
          } finally {
            clearTimeout(disposeTimeoutId);
          }
        }
        if (serverClose) {
          serverClose();
        }
        if (!streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
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
