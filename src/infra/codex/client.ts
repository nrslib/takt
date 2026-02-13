/**
 * Codex SDK integration for agent interactions
 *
 * Uses @openai/codex-sdk for native TypeScript integration.
 */

import { Codex, type TurnOptions } from '@openai/codex-sdk';
import type { AgentResponse } from '../../core/models/index.js';
import { createLogger, getErrorMessage, createStreamDiagnostics, parseStructuredOutput, type StreamDiagnostics } from '../../shared/utils/index.js';
import { mapToCodexSandboxMode, type CodexCallOptions } from './types.js';
import {
  type CodexEvent,
  type CodexItem,
  createStreamTrackingState,
  extractThreadId,
  emitInit,
  emitResult,
  emitCodexItemStart,
  emitCodexItemCompleted,
  emitCodexItemUpdate,
} from './CodexStreamHandler.js';

export type { CodexCallOptions } from './types.js';

const log = createLogger('codex-sdk');
const CODEX_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_STREAM_ABORTED_MESSAGE = 'Codex execution aborted';
const CODEX_RETRY_MAX_ATTEMPTS = 3;
const CODEX_RETRY_BASE_DELAY_MS = 250;
const CODEX_RETRYABLE_ERROR_PATTERNS = [
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
 * Client for Codex SDK agent interactions.
 *
 * Handles thread management, streaming event conversion,
 * and response processing.
 */
export class CodexClient {
  private isRetriableError(message: string, aborted: boolean, abortCause?: 'timeout' | 'external'): boolean {
    if (aborted || abortCause) {
      return false;
    }

    const lower = message.toLowerCase();
    return CODEX_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  private async waitForRetryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
    const delayMs = CODEX_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
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
        reject(new Error(CODEX_STREAM_ABORTED_MESSAGE));
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

  /** Call Codex with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: CodexCallOptions,
  ): Promise<AgentResponse> {
    const sandboxMode = options.permissionMode
      ? mapToCodexSandboxMode(options.permissionMode)
      : 'workspace-write';
    const threadOptions = {
      ...(options.model ? { model: options.model } : {}),
      workingDirectory: options.cwd,
      sandboxMode,
      ...(options.networkAccess === undefined ? {} : { networkAccessEnabled: options.networkAccess }),
    };
    let threadId = options.sessionId;

    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    for (let attempt = 1; attempt <= CODEX_RETRY_MAX_ATTEMPTS; attempt++) {
      const codex = new Codex(options.openaiApiKey ? { apiKey: options.openaiApiKey } : undefined);
      const thread = threadId
        ? await codex.resumeThread(threadId, threadOptions)
        : await codex.startThread(threadOptions);
      let currentThreadId = extractThreadId(thread) || threadId;

      let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamAbortController = new AbortController();
      const timeoutMessage = `Codex stream timed out after ${Math.floor(CODEX_STREAM_IDLE_TIMEOUT_MS / 60000)} minutes of inactivity`;
      let abortCause: 'timeout' | 'external' | undefined;
      let diagRef: StreamDiagnostics | undefined;

      const resetIdleTimeout = (): void => {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        idleTimeoutId = setTimeout(() => {
          diagRef?.onIdleTimeoutFired();
          abortCause = 'timeout';
          streamAbortController.abort();
        }, CODEX_STREAM_IDLE_TIMEOUT_MS);
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
        log.debug('Executing Codex thread', {
          agentType,
          model: options.model,
          hasSystemPrompt: !!options.systemPrompt,
          attempt,
        });

        const diag = createStreamDiagnostics('codex-sdk', { agentType, model: options.model, attempt });
        diagRef = diag;

        const turnOptions: TurnOptions = {
          signal: streamAbortController.signal,
          ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
        };
        const { events } = await thread.runStreamed(fullPrompt, turnOptions);
        resetIdleTimeout();
        diag.onConnected();

        let content = '';
        const contentOffsets = new Map<string, number>();
        let success = true;
        let failureMessage = '';
        const state = createStreamTrackingState();

        for await (const event of events as AsyncGenerator<CodexEvent>) {
          resetIdleTimeout();
          diag.onFirstEvent(event.type);
          diag.onEvent(event.type);

          if (event.type === 'thread.started') {
            currentThreadId = typeof event.thread_id === 'string' ? event.thread_id : currentThreadId;
            emitInit(options.onStream, options.model, currentThreadId);
            continue;
          }

          if (event.type === 'turn.failed') {
            success = false;
            if (event.error && typeof event.error === 'object' && 'message' in event.error) {
              failureMessage = String((event.error as { message?: unknown }).message ?? '');
            }
            diag.onStreamError('turn.failed', failureMessage);
            break;
          }

          if (event.type === 'error') {
            success = false;
            failureMessage = typeof event.message === 'string' ? event.message : 'Unknown error';
            diag.onStreamError('error', failureMessage);
            break;
          }

          if (event.type === 'item.started') {
            const item = event.item as CodexItem | undefined;
            if (item) {
              emitCodexItemStart(item, options.onStream, state.startedItems);
            }
            continue;
          }

          if (event.type === 'item.updated') {
            const item = event.item as CodexItem | undefined;
            if (item) {
              if (item.type === 'agent_message' && typeof item.text === 'string') {
                const itemId = item.id;
                const text = item.text;
                if (itemId) {
                  const prev = contentOffsets.get(itemId) ?? 0;
                  if (text.length > prev) {
                    if (prev === 0 && content.length > 0) {
                      content += '\n';
                    }
                    content += text.slice(prev);
                    contentOffsets.set(itemId, text.length);
                  }
                }
              }
              emitCodexItemUpdate(item, options.onStream, state);
            }
            continue;
          }

          if (event.type === 'item.completed') {
            const item = event.item as CodexItem | undefined;
            if (item) {
              if (item.type === 'agent_message' && typeof item.text === 'string') {
                const itemId = item.id;
                const text = item.text;
                if (itemId) {
                  const prev = contentOffsets.get(itemId) ?? 0;
                  if (text.length > prev) {
                    if (prev === 0 && content.length > 0) {
                      content += '\n';
                    }
                    content += text.slice(prev);
                    contentOffsets.set(itemId, text.length);
                  }
                } else if (text) {
                  if (content.length > 0) {
                    content += '\n';
                  }
                  content += text;
                }
              }
              emitCodexItemCompleted(item, options.onStream, state);
            }
            continue;
          }
        }

        diag.onCompleted(success ? 'normal' : 'error', success ? undefined : failureMessage);

        if (!success) {
          const message = failureMessage || 'Codex execution failed';
          const retriable = this.isRetriableError(message, streamAbortController.signal.aborted, abortCause);
          if (retriable && attempt < CODEX_RETRY_MAX_ATTEMPTS) {
            log.info('Retrying Codex call after transient failure', { agentType, attempt, message });
            threadId = currentThreadId;
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          emitResult(options.onStream, false, message, currentThreadId);
          return {
            persona: agentType,
            status: 'error',
            content: message,
            timestamp: new Date(),
            sessionId: currentThreadId,
          };
        }

        const trimmed = content.trim();
        const structuredOutput = parseStructuredOutput(trimmed, !!options.outputSchema);
        emitResult(options.onStream, true, trimmed, currentThreadId);

        return {
          persona: agentType,
          status: 'done',
          content: trimmed,
          timestamp: new Date(),
          sessionId: currentThreadId,
          structuredOutput,
        };
      } catch (error) {
        const message = getErrorMessage(error);
        const errorMessage = streamAbortController.signal.aborted
          ? abortCause === 'timeout'
            ? timeoutMessage
            : CODEX_STREAM_ABORTED_MESSAGE
          : message;

        diagRef?.onCompleted(
          abortCause === 'timeout' ? 'timeout' : streamAbortController.signal.aborted ? 'abort' : 'error',
          errorMessage,
        );

        const retriable = this.isRetriableError(errorMessage, streamAbortController.signal.aborted, abortCause);
        if (retriable && attempt < CODEX_RETRY_MAX_ATTEMPTS) {
          log.info('Retrying Codex call after transient exception', { agentType, attempt, errorMessage });
          threadId = currentThreadId;
          await this.waitForRetryDelay(attempt, options.abortSignal);
          continue;
        }

        emitResult(options.onStream, false, errorMessage, currentThreadId);

        return {
          persona: agentType,
          status: 'error',
          content: errorMessage,
          timestamp: new Date(),
          sessionId: currentThreadId,
        };
      } finally {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    }

    throw new Error('Unreachable: Codex retry loop exhausted without returning');
  }

  /** Call Codex with a custom agent configuration (system prompt + prompt) */
  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: CodexCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, {
      ...options,
      systemPrompt,
    });
  }
}

const defaultClient = new CodexClient();

export async function callCodex(
  agentType: string,
  prompt: string,
  options: CodexCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callCodexCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: CodexCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}
