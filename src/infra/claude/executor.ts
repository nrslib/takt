/**
 * Claude query executor
 *
 * Executes Claude queries using the Agent SDK and handles
 * response processing and error handling.
 */

import {
  query,
  AbortError,
  type SDKMessage,
  type SDKResultMessage,
  type SDKAssistantMessage,
  type SDKRateLimitEvent,
} from '@anthropic-ai/claude-agent-sdk';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import {
  type RateLimitInfo,
  type ProviderUsageSnapshot,
} from '../../core/models/response.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import {
  generateQueryId,
  registerQuery,
  unregisterQuery,
} from './query-manager.js';
import { sdkMessageToStreamEvent } from './stream-converter.js';
import { SdkOptionsBuilder } from './options-builder.js';
import type {
  ClaudeSpawnOptions,
  ClaudeResult,
} from './types.js';
import {
  buildRateLimitInfo,
  containsRateLimitError,
  containsRateLimitMarker,
  resolveRateLimitErrorMessage,
} from '../rate-limit/detection.js';

const log = createLogger('claude-sdk');
function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRejectedRateLimitEvent(message: SDKRateLimitEvent): boolean {
  // SDK は rate_limit_event を情報イベントとして毎回流す。
  // overage 未提供の組織では overageStatus='rejected' が恒常状態になるため、
  // ベース status が 'rejected' のときだけ rate limit と判断する。
  // status='rejected' でも overage が 'allowed'/'allowed_warning' なら救済されるので false。
  const info = message.rate_limit_info;
  if (info.status !== 'rejected') {
    return false;
  }
  return info.overageStatus !== 'allowed' && info.overageStatus !== 'allowed_warning';
}

function isRateLimitSignal(message: SDKMessage): boolean {
  if (message.type === 'rate_limit_event') {
    return isRejectedRateLimitEvent(message as SDKRateLimitEvent);
  }

  return message.type === 'assistant' && message.error === 'rate_limit';
}

