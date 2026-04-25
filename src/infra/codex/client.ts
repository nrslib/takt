/**
 * Codex SDK integration for agent interactions
 *
 * Uses @openai/codex-sdk for native TypeScript integration.
 */

import { Codex, type TurnOptions } from '@openai/codex-sdk';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { AgentResponse, ProviderUsageSnapshot } from '../../core/models/index.js';
import { createLogger, getErrorMessage, createStreamDiagnostics, parseStructuredOutput, type StreamDiagnostics } from '../../shared/utils/index.js';
import {
  AGENT_FAILURE_CATEGORIES,
  classifyAbortSignalReason,
  createProviderErrorFailure,
  createStreamIdleTimeoutFailure,
  formatAgentFailure,
  type AgentFailureCategory,
  type AgentFailureDetail,
} from '../../shared/types/agent-failure.js';
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
const CODEX_TIMEOUT_MAX_RETRIES = 2;
const CODEX_RETRY_MAX_RETRIES = 8;
const CODEX_RETRY_BASE_DELAY_MS = 1000;
const CODEX_RETRYABLE_ERROR_PATTERNS = [
  'stream disconnected before completion',
  'transport error',
  'network error',
  'error decoding response body',
  'econnreset',
  'etimedout',
  'eai_again',
  'fetch failed',
  'at capacity',
];

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractProviderUsageFromTurnCompleted(event: CodexEvent): ProviderUsageSnapshot {
  const usageRaw = event.usage;
  if (!usageRaw || typeof usageRaw !== 'object') {
    return {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
    };
  }

  const usage = usageRaw as Record<string, unknown>;
  const inputTokens = toNumber(usage.input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const explicitTotal = toNumber(usage.total_tokens);
  const totalTokens = explicitTotal ?? (
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined
  );
  const cachedInputTokens = toNumber(usage.cached_input_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.TOKENS_MISSING,
    };
  }

  const providerUsage: ProviderUsageSnapshot = {
    inputTokens,
    outputTokens,
    totalTokens,
    usageMissing: false,
  };
  if (cachedInputTokens !== undefined) {
    providerUsage.cachedInputTokens = cachedInputTokens;
  }

  return providerUsage;
}

/**
 * Client for Codex SDK agent interactions.
 *
 * Handles thread management, streaming event conversion,
 * and response processing.
 */
