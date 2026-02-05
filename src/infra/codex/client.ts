/**
 * Codex SDK integration for agent interactions
 *
 * Uses @openai/codex-sdk for native TypeScript integration.
 */

import { Codex } from '@openai/codex-sdk';
import type { AgentResponse } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
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

/**
 * Client for Codex SDK agent interactions.
 *
 * Handles thread management, streaming event conversion,
 * and response processing.
 */
export class CodexClient {
  /** Call Codex with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: CodexCallOptions,
  ): Promise<AgentResponse> {
    const codex = new Codex(options.openaiApiKey ? { apiKey: options.openaiApiKey } : undefined);
    const sandboxMode = options.permissionMode
      ? mapToCodexSandboxMode(options.permissionMode)
      : 'workspace-write';
    const threadOptions = {
      ...(options.model ? { model: options.model } : {}),
      workingDirectory: options.cwd,
      sandboxMode,
    };
    const thread = options.sessionId
      ? await codex.resumeThread(options.sessionId, threadOptions)
      : await codex.startThread(threadOptions);
    let threadId = extractThreadId(thread) || options.sessionId;

    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    try {
      log.debug('Executing Codex thread', {
        agentType,
        model: options.model,
        hasSystemPrompt: !!options.systemPrompt,
      });

      const { events } = await thread.runStreamed(fullPrompt);
      let content = '';
      const contentOffsets = new Map<string, number>();
      let success = true;
      let failureMessage = '';
      const state = createStreamTrackingState();

      for await (const event of events as AsyncGenerator<CodexEvent>) {
        if (event.type === 'thread.started') {
          threadId = typeof event.thread_id === 'string' ? event.thread_id : threadId;
          emitInit(options.onStream, options.model, threadId);
          continue;
        }

        if (event.type === 'turn.failed') {
          success = false;
          if (event.error && typeof event.error === 'object' && 'message' in event.error) {
            failureMessage = String((event.error as { message?: unknown }).message ?? '');
          }
          break;
        }

        if (event.type === 'error') {
          success = false;
          failureMessage = typeof event.message === 'string' ? event.message : 'Unknown error';
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

      if (!success) {
        const message = failureMessage || 'Codex execution failed';
        emitResult(options.onStream, false, message, threadId);
        return {
          agent: agentType,
          status: 'blocked',
          content: message,
          timestamp: new Date(),
          sessionId: threadId,
        };
      }

      const trimmed = content.trim();
      emitResult(options.onStream, true, trimmed, threadId);

      return {
        agent: agentType,
        status: 'done',
        content: trimmed,
        timestamp: new Date(),
        sessionId: threadId,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      emitResult(options.onStream, false, message, threadId);

      return {
        agent: agentType,
        status: 'blocked',
        content: message,
        timestamp: new Date(),
        sessionId: threadId,
      };
    }
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
