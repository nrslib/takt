/**
 * OpenCode SDK integration for agent interactions
 *
 * Uses @opencode-ai/sdk/v2 for native TypeScript integration.
 * Follows the same patterns as the Codex client.
 */

import { createOpencode } from '@opencode-ai/sdk/v2';
import type { AgentResponse } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { mapToOpenCodePermissionReply, type OpenCodeCallOptions } from './types.js';
import {
  type OpenCodeStreamEvent,
  type OpenCodePart,
  type OpenCodeTextPart,
  createStreamTrackingState,
  emitInit,
  emitResult,
  handlePartUpdated,
} from './OpenCodeStreamHandler.js';

export type { OpenCodeCallOptions } from './types.js';

const log = createLogger('opencode-sdk');
const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_RETRY_MAX_ATTEMPTS = 3;
const OPENCODE_RETRY_BASE_DELAY_MS = 250;
const OPENCODE_RETRYABLE_ERROR_PATTERNS = [
  'stream disconnected before completion',
  'transport error',
  'network error',
  'error decoding response body',
  'econnreset',
  'etimedout',
  'eai_again',
  'fetch failed',
];

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

  /** Call OpenCode with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    for (let attempt = 1; attempt <= OPENCODE_RETRY_MAX_ATTEMPTS; attempt++) {
      let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamAbortController = new AbortController();
      const timeoutMessage = `OpenCode stream timed out after ${Math.floor(OPENCODE_STREAM_IDLE_TIMEOUT_MS / 60000)} minutes of inactivity`;
      let abortCause: 'timeout' | 'external' | undefined;
      let serverClose: (() => void) | undefined;

      const resetIdleTimeout = (): void => {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        idleTimeoutId = setTimeout(() => {
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

        const { client, server } = await createOpencode({
          signal: streamAbortController.signal,
          ...(options.opencodeApiKey
            ? { config: { provider: { opencode: { options: { apiKey: options.opencodeApiKey } } } } }
            : {}),
        });
        serverClose = server.close;

        const sessionResult = options.sessionId
          ? { data: { id: options.sessionId } }
          : await client.session.create({ directory: options.cwd });

        const sessionId = sessionResult.data?.id;
        if (!sessionId) {
          throw new Error('Failed to create OpenCode session');
        }

        const { stream } = await client.event.subscribe({ directory: options.cwd });
        resetIdleTimeout();

        await client.session.promptAsync({
          sessionID: sessionId,
          directory: options.cwd,
          ...(options.model ? { model: { providerID: 'opencode', modelID: options.model } } : {}),
          parts: [{ type: 'text' as const, text: fullPrompt }],
        });

        emitInit(options.onStream, options.model, sessionId);

        let content = '';
        let success = true;
        let failureMessage = '';
        const state = createStreamTrackingState();
        const textContentParts = new Map<string, string>();

        for await (const event of stream) {
          if (streamAbortController.signal.aborted) break;
          resetIdleTimeout();

          const sseEvent = event as OpenCodeStreamEvent;

          if (sseEvent.type === 'message.part.updated') {
            const props = sseEvent.properties as { part: OpenCodePart; delta?: string };
            const part = props.part;
            const delta = props.delta;

            if (part.type === 'text') {
              const textPart = part as OpenCodeTextPart;
              textContentParts.set(textPart.id, textPart.text);
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
              await client.permission.reply({
                requestID: permProps.id,
                directory: options.cwd,
                reply,
              });
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
              break;
            }
            continue;
          }
        }

        content = [...textContentParts.values()].join('\n');

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
        emitResult(options.onStream, true, trimmed, sessionId);

        return {
          persona: agentType,
          status: 'done',
          content: trimmed,
          timestamp: new Date(),
          sessionId,
        };
      } catch (error) {
        const message = getErrorMessage(error);
        const errorMessage = streamAbortController.signal.aborted
          ? abortCause === 'timeout'
            ? timeoutMessage
            : OPENCODE_STREAM_ABORTED_MESSAGE
          : message;

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
        if (serverClose) {
          serverClose();
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