export class CodexClient {
  private isRetriableError(message: string): boolean {
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
        reject(signal?.reason ?? new Error(CODEX_STREAM_ABORTED_MESSAGE));
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

  private resolveFailureDetail(
    message: string,
    streamSignal: AbortSignal,
    externalSignal: AbortSignal | undefined,
    abortCause: 'timeout' | 'external' | undefined,
    timeoutMessage: string,
  ): AgentFailureDetail {
    if (abortCause === 'timeout') {
      return createStreamIdleTimeoutFailure(timeoutMessage);
    }
    if (externalSignal?.aborted) {
      return classifyAbortSignalReason(externalSignal.reason);
    }
    if (streamSignal.aborted) {
      return classifyAbortSignalReason(streamSignal.reason);
    }
    return createProviderErrorFailure(message);
  }

  private shouldRetry(
    failure: AgentFailureDetail,
    standardRetryCount: number,
    timeoutRetryCount: number,
  ): boolean {
    if (failure.category === AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT) {
      return timeoutRetryCount < CODEX_TIMEOUT_MAX_RETRIES;
    }
    if (failure.category !== AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR) {
      return false;
    }
    return standardRetryCount < CODEX_RETRY_MAX_RETRIES && this.isRetriableError(failure.reason);
  }

  private recordRetry(
    failureCategory: AgentFailureCategory,
    standardRetryCount: number,
    timeoutRetryCount: number,
  ): { standardRetryCount: number; timeoutRetryCount: number; retryAttempt: number } {
    const nextStandardRetryCount = failureCategory === AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT
      ? standardRetryCount
      : standardRetryCount + 1;
    const nextTimeoutRetryCount = failureCategory === AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT
      ? timeoutRetryCount + 1
      : timeoutRetryCount;
    return {
      standardRetryCount: nextStandardRetryCount,
      timeoutRetryCount: nextTimeoutRetryCount,
      retryAttempt: nextStandardRetryCount + nextTimeoutRetryCount,
    };
  }

  private buildErrorResponse(
    agentType: string,
    sessionId: string | undefined,
    failure: AgentFailureDetail,
  ): AgentResponse {
    const message = formatAgentFailure(failure);
    return {
      persona: agentType,
      status: 'error',
      content: message,
      error: message,
      timestamp: new Date(),
      sessionId,
      failureCategory: failure.category,
    };
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
      ...(options.reasoningEffort ? { modelReasoningEffort: options.reasoningEffort } : {}),
      ...(options.networkAccess === undefined ? {} : { networkAccessEnabled: options.networkAccess }),
    };
    let threadId = options.sessionId;

    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;
    let standardRetryCount = 0;
    let timeoutRetryCount = 0;

    while (true) {
      const attempt = standardRetryCount + timeoutRetryCount + 1;
      const codexClientOptions = {
        ...(options.openaiApiKey ? { apiKey: options.openaiApiKey } : {}),
        ...(options.codexPathOverride ? { codexPathOverride: options.codexPathOverride } : {}),
      };
      const codex = new Codex(Object.keys(codexClientOptions).length > 0 ? codexClientOptions : undefined);
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
          streamAbortController.abort(new Error(timeoutMessage));
        }, CODEX_STREAM_IDLE_TIMEOUT_MS);
      };

      const onExternalAbort = (): void => {
        abortCause = 'external';
        streamAbortController.abort(options.abortSignal?.reason);
      };

      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          abortCause = 'external';
          streamAbortController.abort(options.abortSignal.reason);
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
        let providerUsage: ProviderUsageSnapshot | undefined;
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

          if (event.type === 'turn.completed') {
            providerUsage = extractProviderUsageFromTurnCompleted(event);
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
          const failure = this.resolveFailureDetail(
            failureMessage || 'Codex execution failed',
            streamAbortController.signal,
            options.abortSignal,
            abortCause,
            timeoutMessage,
          );
          if (this.shouldRetry(failure, standardRetryCount, timeoutRetryCount)) {
            log.info('Retrying Codex call after transient failure', { agentType, attempt, message: failure.reason });
            threadId = currentThreadId;
            const retryState = this.recordRetry(failure.category, standardRetryCount, timeoutRetryCount);
            standardRetryCount = retryState.standardRetryCount;
            timeoutRetryCount = retryState.timeoutRetryCount;
            await this.waitForRetryDelay(retryState.retryAttempt, options.abortSignal);
            continue;
          }

          const errorResponse = this.buildErrorResponse(agentType, currentThreadId, failure);
          emitResult(
            options.onStream,
            false,
            errorResponse.error ?? errorResponse.content,
            currentThreadId,
            failure.category,
          );
          return errorResponse;
        }

        const trimmed = content.trim();
        const structuredOutput = parseStructuredOutput(trimmed, !!options.outputSchema);
        emitResult(options.onStream, true, trimmed, currentThreadId);

        const response: AgentResponse = {
          persona: agentType,
          status: 'done',
          content: trimmed,
          timestamp: new Date(),
          sessionId: currentThreadId,
          structuredOutput,
          providerUsage: providerUsage ?? {
            usageMissing: true,
            reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
          },
        };
        return response;
      } catch (error) {
        const failure = this.resolveFailureDetail(
          getErrorMessage(error),
          streamAbortController.signal,
          options.abortSignal,
          abortCause,
          timeoutMessage,
        );
        const errorMessage = formatAgentFailure(failure);

        diagRef?.onCompleted(
          failure.category === AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT
            ? 'timeout'
            : failure.category === AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT
              || failure.category === AGENT_FAILURE_CATEGORIES.PART_TIMEOUT
              ? 'abort'
              : 'error',
          errorMessage,
        );

        if (this.shouldRetry(failure, standardRetryCount, timeoutRetryCount)) {
          log.info('Retrying Codex call after transient exception', { agentType, attempt, errorMessage });
          threadId = currentThreadId;
          const retryState = this.recordRetry(failure.category, standardRetryCount, timeoutRetryCount);
          standardRetryCount = retryState.standardRetryCount;
          timeoutRetryCount = retryState.timeoutRetryCount;
          await this.waitForRetryDelay(retryState.retryAttempt, options.abortSignal);
          continue;
        }

        const errorResponse = this.buildErrorResponse(agentType, currentThreadId, failure);
        emitResult(
          options.onStream,
          false,
          errorResponse.error ?? errorResponse.content,
          currentThreadId,
          failure.category,
        );

        return errorResponse;
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
