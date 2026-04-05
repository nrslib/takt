/**
 * SDK message to stream event converter
 *
 * Converts Claude Agent SDK messages to the internal stream event format
 * for use with the streaming display system.
 */

import type {
  SDKMessage,
  SDKResultMessage,
  SDKAssistantMessage,
  SDKRateLimitEvent,
  SDKSystemMessage,
  SDKUserMessage,
  SDKPartialAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamCallback } from './types.js';

/** Content block delta types for streaming events */
interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

interface TextDelta {
  type: 'text_delta';
  text: string;
}

/** Type guard for thinking delta */
function isThinkingDelta(delta: unknown): delta is ThinkingDelta {
  return (
    typeof delta === 'object' &&
    delta !== null &&
    'type' in delta &&
    delta.type === 'thinking_delta' &&
    'thinking' in delta &&
    typeof (delta as ThinkingDelta).thinking === 'string'
  );
}

/** Type guard for text delta */
function isTextDelta(delta: unknown): delta is TextDelta {
  return (
    typeof delta === 'object' &&
    delta !== null &&
    'type' in delta &&
    delta.type === 'text_delta' &&
    'text' in delta &&
    typeof (delta as TextDelta).text === 'string'
  );
}

/** Extract tool result content from SDK user message */
function extractToolResultContent(toolResult: unknown): { content: string; isError: boolean } {
  if (!toolResult || typeof toolResult !== 'object') {
    return { content: String(toolResult ?? ''), isError: false };
  }

  const result = toolResult as Record<string, unknown>;
  const isError = !!result.is_error;

  // Handle stdout/stderr format (Bash, etc.)
  if (result.stdout !== undefined || result.stderr !== undefined) {
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    return {
      content: isError ? (stderr || stdout) : stdout,
      isError,
    };
  }

  // Handle content format (Read, Glob, Grep, etc.)
  if (result.content !== undefined) {
    return {
      content: String(result.content),
      isError,
    };
  }

  // Fallback: stringify the result
  return {
    content: JSON.stringify(toolResult),
    isError,
  };
}

/**
 * Convert SDK message to stream event.
 *
 * @param message - The SDK message to convert
 * @param callback - The callback to invoke with stream events
 * @param isStreaming - Whether streaming mode is enabled (includePartialMessages=true).
 *                      When true, text from 'assistant' messages is skipped because
 *                      it was already displayed via 'stream_event' deltas.
 */
export function sdkMessageToStreamEvent(
  message: SDKMessage,
  callback: StreamCallback,
  isStreaming: boolean
): void {
  switch (message.type) {
    case 'system': {
      const sysMsg = message as SDKSystemMessage;
      if (sysMsg.subtype === 'init') {
        callback({
          type: 'init',
          data: {
            model: sysMsg.model,
            sessionId: sysMsg.session_id,
          },
        });
      }
      break;
    }

    case 'assistant': {
      const assistantMsg = message as SDKAssistantMessage;
      if (assistantMsg.error) {
        callback({
          type: 'assistant_error',
          data: {
            error: assistantMsg.error,
            sessionId: assistantMsg.session_id,
          },
        });
      }
      for (const block of assistantMsg.message.content) {
        if (block.type === 'text') {
          // Skip text blocks when streaming is enabled - they were already
          // displayed via stream_event deltas. Only emit for non-streaming mode.
          if (!isStreaming) {
            callback({
              type: 'text',
              data: { text: block.text },
            });
          }
        } else if (block.type === 'tool_use') {
          callback({
            type: 'tool_use',
            data: {
              tool: block.name,
              input: block.input as Record<string, unknown>,
              id: block.id,
            },
          });
        }
      }
      break;
    }

    case 'user': {
      // Handle tool execution results
      const userMsg = message as SDKUserMessage;
      if (userMsg.tool_use_result !== undefined) {
        const { content, isError } = extractToolResultContent(userMsg.tool_use_result);
        callback({
          type: 'tool_result',
          data: { content, isError },
        });
      }
      break;
    }

    case 'rate_limit_event': {
      const rateLimitMsg = message as SDKRateLimitEvent;
      callback({
        type: 'rate_limit',
        data: {
          sessionId: rateLimitMsg.session_id,
          status: rateLimitMsg.rate_limit_info.status,
          rateLimitType: rateLimitMsg.rate_limit_info.rateLimitType,
          overageStatus: rateLimitMsg.rate_limit_info.overageStatus,
          overageDisabledReason: rateLimitMsg.rate_limit_info.overageDisabledReason,
          resetsAt: rateLimitMsg.rate_limit_info.resetsAt,
          overageResetsAt: rateLimitMsg.rate_limit_info.overageResetsAt,
          isUsingOverage: rateLimitMsg.rate_limit_info.isUsingOverage,
        },
      });
      break;
    }

    case 'result': {
      const resultMsg = message as SDKResultMessage;
      const errors = resultMsg.subtype !== 'success' && resultMsg.errors?.length
        ? resultMsg.errors.join('\n')
        : undefined;
      callback({
        type: 'result',
        data: {
          result: resultMsg.subtype === 'success' ? resultMsg.result : '',
          sessionId: resultMsg.session_id,
          success: resultMsg.subtype === 'success',
          error: errors,
        },
      });
      break;
    }

    case 'stream_event': {
      // Handle partial/streaming messages for real-time output.
      // Note: 'assistant' messages contain the final complete content,
      // while 'stream_event' provides incremental deltas during streaming.
      // Both paths don't duplicate because:
      // - stream_event: fires during streaming for real-time display
      // - assistant: fires after streaming completes with full message
      // We only use stream_event for thinking (not available in final message)
      // and for real-time text display during streaming.
      const streamMsg = message as SDKPartialAssistantMessage;
      const event = streamMsg.event;

      // Guard: ensure event exists and has expected structure
      if (!event || typeof event !== 'object' || !('type' in event)) {
        break;
      }

      // Handle content block delta events
      if (event.type === 'content_block_delta' && 'delta' in event) {
        const delta = event.delta;

        // Thinking delta (Claude's internal reasoning)
        if (isThinkingDelta(delta)) {
          callback({
            type: 'thinking',
            data: { thinking: delta.thinking },
          });
        }
        // Text delta - only emit for streaming display
        // The 'assistant' case handles the final complete text
        else if (isTextDelta(delta)) {
          callback({
            type: 'text',
            data: { text: delta.text },
          });
        }
      }
      break;
    }
  }
}
