/**
 * Codex SDK integration for agent interactions
 *
 * Uses @openai/codex-sdk for native TypeScript integration.
 */

import { Codex } from '@openai/codex-sdk';
import type { AgentResponse, Status } from '../models/types.js';
import type { StreamCallback } from '../claude/process.js';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';

const log = createLogger('codex-sdk');

/** Options for calling Codex */
export interface CodexCallOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  /** Enable streaming mode with callback (best-effort) */
  onStream?: StreamCallback;
  /** OpenAI API key (bypasses CLI auth) */
  openaiApiKey?: string;
}

function extractThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id ?? record.thread_id ?? record.threadId;
  return typeof id === 'string' ? id : undefined;
}

function emitInit(
  onStream: StreamCallback | undefined,
  model: string | undefined,
  sessionId: string | undefined
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

function emitText(onStream: StreamCallback | undefined, text: string): void {
  if (!onStream || !text) return;
  onStream({ type: 'text', data: { text } });
}

function emitThinking(onStream: StreamCallback | undefined, thinking: string): void {
  if (!onStream || !thinking) return;
  onStream({ type: 'thinking', data: { thinking } });
}

function emitToolUse(
  onStream: StreamCallback | undefined,
  tool: string,
  input: Record<string, unknown>,
  id: string
): void {
  if (!onStream) return;
  onStream({ type: 'tool_use', data: { tool, input, id } });
}

function emitToolResult(
  onStream: StreamCallback | undefined,
  content: string,
  isError: boolean
): void {
  if (!onStream) return;
  onStream({ type: 'tool_result', data: { content, isError } });
}

function emitToolOutput(
  onStream: StreamCallback | undefined,
  tool: string,
  output: string
): void {
  if (!onStream || !output) return;
  onStream({ type: 'tool_output', data: { tool, output } });
}

function emitResult(
  onStream: StreamCallback | undefined,
  success: boolean,
  result: string,
  sessionId: string | undefined
): void {
  if (!onStream) return;
  onStream({
    type: 'result',
    data: {
      result,
      sessionId: sessionId || 'unknown',
      success,
      error: success ? undefined : result || undefined,
    },
  });
}

function determineStatus(success: boolean): Status {
  return success ? 'done' : 'blocked';
}

type CodexEvent = {
  type: string;
  [key: string]: unknown;
};

type CodexItem = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

function formatFileChangeSummary(changes: Array<{ path?: string; kind?: string }>): string {
  if (!changes.length) return '';
  return changes
    .map((change) => {
      const kind = change.kind ? `${change.kind}: ` : '';
      return `${kind}${change.path ?? ''}`.trim();
    })
    .filter(Boolean)
    .join('\n');
}

function emitCodexItemStart(
  item: CodexItem,
  onStream: StreamCallback | undefined,
  startedItems: Set<string>
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

function emitCodexItemCompleted(
  item: CodexItem,
  onStream: StreamCallback | undefined,
  startedItems: Set<string>,
  outputOffsets: Map<string, number>,
  textOffsets: Map<string, number>,
  thinkingOffsets: Map<string, number>
): void {
  if (!onStream) return;
  const id = item.id || `item_${Math.random().toString(36).slice(2, 10)}`;

  switch (item.type) {
    case 'reasoning': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = thinkingOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitThinking(onStream, text.slice(prev) + '\n');
          thinkingOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'agent_message': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = textOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitText(onStream, text.slice(prev));
          textOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'command_execution': {
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
      }
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      if (output) {
        const prev = outputOffsets.get(id) ?? 0;
        if (output.length > prev) {
          emitToolOutput(onStream, 'Bash', output.slice(prev));
          outputOffsets.set(id, output.length);
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
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
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
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
      }
      emitToolResult(onStream, 'Search completed', false);
      break;
    }
    case 'file_change': {
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
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

function emitCodexItemUpdate(
  item: CodexItem,
  onStream: StreamCallback | undefined,
  startedItems: Set<string>,
  outputOffsets: Map<string, number>,
  textOffsets: Map<string, number>,
  thinkingOffsets: Map<string, number>
): void {
  if (!onStream) return;
  const id = item.id || `item_${Math.random().toString(36).slice(2, 10)}`;

  switch (item.type) {
    case 'command_execution': {
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
      }
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      if (output) {
        const prev = outputOffsets.get(id) ?? 0;
        if (output.length > prev) {
          emitToolOutput(onStream, 'Bash', output.slice(prev));
          outputOffsets.set(id, output.length);
        }
      }
      break;
    }
    case 'agent_message': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = textOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitText(onStream, text.slice(prev));
          textOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'reasoning': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = thinkingOffsets.get(id) ?? 0;
        if (text.length > prev) {
          emitThinking(onStream, text.slice(prev));
          thinkingOffsets.set(id, text.length);
        }
      }
      break;
    }
    case 'file_change': {
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
      }
      break;
    }
    case 'mcp_tool_call': {
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
      }
      break;
    }
    case 'web_search': {
      if (!startedItems.has(id)) {
        emitCodexItemStart(item, onStream, startedItems);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Call Codex with an agent prompt.
 */
export async function callCodex(
  agentType: string,
  prompt: string,
  options: CodexCallOptions
): Promise<AgentResponse> {
  const codex = new Codex(options.openaiApiKey ? { apiKey: options.openaiApiKey } : undefined);
  const threadOptions = {
    model: options.model,
    workingDirectory: options.cwd,
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
    const startedItems = new Set<string>();
    const outputOffsets = new Map<string, number>();
    const textOffsets = new Map<string, number>();
    const thinkingOffsets = new Map<string, number>();

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
          emitCodexItemStart(item, options.onStream, startedItems);
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
          emitCodexItemUpdate(item, options.onStream, startedItems, outputOffsets, textOffsets, thinkingOffsets);
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
          emitCodexItemCompleted(
            item,
            options.onStream,
            startedItems,
            outputOffsets,
            textOffsets,
            thinkingOffsets
          );
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

    const status = determineStatus(true);

    return {
      agent: agentType,
      status,
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

/**
 * Call Codex with a custom agent configuration (system prompt + prompt).
 */
export async function callCodexCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: CodexCallOptions
): Promise<AgentResponse> {
  return callCodex(agentName, prompt, {
    ...options,
    systemPrompt,
  });
}
