/**
 * OpenCode stream event handling.
 *
 * Converts OpenCode SDK SSE events into the unified StreamCallback format
 * used throughout the takt codebase.
 */

import type { StreamCallback } from '../claude/index.js';

/** Subset of OpenCode Part types relevant for stream handling */
export interface OpenCodeTextPart {
  id: string;
  type: 'text';
  text: string;
}

export interface OpenCodeReasoningPart {
  id: string;
  type: 'reasoning';
  text: string;
}

export interface OpenCodeToolPart {
  id: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: OpenCodeToolState;
}

export type OpenCodeToolState =
  | { status: 'pending'; input: Record<string, unknown> }
  | { status: 'running'; input: Record<string, unknown>; title?: string }
  | { status: 'completed'; input: Record<string, unknown>; output: string; title: string }
  | { status: 'error'; input: Record<string, unknown>; error: string };

export type OpenCodePart = OpenCodeTextPart | OpenCodeReasoningPart | OpenCodeToolPart | { id: string; type: string };

/** OpenCode SSE event types relevant for stream handling */
export interface OpenCodeMessagePartUpdatedEvent {
  type: 'message.part.updated';
  properties: { part: OpenCodePart; delta?: string };
}

export interface OpenCodeSessionIdleEvent {
  type: 'session.idle';
  properties: { sessionID: string };
}

export interface OpenCodeSessionStatusEvent {
  type: 'session.status';
  properties: {
    sessionID: string;
    status: { type: 'idle' | 'busy' | 'retry'; attempt?: number; message?: string; next?: number };
  };
}

export interface OpenCodeSessionErrorEvent {
  type: 'session.error';
  properties: {
    sessionID?: string;
    error?: { name: string; data: { message: string } };
  };
}

export interface OpenCodeMessageUpdatedEvent {
  type: 'message.updated';
  properties: {
    info: {
      sessionID: string;
      role: 'assistant' | 'user';
      time?: { created?: number; completed?: number };
      error?: unknown;
    };
  };
}

export interface OpenCodeMessageCompletedEvent {
  type: 'message.completed';
  properties: {
    info: {
      sessionID: string;
      role: 'assistant' | 'user';
      error?: unknown;
    };
  };
}

export interface OpenCodeMessageFailedEvent {
  type: 'message.failed';
  properties: {
    info: {
      sessionID: string;
      role: 'assistant' | 'user';
      error?: unknown;
    };
  };
}

export interface OpenCodePermissionAskedEvent {
  type: 'permission.asked';
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata: Record<string, unknown>;
    always: string[];
  };
}

export interface OpenCodeQuestionAskedEvent {
  type: 'question.asked';
  properties: {
    id: string;
    sessionID: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{
        label: string;
        description: string;
      }>;
      multiple?: boolean;
    }>;
  };
}

export type OpenCodeStreamEvent =
  | OpenCodeMessagePartUpdatedEvent
  | OpenCodeMessageUpdatedEvent
  | OpenCodeMessageCompletedEvent
  | OpenCodeMessageFailedEvent
  | OpenCodeSessionStatusEvent
  | OpenCodeSessionIdleEvent
  | OpenCodeSessionErrorEvent
  | OpenCodePermissionAskedEvent
  | OpenCodeQuestionAskedEvent
  | { type: string; properties: Record<string, unknown> };

/** Tracking state for stream offsets during a single OpenCode session */
export interface StreamTrackingState {
  textOffsets: Map<string, number>;
  thinkingOffsets: Map<string, number>;
  startedTools: Set<string>;
}

export function createStreamTrackingState(): StreamTrackingState {
  return {
    textOffsets: new Map<string, number>(),
    thinkingOffsets: new Map<string, number>(),
    startedTools: new Set<string>(),
  };
}

// ---- Stream emission helpers ----

export function emitInit(
  onStream: StreamCallback | undefined,
  model: string,
  sessionId: string,
): void {
  if (!onStream) return;
  onStream({
    type: 'init',
    data: {
      model,
      sessionId,
    },
  });
}

export function emitText(onStream: StreamCallback | undefined, text: string): void {
  if (!onStream || !text) return;
  onStream({ type: 'text', data: { text } });
}

export function emitThinking(onStream: StreamCallback | undefined, thinking: string): void {
  if (!onStream || !thinking) return;
  onStream({ type: 'thinking', data: { thinking } });
}

export function emitToolUse(
  onStream: StreamCallback | undefined,
  tool: string,
  input: Record<string, unknown>,
  id: string,
): void {
  if (!onStream) return;
  onStream({ type: 'tool_use', data: { tool, input, id } });
}

export function emitToolResult(
  onStream: StreamCallback | undefined,
  content: string,
  isError: boolean,
): void {
  if (!onStream) return;
  onStream({ type: 'tool_result', data: { content, isError } });
}

export function emitResult(
  onStream: StreamCallback | undefined,
  success: boolean,
  result: string,
  sessionId: string,
): void {
  if (!onStream) return;
  onStream({
    type: 'result',
    data: {
      result,
      sessionId,
      success,
      error: success ? undefined : result || undefined,
    },
  });
}

/** Process a message.part.updated event and emit appropriate stream events */
export function handlePartUpdated(
  part: OpenCodePart,
  delta: string | undefined,
  onStream: StreamCallback | undefined,
  state: StreamTrackingState,
): void {
  if (!onStream) return;

  switch (part.type) {
    case 'text': {
      const textPart = part as OpenCodeTextPart;
      if (delta) {
        emitText(onStream, delta);
      } else {
        const prev = state.textOffsets.get(textPart.id) ?? 0;
        if (textPart.text.length > prev) {
          emitText(onStream, textPart.text.slice(prev));
          state.textOffsets.set(textPart.id, textPart.text.length);
        }
      }
      break;
    }
    case 'reasoning': {
      const reasoningPart = part as OpenCodeReasoningPart;
      if (delta) {
        emitThinking(onStream, delta);
      } else {
        const prev = state.thinkingOffsets.get(reasoningPart.id) ?? 0;
        if (reasoningPart.text.length > prev) {
          emitThinking(onStream, reasoningPart.text.slice(prev));
          state.thinkingOffsets.set(reasoningPart.id, reasoningPart.text.length);
        }
      }
      break;
    }
    case 'tool': {
      const toolPart = part as OpenCodeToolPart;
      handleToolPartUpdated(toolPart, onStream, state);
      break;
    }
    default:
      break;
  }
}

function handleToolPartUpdated(
  toolPart: OpenCodeToolPart,
  onStream: StreamCallback,
  state: StreamTrackingState,
): void {
  const toolId = toolPart.callID || toolPart.id;

  if (!state.startedTools.has(toolId)) {
    emitToolUse(onStream, toolPart.tool, toolPart.state.input, toolId);
    state.startedTools.add(toolId);
  }

  switch (toolPart.state.status) {
    case 'completed':
      emitToolResult(onStream, toolPart.state.output, false);
      break;
    case 'error':
      emitToolResult(onStream, toolPart.state.error, true);
      break;
  }
}
