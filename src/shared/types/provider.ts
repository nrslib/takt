/**
 * Shared provider-protocol types used across layers.
 *
 * Defined here (shared/) rather than core/piece/ so that modules in the
 * shared/ layer (StreamDisplay, providerEventLogger, etc.) can import them
 * without creating an upward shared → core dependency.
 *
 * core/piece/types.ts re-exports these for backward compatibility.
 */

export type ProviderType = 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';

export interface StreamInitEventData {
  model: string;
  sessionId: string;
}

export interface StreamToolUseEventData {
  tool: string;
  input: Record<string, unknown>;
  id: string;
}

export interface StreamToolResultEventData {
  content: string;
  isError: boolean;
}

export interface StreamToolOutputEventData {
  tool: string;
  output: string;
}

export interface StreamTextEventData {
  text: string;
}

export interface StreamThinkingEventData {
  thinking: string;
}

export interface StreamResultEventData {
  result: string;
  sessionId: string;
  success: boolean;
  error?: string;
}

export interface StreamErrorEventData {
  message: string;
  raw?: string;
}

export type StreamEvent =
  | { type: 'init'; data: StreamInitEventData }
  | { type: 'tool_use'; data: StreamToolUseEventData }
  | { type: 'tool_result'; data: StreamToolResultEventData }
  | { type: 'tool_output'; data: StreamToolOutputEventData }
  | { type: 'text'; data: StreamTextEventData }
  | { type: 'thinking'; data: StreamThinkingEventData }
  | { type: 'result'; data: StreamResultEventData }
  | { type: 'error'; data: StreamErrorEventData };

export type StreamCallback = (event: StreamEvent) => void;
