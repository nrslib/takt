/**
 * Claude query executor
 *
 * Executes Claude queries using the Agent SDK and handles
 * response processing and error handling.
 */

import {
  query,
  AbortError,
  type Options,
  type SDKResultMessage,
  type SDKAssistantMessage,
  type AgentDefinition,
  type PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';
import {
  generateQueryId,
  registerQuery,
  unregisterQuery,
} from './query-manager.js';
import { sdkMessageToStreamEvent } from './stream-converter.js';
import {
  createCanUseToolCallback,
  createAskUserQuestionHooks,
} from './options-builder.js';
import type {
  StreamCallback,
  PermissionHandler,
  AskUserQuestionHandler,
  ClaudeResult,
} from './types.js';

const log = createLogger('claude-sdk');

/** Options for executing Claude queries */
export interface ExecuteOptions {
  cwd: string;
  sessionId?: string;
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  onStream?: StreamCallback;
  agents?: Record<string, AgentDefinition>;
  permissionMode?: PermissionMode;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
  /** Anthropic API key to inject via env (bypasses CLI auth) */
  anthropicApiKey?: string;
}

/**
 * Build SDK options from ExecuteOptions.
 */
function buildSdkOptions(options: ExecuteOptions): Options {
  const canUseTool = options.onPermissionRequest
    ? createCanUseToolCallback(options.onPermissionRequest)
    : undefined;

  const hooks = options.onAskUserQuestion
    ? createAskUserQuestionHooks(options.onAskUserQuestion)
    : undefined;

  // Determine permission mode
  // Priority: bypassPermissions > explicit permissionMode > callback-based default
  let permissionMode: PermissionMode;
  if (options.bypassPermissions) {
    permissionMode = 'bypassPermissions';
  } else if (options.permissionMode) {
    permissionMode = options.permissionMode;
  } else if (options.onPermissionRequest) {
    permissionMode = 'default';
  } else {
    permissionMode = 'acceptEdits';
  }

  // Only include defined values — the SDK treats key-present-but-undefined
  // differently from key-absent for some options (e.g. model), causing hangs.
  const sdkOptions: Options = {
    cwd: options.cwd,
    permissionMode,
  };

  if (options.model) sdkOptions.model = options.model;
  if (options.maxTurns != null) sdkOptions.maxTurns = options.maxTurns;
  if (options.allowedTools) sdkOptions.allowedTools = options.allowedTools;
  if (options.agents) sdkOptions.agents = options.agents;
  if (options.systemPrompt) sdkOptions.systemPrompt = options.systemPrompt;
  if (canUseTool) sdkOptions.canUseTool = canUseTool;
  if (hooks) sdkOptions.hooks = hooks;

  if (options.anthropicApiKey) {
    sdkOptions.env = {
      ...process.env as Record<string, string>,
      ANTHROPIC_API_KEY: options.anthropicApiKey,
    };
  }

  if (options.onStream) {
    sdkOptions.includePartialMessages = true;
  }

  if (options.sessionId) {
    sdkOptions.resume = options.sessionId;
  } else {
    sdkOptions.continue = false;
  }

  return sdkOptions;
}

/**
 * Execute a Claude query using the Agent SDK.
 */
export async function executeClaudeQuery(
  prompt: string,
  options: ExecuteOptions
): Promise<ClaudeResult> {
  const queryId = generateQueryId();

  log.debug('Executing Claude query via SDK', {
    queryId,
    cwd: options.cwd,
    model: options.model,
    hasSystemPrompt: !!options.systemPrompt,
    allowedTools: options.allowedTools,
  });

  const sdkOptions = buildSdkOptions(options);

  let sessionId: string | undefined;
  let success = false;
  let resultContent: string | undefined;
  let hasResultMessage = false;
  let accumulatedAssistantText = '';

  try {
    const q = query({ prompt, options: sdkOptions });
    registerQuery(queryId, q);

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
    unregisterQuery(queryId);
    return handleQueryError(error, queryId, sessionId, hasResultMessage, success, resultContent);
  }
}

/**
 * Handle query execution errors.
 */
function handleQueryError(
  error: unknown,
  queryId: string,
  sessionId: string | undefined,
  hasResultMessage: boolean,
  success: boolean,
  resultContent: string | undefined
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

  return { success: false, content: '', error: errorMessage };
}
