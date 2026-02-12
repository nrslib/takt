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
          if (resultMsg.subtype === 'success') {
            resultContent = resultMsg.result;
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

      return {
        success,
        content: finalContent.trim(),
        sessionId,
        fullContent: accumulatedAssistantText.trim(),
      };
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
