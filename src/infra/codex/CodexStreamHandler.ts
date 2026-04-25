/**
 * Codex stream event handling.
 *
 * Converts Codex SDK events into the unified StreamCallback format
 * used throughout the takt codebase.
 */

import type { AgentFailureCategory } from '../../shared/types/agent-failure.js';
import type { StreamCallback } from '../../shared/types/provider.js';

export type CodexEvent = {
  type: string;
  [key: string]: unknown;
};

export type CodexItem = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

/** Tracking state for stream offsets during a single Codex thread run */
export interface StreamTrackingState {
  startedItems: Set<string>;
  outputOffsets: Map<string, number>;
  textOffsets: Map<string, number>;
  thinkingOffsets: Map<string, number>;
}

export function createStreamTrackingState(): StreamTrackingState {
  return {
    startedItems: new Set<string>(),
    outputOffsets: new Map<string, number>(),
    textOffsets: new Map<string, number>(),
    thinkingOffsets: new Map<string, number>(),
  };
}

// ---- Stream emission helpers ----

export function extractThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id ?? record.thread_id ?? record.threadId;
  return typeof id === 'string' ? id : undefined;
}

export function emitInit(
  onStream: StreamCallback | undefined,
  model: string | undefined,
  sessionId: string | undefined,
): void {
  if (!onStream) return;
  onStream({
    type: 'init',
    data: {
      model: model || 'codex',
      sessionId: sessionId || 'unknown',
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

export function emitToolOutput(
  onStream: StreamCallback | undefined,
  tool: string,
  output: string,
): void {
  if (!onStream || !output) return;
  onStream({ type: 'tool_output', data: { tool, output } });
}

export function emitResult(
  onStream: StreamCallback | undefined,
  success: boolean,
  result: string,
  sessionId: string | undefined,
  failureCategory?: AgentFailureCategory,
): void {
  if (!onStream) return;
  onStream({
    type: 'result',
    data: {
      result,
      sessionId: sessionId || 'unknown',
      success,
      error: success ? undefined : result || undefined,
      ...(failureCategory ? { failureCategory } : {}),
    },
  });
}

export function formatFileChangeSummary(changes: Array<{ path?: string; kind?: string }>): string {
  if (!changes.length) return '';
  return changes
    .map((change) => {
      const kind = change.kind ? `${change.kind}: ` : '';
      return `${kind}${change.path ?? ''}`.trim();
    })
    .filter(Boolean)
    .join('\n');
}

export function emitCodexItemStart(
  item: CodexItem,
  onStream: StreamCallback | undefined,
  startedItems: Set<string>,
): void {
  if (!onStream) return;
  const id = item.id || `item_${Math.random().toString(36).slice(2, 10)}`;
  if (startedItems.has(id)) return;

  switch (item.type) {
    case 'command_execution': {
      const command = typeof item.command === 'string' ? item.command : '';
      emitToolUse(onStream, 'Bash', { command }, id);
      startedItems.add(id);
      break;
    }
    case 'mcp_tool_call': {
      const tool = typeof item.tool === 'string' ? item.tool : 'Tool';
      const args = (item.arguments ?? {}) as Record<string, unknown>;
      emitToolUse(onStream, tool, args, id);
      startedItems.add(id);
      break;
    }
    case 'web_search': {
      const query = typeof item.query === 'string' ? item.query : '';
      emitToolUse(onStream, 'WebSearch', { query }, id);
      startedItems.add(id);
      break;
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const summary = formatFileChangeSummary(changes as Array<{ path?: string; kind?: string }>);
      emitToolUse(onStream, 'Edit', { file_path: summary || 'patch' }, id);
      startedItems.add(id);
      break;
    }
    default:
      break;
  }
}

export function emitCodexItemCompleted(
  item: CodexItem,
  onStream: StreamCallback | undefined,
  state: StreamTrackingState,
): void {
  if (!onStream) return;
  const id = item.id || `item_${Math.random().toString(36).slice(2, 10)}`;

  switch (item.type) {
    case 'reasoning': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = state.thinkingOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitThinking(onStream, text.slice(prev) + '\n');
          state.thinkingOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'agent_message': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = state.textOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitText(onStream, text.slice(prev));
          state.textOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'command_execution': {
      if (!state.startedItems.has(id)) {
        emitCodexItemStart(item, onStream, state.startedItems);
      }
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      if (output) {
        const prev = state.outputOffsets.get(id) ?? 0;
        if (output.length > prev) {
          emitToolOutput(onStream, 'Bash', output.slice(prev));
          state.outputOffsets.set(id, output.length);
        }
      }
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
      const status = typeof item.status === 'string' ? item.status : '';
      const isError = status === 'failed' || (exitCode !== undefined && exitCode !== 0);
      const content = output || (exitCode !== undefined ? `Exit code: ${exitCode}` : '');
      emitToolResult(onStream, content, isError);
      break;
    }
    case 'mcp_tool_call': {
      if (!state.startedItems.has(id)) {
        emitCodexItemStart(item, onStream, state.startedItems);
      }
      const status = typeof item.status === 'string' ? item.status : '';
      const isError = status === 'failed' || !!item.error;
      const errorMessage =
        item.error && typeof item.error === 'object' && 'message' in item.error
          ? String((item.error as { message?: unknown }).message ?? '')
          : '';
      let content = errorMessage;
      if (!content && item.result && typeof item.result === 'object') {
        try {
          content = JSON.stringify(item.result);
        } catch {
          content = '';
        }
      }
      emitToolResult(onStream, content, isError);
      break;
    }
    case 'web_search': {
      if (!state.startedItems.has(id)) {
        emitCodexItemStart(item, onStream, state.startedItems);
      }
      emitToolResult(onStream, 'Search completed', false);
      break;
    }
    case 'file_change': {
      if (!state.startedItems.has(id)) {
        emitCodexItemStart(item, onStream, state.startedItems);
      }
      const status = typeof item.status === 'string' ? item.status : '';
      const isError = status === 'failed';
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const summary = formatFileChangeSummary(changes as Array<{ path?: string; kind?: string }>);
      emitToolResult(onStream, summary || 'Applied patch', isError);
      break;
    }
    default:
      break;
  }
}

export function emitCodexItemUpdate(
  item: CodexItem,
  onStream: StreamCallback | undefined,
  state: StreamTrackingState,
): void {
  if (!onStream) return;
  const id = item.id || `item_${Math.random().toString(36).slice(2, 10)}`;

  switch (item.type) {
    case 'command_execution': {
      if (!state.startedItems.has(id)) {
        emitCodexItemStart(item, onStream, state.startedItems);
      }
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      if (output) {
        const prev = state.outputOffsets.get(id) ?? 0;
        if (output.length > prev) {
          emitToolOutput(onStream, 'Bash', output.slice(prev));
          state.outputOffsets.set(id, output.length);
        }
      }
      break;
    }
    case 'agent_message': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = state.textOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitText(onStream, text.slice(prev));
          state.textOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'reasoning': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = state.thinkingOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitThinking(onStream, text.slice(prev));
          state.thinkingOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'file_change':
    case 'mcp_tool_call':
    case 'web_search': {
      if (!state.startedItems.has(id)) {
        emitCodexItemStart(item, onStream, state.startedItems);
      }
      break;
    }
    default:
      break;
  }
}