function describeRateLimitSignal(message: SDKMessage): string | undefined {
  if (message.type !== 'rate_limit_event') {
    return undefined;
  }

  const info = (message as SDKRateLimitEvent).rate_limit_info;
  const parts = [
    `status=${info.status}`,
    info.rateLimitType ? `rateLimitType=${info.rateLimitType}` : undefined,
    info.overageStatus ? `overageStatus=${info.overageStatus}` : undefined,
    info.overageDisabledReason ? `overageDisabledReason=${info.overageDisabledReason}` : undefined,
    info.resetsAt ? `resetsAt=${info.resetsAt}` : undefined,
    info.overageResetsAt ? `overageResetsAt=${info.overageResetsAt}` : undefined,
    typeof info.isUsingOverage === 'boolean' ? `isUsingOverage=${info.isUsingOverage}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return `Claude SDK rate limit event: ${parts.join(', ')}`;
}

function extractProviderUsage(resultMsg: SDKResultMessage): ProviderUsageSnapshot {
  const rawUsage = (resultMsg as unknown as { usage?: unknown }).usage;
  if (!rawUsage || typeof rawUsage !== 'object') {
    return {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
    };
  }

  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = toNumber(usage.input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const cacheCreationInputTokens = toNumber(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = toNumber(usage.cache_read_input_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.TOKENS_MISSING,
    };
  }
  const totalTokens = inputTokens + outputTokens;
  const cachedInputTokens = (
    cacheCreationInputTokens !== undefined && cacheReadInputTokens !== undefined
      ? cacheCreationInputTokens + cacheReadInputTokens
      : cacheReadInputTokens ?? cacheCreationInputTokens
  );

  const providerUsage: ProviderUsageSnapshot = {
    inputTokens,
    outputTokens,
    totalTokens,
    usageMissing: false,
  };
  if (cachedInputTokens !== undefined) {
    providerUsage.cachedInputTokens = cachedInputTokens;
  }
  if (cacheCreationInputTokens !== undefined) {
    providerUsage.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  if (cacheReadInputTokens !== undefined) {
    providerUsage.cacheReadInputTokens = cacheReadInputTokens;
  }
  return providerUsage;
}

/**
 * Executes Claude queries using the Agent SDK.
 *
 * Handles query lifecycle (register/unregister), streaming,
 * assistant text accumulation, and error classification.
 */
export class QueryExecutor {
  /**
   * Execute a Claude query.
   * If session resume fails with a process exit error, retries without resume.
   */
  async execute(
    prompt: string,
    options: ClaudeSpawnOptions,
  ): Promise<ClaudeResult> {
    const result = await this.executeOnce(prompt, options);

    // Retry without session resume if it appears to be a session resume failure
    if (
      result.error
      && options.sessionId
      && result.error.includes('exited with code')
      && !result.content
    ) {
      log.info('Session resume may have failed, retrying without resume', {
        sessionId: options.sessionId,
        error: result.error,
      });
      const retryOptions: ClaudeSpawnOptions = { ...options, sessionId: undefined };
      return this.executeOnce(prompt, retryOptions);
    }

    return result;
  }

  /**
   * Execute a single Claude query attempt.
   */
  private async executeOnce(
    prompt: string,
    options: ClaudeSpawnOptions,
  ): Promise<ClaudeResult> {
    const queryId = generateQueryId();

    log.debug('Executing Claude query via SDK', {
      queryId,
      cwd: options.cwd,
      model: options.model,
      hasSystemPrompt: !!options.systemPrompt,
      allowedTools: options.allowedTools,
    });

    const stderrChunks: string[] = [];
    const optionsWithStderr: ClaudeSpawnOptions = {
      ...options,
      onStderr: (data: string) => {
        stderrChunks.push(data);
        log.debug('Claude stderr', { queryId, data: data.trimEnd() });
        options.onStderr?.(data);
      },
    };
    const sdkOptions = new SdkOptionsBuilder(optionsWithStderr).build();

    let sessionId: string | undefined;
    let success = false;
    let resultContent: string | undefined;
    let hasResultMessage = false;
    let accumulatedAssistantText = '';
    let structuredOutput: Record<string, unknown> | undefined;
    let providerUsage: ProviderUsageSnapshot | undefined;
    let onExternalAbort: (() => void) | undefined;
    let observedRateLimit = false;
    let rateLimitInfo: RateLimitInfo | undefined;
    let rateLimitMessage: string | undefined;
    const applyAssistantMessage = (assistantMsg: SDKAssistantMessage): void => {
      for (const block of assistantMsg.message.content) {
        if (block.type === 'text') {
          accumulatedAssistantText += block.text;
        }
      }
    };
    const applyResultMessage = (resultMsg: SDKResultMessage): void => {
      hasResultMessage = true;
      providerUsage = extractProviderUsage(resultMsg);
      const resultPayload = resultMsg as SDKResultMessage & { result?: unknown };
      const resultErrors = Array.isArray((resultMsg as { errors?: unknown }).errors)
        ? ((resultMsg as { errors?: unknown }).errors as string[]).filter((error): error is string => typeof error === 'string')
        : [];
      const resultText = typeof resultPayload.result === 'string' ? resultPayload.result : undefined;
      if (resultErrors.length > 0) {
        resultContent = resultErrors.join('\n');
      } else if (resultText) {
        resultContent = resultText;
      }

      if (resultMsg.subtype !== 'success') {
        success = false;
        return;
      }

      const rawStructuredOutput = (resultMsg as unknown as {
        structured_output?: unknown;
        structuredOutput?: unknown;
      }).structured_output ?? (resultMsg as unknown as { structuredOutput?: unknown }).structuredOutput;
      if (
        rawStructuredOutput
        && typeof rawStructuredOutput === 'object'
        && !Array.isArray(rawStructuredOutput)
      ) {
        structuredOutput = rawStructuredOutput as Record<string, unknown>;
      }

      if (resultMsg.is_error) {
        success = false;
        if (resultErrors.length > 0) {
          resultContent = resultErrors.join('\n');
        }
        return;
      }

      success = true;
    };

    try {
      const q = query({ prompt, options: sdkOptions });
      registerQuery(queryId, q);
      if (options.abortSignal) {
        const interruptQuery = () => {
          void q.interrupt().catch((interruptError: unknown) => {
            log.debug('Failed to interrupt Claude query', {
              queryId,
              error: getErrorMessage(interruptError),
            });
          });
        };
        if (options.abortSignal.aborted) {
          interruptQuery();
        } else {
          onExternalAbort = interruptQuery;
          options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      for await (const message of q) {
        if ('session_id' in message) {
          sessionId = message.session_id;
        }

        if (isRateLimitSignal(message)) {
          observedRateLimit = true;
          rateLimitInfo = buildRateLimitInfo('claude-sdk', 'sdk_error');
          rateLimitMessage = describeRateLimitSignal(message);
        }

        if (options.onStream) {
          sdkMessageToStreamEvent(message, options.onStream, true);
        }

        switch (message.type) {
          case 'assistant': {
            applyAssistantMessage(message as SDKAssistantMessage);
            if (containsRateLimitMarker(accumulatedAssistantText)) {
              observedRateLimit = true;
              rateLimitInfo = buildRateLimitInfo('claude-sdk', 'stream_marker', accumulatedAssistantText);
              rateLimitMessage = accumulatedAssistantText;
            }
            break;
          }
          case 'result': {
            applyResultMessage(message as SDKResultMessage);
            break;
          }
          default:
            break;
        }

        if (observedRateLimit) {
          break;
        }
      }

      unregisterQuery(queryId);
      if (onExternalAbort && options.abortSignal) {
        options.abortSignal.removeEventListener('abort', onExternalAbort);
      }

      const finalContent = resultContent || accumulatedAssistantText;
      if (observedRateLimit) {
        return {
          success: false,
          content: '',
          error: resolveRateLimitErrorMessage(rateLimitMessage || finalContent),
          errorKind: 'rate_limit',
          rateLimitInfo: rateLimitInfo ?? buildRateLimitInfo('claude-sdk', 'stream_marker', finalContent),
        };
      }

      log.info('Claude query completed', {
        queryId,
        sessionId,
        contentLength: finalContent.length,
        success,
        hasResultMessage,
      });

      const response: ClaudeResult = {
        success,
        content: finalContent.trim(),
        sessionId,
        fullContent: accumulatedAssistantText.trim(),
        structuredOutput,
        providerUsage: providerUsage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      };
      return response;
    } catch (error) {
      if (onExternalAbort && options.abortSignal) {
        options.abortSignal.removeEventListener('abort', onExternalAbort);
      }
      unregisterQuery(queryId);
      return QueryExecutor.handleQueryError(
        error,
        queryId,
        sessionId,
        hasResultMessage,
        success,
        resultContent,
        accumulatedAssistantText,
        stderrChunks,
        observedRateLimit,
        rateLimitInfo,
        rateLimitMessage,
      );
    }
  }

  /**
   * Handle query execution errors.
   * Classifies errors (abort, auth, timeout) and returns appropriate ClaudeResult.
   */
  private static handleQueryError(
    error: unknown,
    queryId: string,
    sessionId: string | undefined,
    hasResultMessage: boolean,
    success: boolean,
    resultContent: string | undefined,
    assistantText: string,
    stderrChunks: string[],
    observedRateLimit: boolean,
    rateLimitInfo: RateLimitInfo | undefined,
    rateLimitMessage: string | undefined,
  ): ClaudeResult {
    if (error instanceof AbortError) {
      log.info('Claude query was interrupted', { queryId });
      return {
        success: false,
        content: '',
        error: 'Query interrupted',
        interrupted: true,
      };
    }

    const errorMessage = getErrorMessage(error);

    if (hasResultMessage && success) {
      log.info('Claude query completed with post-completion error (ignoring)', {
        queryId,
        sessionId,
        error: errorMessage,
      });
      return {
        success: true,
        content: (resultContent ?? '').trim(),
        sessionId,
        error: errorMessage,
      };
    }

    log.error('Claude query failed', { queryId, error: errorMessage });

    const sdkRateLimitError = observedRateLimit || containsRateLimitError(errorMessage);
    if (
      sdkRateLimitError
      || containsRateLimitMarker(resultContent)
      || containsRateLimitMarker(assistantText)
    ) {
      const detectedMessage = sdkRateLimitError
        ? rateLimitMessage || errorMessage || resultContent || assistantText
        : rateLimitMessage || resultContent || assistantText || errorMessage;
      return {
        success: false,
        content: '',
        error: resolveRateLimitErrorMessage(detectedMessage),
        errorKind: 'rate_limit',
        rateLimitInfo: rateLimitInfo ?? buildRateLimitInfo('claude-sdk', sdkRateLimitError ? 'sdk_error' : 'stream_marker', errorMessage || resultContent || assistantText),
      };
    }

    if (errorMessage.includes('authentication') || errorMessage.includes('unauthorized')) {
      return { success: false, content: '', error: 'Authentication failed. Please check your API credentials.' };
    }

    if (errorMessage.includes('timeout')) {
      return { success: false, content: '', error: 'Request timed out. Please try again.' };
    }

    const stderrOutput = stderrChunks.join('').trim();
    const errorWithStderr = stderrOutput
      ? `${errorMessage}\nstderr: ${stderrOutput}`
      : errorMessage;
    return { success: false, content: '', error: errorWithStderr };
  }
}

export async function executeClaudeQuery(
  prompt: string,
  options: ClaudeSpawnOptions,
): Promise<ClaudeResult> {
  return new QueryExecutor().execute(prompt, options);
}
