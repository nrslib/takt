/**
 * Tests for OpenCode stream event handling
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createStreamTrackingState,
  emitInit,
  emitText,
  emitThinking,
  emitToolUse,
  emitToolResult,
  emitResult,
  handlePartUpdated,
  type OpenCodeStreamEvent,
  type OpenCodeTextPart,
  type OpenCodeReasoningPart,
  type OpenCodeToolPart,
} from '../infra/opencode/OpenCodeStreamHandler.js';
import type { StreamCallback } from '../core/piece/types.js';

describe('createStreamTrackingState', () => {
  it('should create fresh state with empty collections', () => {
    const state = createStreamTrackingState();

    expect(state.textOffsets.size).toBe(0);
    expect(state.thinkingOffsets.size).toBe(0);
    expect(state.startedTools.size).toBe(0);
  });
});

describe('emitInit', () => {
  it('should emit init event with model and sessionId', () => {
    const onStream = vi.fn();

    emitInit(onStream, 'opencode/big-pickle', 'session-123');

    expect(onStream).toHaveBeenCalledOnce();
    expect(onStream).toHaveBeenCalledWith({
      type: 'init',
      data: { model: 'opencode/big-pickle', sessionId: 'session-123' },
    });
  });

  it('should not emit when onStream is undefined', () => {
    emitInit(undefined, 'opencode/big-pickle', 'session-123');
  });
});

describe('emitText', () => {
  it('should emit text event', () => {
    const onStream = vi.fn();

    emitText(onStream, 'Hello world');

    expect(onStream).toHaveBeenCalledWith({
      type: 'text',
      data: { text: 'Hello world' },
    });
  });

  it('should not emit when text is empty', () => {
    const onStream = vi.fn();

    emitText(onStream, '');

    expect(onStream).not.toHaveBeenCalled();
  });

  it('should not emit when onStream is undefined', () => {
    emitText(undefined, 'Hello');
  });
});

describe('emitThinking', () => {
  it('should emit thinking event', () => {
    const onStream = vi.fn();

    emitThinking(onStream, 'Reasoning...');

    expect(onStream).toHaveBeenCalledWith({
      type: 'thinking',
      data: { thinking: 'Reasoning...' },
    });
  });

  it('should not emit when thinking is empty', () => {
    const onStream = vi.fn();

    emitThinking(onStream, '');

    expect(onStream).not.toHaveBeenCalled();
  });
});

describe('emitToolUse', () => {
  it('should emit tool_use event', () => {
    const onStream = vi.fn();

    emitToolUse(onStream, 'Bash', { command: 'ls' }, 'tool-1');

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_use',
      data: { tool: 'Bash', input: { command: 'ls' }, id: 'tool-1' },
    });
  });
});

describe('emitToolResult', () => {
  it('should emit tool_result event for success', () => {
    const onStream = vi.fn();

    emitToolResult(onStream, 'file.txt', false);

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_result',
      data: { content: 'file.txt', isError: false },
    });
  });

  it('should emit tool_result event for error', () => {
    const onStream = vi.fn();

    emitToolResult(onStream, 'command not found', true);

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_result',
      data: { content: 'command not found', isError: true },
    });
  });
});

describe('emitResult', () => {
  it('should emit result event for success', () => {
    const onStream = vi.fn();

    emitResult(onStream, true, 'Completed', 'session-1');

    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: 'Completed',
        sessionId: 'session-1',
        success: true,
        error: undefined,
      },
    });
  });

  it('should emit result event for failure', () => {
    const onStream = vi.fn();

    emitResult(onStream, false, 'Network error', 'session-1');

    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: 'Network error',
        sessionId: 'session-1',
        success: false,
        error: 'Network error',
      },
    });
  });
});

describe('handlePartUpdated', () => {
  it('should handle text part with delta', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    const part: OpenCodeTextPart = { id: 'p1', type: 'text', text: 'Hello world' };

    handlePartUpdated(part, 'Hello', onStream, state);

    expect(onStream).toHaveBeenCalledWith({
      type: 'text',
      data: { text: 'Hello' },
    });
  });

  it('should handle text part without delta using offset tracking', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    const part1: OpenCodeTextPart = { id: 'p1', type: 'text', text: 'Hello' };
    handlePartUpdated(part1, undefined, onStream, state);

    expect(onStream).toHaveBeenCalledWith({
      type: 'text',
      data: { text: 'Hello' },
    });

    onStream.mockClear();

    const part2: OpenCodeTextPart = { id: 'p1', type: 'text', text: 'Hello world' };
    handlePartUpdated(part2, undefined, onStream, state);

    expect(onStream).toHaveBeenCalledWith({
      type: 'text',
      data: { text: ' world' },
    });
  });

  it('should not emit duplicate text when offset has not changed', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    const part: OpenCodeTextPart = { id: 'p1', type: 'text', text: 'Hello' };
    handlePartUpdated(part, undefined, onStream, state);
    onStream.mockClear();

    handlePartUpdated(part, undefined, onStream, state);

    expect(onStream).not.toHaveBeenCalled();
  });

  it('should handle reasoning part with delta', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    const part: OpenCodeReasoningPart = { id: 'r1', type: 'reasoning', text: 'Thinking...' };

    handlePartUpdated(part, 'Thinking', onStream, state);

    expect(onStream).toHaveBeenCalledWith({
      type: 'thinking',
      data: { thinking: 'Thinking' },
    });
  });

  it('should handle reasoning part without delta using offset tracking', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    const part: OpenCodeReasoningPart = { id: 'r1', type: 'reasoning', text: 'Step 1' };
    handlePartUpdated(part, undefined, onStream, state);

    expect(onStream).toHaveBeenCalledWith({
      type: 'thinking',
      data: { thinking: 'Step 1' },
    });
  });

  it('should handle tool part in running state', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    const part: OpenCodeToolPart = {
      id: 't1',
      type: 'tool',
      callID: 'call-1',
      tool: 'Bash',
      state: { status: 'running', input: { command: 'ls' } },
    };

    handlePartUpdated(part, undefined, onStream, state);

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_use',
      data: { tool: 'Bash', input: { command: 'ls' }, id: 'call-1' },
    });
    expect(state.startedTools.has('call-1')).toBe(true);
  });

  it('should handle tool part in completed state', () => {
    const onStream: StreamCallback = vi.fn();
    const state = createStreamTrackingState();

    const part: OpenCodeToolPart = {
      id: 't1',
      type: 'tool',
      callID: 'call-1',
      tool: 'Bash',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'file.txt',
        title: 'List files',
      },
    };

    handlePartUpdated(part, undefined, onStream, state);

    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'tool_use',
      data: { tool: 'Bash', input: { command: 'ls' }, id: 'call-1' },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'tool_result',
      data: { content: 'file.txt', isError: false },
    });
  });

  it('should handle tool part in error state', () => {
    const onStream: StreamCallback = vi.fn();
    const state = createStreamTrackingState();

    const part: OpenCodeToolPart = {
      id: 't1',
      type: 'tool',
      callID: 'call-1',
      tool: 'Bash',
      state: {
        status: 'error',
        input: { command: 'rm -rf /' },
        error: 'Permission denied',
      },
    };

    handlePartUpdated(part, undefined, onStream, state);

    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'tool_result',
      data: { content: 'Permission denied', isError: true },
    });
  });

  it('should not emit duplicate tool_use for already-started tool', () => {
    const onStream: StreamCallback = vi.fn();
    const state = createStreamTrackingState();
    state.startedTools.add('call-1');

    const part: OpenCodeToolPart = {
      id: 't1',
      type: 'tool',
      callID: 'call-1',
      tool: 'Bash',
      state: { status: 'running', input: { command: 'ls' } },
    };

    handlePartUpdated(part, undefined, onStream, state);

    expect(onStream).not.toHaveBeenCalled();
  });

  it('should ignore unknown part types', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    handlePartUpdated({ id: 'x1', type: 'unknown' }, undefined, onStream, state);

    expect(onStream).not.toHaveBeenCalled();
  });

  it('should not emit when onStream is undefined', () => {
    const state = createStreamTrackingState();

    const part: OpenCodeTextPart = { id: 'p1', type: 'text', text: 'Hello' };
    handlePartUpdated(part, 'Hello', undefined, state);
  });
});

describe('OpenCodeStreamEvent typing', () => {
  it('should accept message.completed event shape', () => {
    const event: OpenCodeStreamEvent = {
      type: 'message.completed',
      properties: {
        info: {
          sessionID: 'session-1',
          role: 'assistant',
          error: undefined,
        },
      },
    };

    expect(event.type).toBe('message.completed');
  });

  it('should accept message.failed event shape', () => {
    const event: OpenCodeStreamEvent = {
      type: 'message.failed',
      properties: {
        info: {
          sessionID: 'session-2',
          role: 'assistant',
          error: { message: 'failed' },
        },
      },
    };

    expect(event.type).toBe('message.failed');
  });
});
