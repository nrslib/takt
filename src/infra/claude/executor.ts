/**
 * Claude query executor
 *
 * Executes Claude queries using the Agent SDK and handles
 * response processing and error handling.
 */

import {
  query,
  AbortError,
  type SDKResultMessage,
  type SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { ProviderUsageSnapshot } from '../../core/models/response.js';
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

const log = createLogger('claude-sdk');

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

        if (options.onStream) {
          sdkMessageToStreamEvent(message, options.onStream, true);
        }

        if (message.type === 'assistant') {
          const assistantMsg = message as SDKAssistantMessage;
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              accumulatedAssistantText += block.text;
            }
          }
        }

        if (message.type === 'result') {
          hasResultMessage = true;
          const resultMsg = message as SDKResultMessage;
          providerUsage = extractProviderUsage(resultMsg);
          if (resultMsg.subtype === 'success') {
            resultContent = resultMsg.result;
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
            success = true;
          } else {
            success = false;
            if (resultMsg.errors && resultMsg.errors.length > 0) {
              resultContent = resultMsg.errors.join('\n');
            }
          }
        }
      }

      unregisterQuery(queryId);
      if (onExternalAbort && options.abortSignal) {
        options.abortSignal.removeEventListener('abort', onExternalAbort);
      }

      const finalContent = resultContent || accumulatedAssistantText;

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
      return QueryExecutor.handleQueryError(error, queryId, sessionId, hasResultMessage, success, resultContent, stderrChunks);
    }
  }

  /**
   * Handle query execution errors.
   * Classifies errors (abort, rate limit, auth, timeout) and returns appropriate ClaudeResult.
   */
  private static handleQueryError(
    error: unknown,
    queryId: string,
    sessionId: string | undefined,
    hasResultMessage: boolean,
    success: boolean,
    resultContent: string | undefined,
    stderrChunks: string[],
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
      };
    }

    log.error('Claude query failed', { queryId, error: errorMessage });

    if (errorMessage.includes('rate_limit') || errorMessage.includes('rate limit')) {
      return { success: false, content: '', error: 'Rate limit exceeded. Please try again later.' };
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
