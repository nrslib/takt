/**
 * Tests for OpenCode stream event handling
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStreamTrackingState,
  emitInit,
  emitText,
  emitThinking,
  emitToolUse,
  emitToolResult,
  emitPermissionAsked,
  emitResult,
  handlePartUpdated,
  OPENCODE_STREAM_EVENT_LIMIT,
  OPENCODE_STREAM_ID_LIMIT,
  OPENCODE_STREAM_TEXT_BYTE_LIMIT,
  trackOpenCodeTextBytes,
  trackOpenCodeStreamEvent,
  type OpenCodeStreamEvent,
  type OpenCodeTextPart,
  type OpenCodeReasoningPart,
  type OpenCodeToolPart,
} from '../infra/opencode/OpenCodeStreamHandler.js';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import type { StreamCallback } from '../core/workflow/types.js';
import { sanitizeSensitiveTextWithKnownValues } from '../shared/utils/sensitiveText.js';

function buildProviderEventCallback(
  logger: ReturnType<typeof createProviderEventLogger>,
): StreamCallback {
  return (event) => logger.logEvent({
    provider: 'opencode',
    providerModel: 'big-pickle',
    step: 'review',
  }, event);
}

describe('createStreamTrackingState', () => {
  it('should create fresh state with empty collections', () => {
    const state = createStreamTrackingState();

    expect(state.textOffsets.size).toBe(0);
    expect(state.thinkingOffsets.size).toBe(0);
    expect(state.startedTools.size).toBe(0);
    expect(state.latestToolInputs.size).toBe(0);
    expect(state.textBytes).toBe(0);
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

    emitToolResult(onStream, 'file.txt', false, {}, 'tool-1');

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_result',
      data: { id: 'tool-1', content: 'file.txt', isError: false },
    });
  });

  it('should emit tool_result event for error', () => {
    const onStream = vi.fn();

    emitToolResult(onStream, 'command not found', true, {}, 'tool-1');

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_result',
      data: { id: 'tool-1', content: 'command not found', isError: true },
    });
  });

  it('redacts sensitive tool input and known values from provider event JSONL', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-opencode-provider-events-'));
    try {
      const logger = createProviderEventLogger({
        logsDir,
        sessionId: 'session-1',
        runId: 'run-1',
        enabled: true,
      });
      const onStream = buildProviderEventCallback(logger);
      const input = {
        Authorization: 'Bearer opaque-auth-value',
        'Proxy-Authorization': 'Basic opaque-proxy-value',
        cookies: 'sid=opaque-cookie-value',
        sessionId: 'opaque-session-value',
        nested: { credentials: 'opaque-credential-value' },
        command: 'curl https://example.invalid',
      };

      emitToolUse(onStream, 'Bash', input, 'tool-sensitive');
      emitToolResult(
        onStream,
        'failed with opaque-auth-value, opaque-proxy-value, opaque-cookie-value, opaque-session-value and opaque-credential-value',
        true,
        input,
        'tool-sensitive',
      );

      const jsonl = readFileSync(logger.filepath, 'utf-8');
      expect(jsonl).not.toContain('opaque-auth-value');
      expect(jsonl).not.toContain('opaque-credential-value');
      expect(jsonl).not.toContain('opaque-proxy-value');
      expect(jsonl).not.toContain('opaque-cookie-value');
      expect(jsonl).not.toContain('opaque-session-value');
      expect(jsonl).toContain('[REDACTED]');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive values that appear only in JSON tool output', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-opencode-output-events-'));
    try {
      const logger = createProviderEventLogger({
        logsDir,
        sessionId: 'session-output',
        runId: 'run-output',
        enabled: true,
      });
      const outputOnlySecrets = {
        Authorization: 'Bearer output-only-auth-secret',
        Cookie: 'sid=output-only-cookie-secret',
        sessionId: 'output-only-session-secret',
      };

      emitToolResult(buildProviderEventCallback(logger), JSON.stringify(outputOnlySecrets), true, {}, 'tool-output');

      const jsonl = readFileSync(logger.filepath, 'utf-8');
      expect(jsonl).toContain('[REDACTED]');
      for (const secret of Object.values(outputOnlySecrets)) {
        expect(jsonl).not.toContain(secret);
      }
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('redacts unquoted authorization and cookie assignments in tool output', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-opencode-assignment-events-'));
    try {
      const logger = createProviderEventLogger({
        logsDir,
        sessionId: 'session-assignment',
        runId: 'run-assignment',
        enabled: true,
      });

      emitToolResult(
        buildProviderEventCallback(logger),
        'Authorization=opaque-authorization; Cookie=opaque-cookie',
        true,
        {},
        'tool-assignment',
      );

      const jsonl = readFileSync(logger.filepath, 'utf-8');
      expect(jsonl).not.toContain('opaque-authorization');
      expect(jsonl).not.toContain('opaque-cookie');
      expect(jsonl).toContain('[REDACTED]');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('redacts a short known secret without corrupting detector phrases', () => {
    const sanitized = sanitizeSensitiveTextWithKnownValues(
      'Invalid arguments: token "a"',
      { token: 'a' },
    );

    expect(sanitized).toContain('Invalid arguments');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('"a"');
  });
});

describe('emitPermissionAsked', () => {
  it('should emit permission_asked event', () => {
    const onStream = vi.fn();

    emitPermissionAsked(onStream, {
      requestId: 'perm-1',
      sessionId: 'session-1',
      permission: 'bash',
      patterns: ['**'],
      always: [],
      reply: 'reject',
    });

    expect(onStream).toHaveBeenCalledWith({
      type: 'permission_asked',
      data: {
        requestId: 'perm-1',
        sessionId: 'session-1',
        permission: 'bash',
        patterns: ['**'],
        always: [],
        reply: 'reject',
      },
    });
  });

  it('should redact credentials embedded in permission patterns and always rules', () => {
    const onStream = vi.fn();

    emitPermissionAsked(onStream, {
      requestId: 'perm-sensitive',
      sessionId: 'session-sensitive',
      permission: 'bash',
      patterns: ['Authorization: Bearer permission-pattern-secret'],
      always: ['session_id: permission-session-secret'],
      reply: 'reject',
    });

    const serialized = JSON.stringify(onStream.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('permission-pattern-secret');
    expect(serialized).not.toContain('permission-session-secret');
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('emitResult', () => {
  it('should emit result event for success', () => {
    const onStream = vi.fn();

    emitResult(onStream, true, 'Completed', 'session-1', []);

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

    emitResult(onStream, false, 'Network error', 'session-1', []);

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

  it('should redact raw tool-input values from later text and result events', () => {
    const onStream: StreamCallback = vi.fn();
    const state = createStreamTrackingState();
    handlePartUpdated({
      id: 'tool-part',
      sessionID: 'session-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'remote',
      state: { status: 'running', input: { token: 'opencode-sensitive-value' } },
    }, undefined, onStream, state);

    handlePartUpdated({
      id: 'text-part',
      sessionID: 'session-1',
      type: 'text',
      text: 'opencode-sensitive-value',
    }, 'opencode-sensitive-value', onStream, state);
    emitResult(onStream, true, 'opencode-sensitive-value', 'session-1', state.sensitiveSources);

    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'text',
      data: { text: '[REDACTED]' },
    });
    expect(onStream).toHaveBeenNthCalledWith(3, {
      type: 'result',
      data: {
        result: '[REDACTED]',
        sessionId: 'session-1',
        success: true,
        error: undefined,
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

  it('should redact a known secret split at every text delta boundary', () => {
    const secret = 'split-opencode-secret';
    for (let split = 1; split < secret.length; split += 1) {
      const onStream = vi.fn();
      const state = createStreamTrackingState();
      state.sensitiveSources.add({ token: secret });
      const part: OpenCodeTextPart = { id: `p-${split}`, type: 'text', text: secret };

      handlePartUpdated(part, secret.slice(0, split), onStream, state);
      handlePartUpdated(part, secret.slice(split), onStream, state);

      const streamedText = onStream.mock.calls
        .map(([event]) => (event as { data: { text?: string } }).data.text ?? '')
        .join('');
      expect(streamedText).not.toContain(secret);
      expect(streamedText).toContain('[REDACTED]');
    }
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
      data: { id: 'call-1', content: 'file.txt', isError: false },
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
      data: { id: 'call-1', content: 'Permission denied', isError: true },
    });
  });

  it.each(['completed', 'error'] as const)(
    'should redact input added by a later %s tool update without duplicating tool_use',
    (status) => {
      const logsDir = mkdtempSync(join(tmpdir(), `takt-opencode-late-${status}-`));
      try {
        const logger = createProviderEventLogger({
          logsDir,
          sessionId: `session-${status}`,
          runId: `run-${status}`,
          enabled: true,
        });
        const state = createStreamTrackingState();
        const callback = buildProviderEventCallback(logger);
        handlePartUpdated({
          id: 'tool-part',
          sessionID: 'session-1',
          type: 'tool',
          callID: 'call-late',
          tool: 'remote',
          state: { status: 'running', input: {} },
        }, undefined, callback, state);
        const secret = `late-${status}-secret`;
        const terminalState = status === 'completed'
          ? { status, input: { token: secret }, output: `echo ${secret}`, title: 'done' } as const
          : { status, input: { token: secret }, error: `echo ${secret}` } as const;
        handlePartUpdated({
          id: 'tool-part',
          sessionID: 'session-1',
          type: 'tool',
          callID: 'call-late',
          tool: 'remote',
          state: terminalState,
        }, undefined, callback, state);
        const jsonl = readFileSync(logger.filepath, 'utf-8');
        expect(jsonl).not.toContain(secret);
        expect(jsonl).toContain('[REDACTED]');
        expect(jsonl.match(/"event_type":"tool_use"/g)).toHaveLength(1);
        expect(state.latestToolInputs.get('call-late')).toEqual({ token: secret });
      } finally {
        rmSync(logsDir, { recursive: true, force: true });
      }
    },
  );

  it('tool_use と tool_result から HTTP/session 機密値を除去する', () => {
    const onStream: StreamCallback = vi.fn();
    const state = createStreamTrackingState();
    const secrets = {
      proxyAuthorization: 'Basic proxy-secret-value',
      cookies: 'sid=cookie-secret-value',
      sessionId: 'provider-session-secret',
    };
    const part: OpenCodeToolPart = {
      id: 'sensitive-tool',
      type: 'tool',
      callID: 'sensitive-call',
      tool: 'fetch',
      state: {
        status: 'error',
        input: {
          'Proxy-Authorization': secrets.proxyAuthorization,
          cookies: secrets.cookies,
          sessionId: secrets.sessionId,
        },
        error: `request failed for ${secrets.proxyAuthorization}; ${secrets.cookies}; ${secrets.sessionId}`,
      },
    };

    handlePartUpdated(part, undefined, onStream, state);

    const serializedEvents = JSON.stringify(onStream.mock.calls);
    expect(serializedEvents).toContain('[REDACTED]');
    expect(serializedEvents).not.toContain(secrets.proxyAuthorization);
    expect(serializedEvents).not.toContain(secrets.cookies);
    expect(serializedEvents).not.toContain(secrets.sessionId);
  });

  it('redacts secrets from every prior tool input in an individual tool result event', () => {
    const onStream: StreamCallback = vi.fn();
    const state = createStreamTrackingState();
    const firstSecret = 'first-opencode-secret';
    const secondSecret = 'second-opencode-secret';

    handlePartUpdated({
      id: 'part-1',
      sessionID: 'session-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'Bash',
      state: { status: 'running', input: { token: firstSecret } },
    }, undefined, onStream, state);
    handlePartUpdated({
      id: 'part-2',
      sessionID: 'session-1',
      type: 'tool',
      callID: 'call-2',
      tool: 'Bash',
      state: {
        status: 'completed',
        input: { token: secondSecret },
        output: `echoed ${firstSecret} and ${secondSecret}`,
        title: 'Echo secrets',
      },
    }, undefined, onStream, state);

    const resultEvent = onStream.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'tool_result');
    expect(resultEvent).toEqual({
      type: 'tool_result',
      data: { id: 'call-2', content: 'echoed [REDACTED] and [REDACTED]', isError: false },
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

  it('fails closed and releases per-id state when the stream id limit is exceeded', () => {
    const state = createStreamTrackingState();
    for (let index = 0; index < OPENCODE_STREAM_ID_LIMIT; index += 1) {
      expect(handlePartUpdated(
        { id: `part-${index}`, type: 'text', text: 'x' },
        'x',
        undefined,
        state,
      )).toBe(true);
    }

    expect(handlePartUpdated(
      { id: 'part-over-limit', type: 'text', text: 'secret' },
      'secret',
      undefined,
      state,
    )).toBe(false);
    expect(state.exhausted).toBe(true);
    expect(state.trackedIds.size).toBe(0);
    expect(state.textOffsets.size).toBe(0);
    expect(state.textRedactors.size).toBe(0);
    expect(sanitizeSensitiveTextWithKnownValues('must-not-leak', state.sensitiveSources)).toBe('[REDACTED]');
  });

  it('fails closed and releases sensitive history when tool input accumulation is exhausted', () => {
    const state = createStreamTrackingState();
    let accepted = true;
    for (let index = 0; accepted; index += 1) {
      accepted = handlePartUpdated({
        id: 'tool-part',
        type: 'tool',
        callID: 'call-1',
        tool: 'remote',
        state: { status: 'running', input: { token: `secret-${index}` } },
      }, undefined, undefined, state);
    }

    expect(state.exhausted).toBe(true);
    expect(state.latestToolInputs.size).toBe(0);
    expect(state.sensitiveSources.values.size).toBe(0);
    expect(sanitizeSensitiveTextWithKnownValues('unknown-secret', state.sensitiveSources)).toBe('[REDACTED]');
  });
});

describe('trackOpenCodeStreamEvent', () => {
  it('rejects an event flood before it can keep resetting the idle timeout', () => {
    const state = createStreamTrackingState();
    const event: OpenCodeStreamEvent = {
      type: 'session.idle',
      properties: { sessionID: 'session-1' },
    };
    for (let index = 0; index < OPENCODE_STREAM_EVENT_LIMIT; index += 1) {
      expect(trackOpenCodeStreamEvent(state, event)).toBe(true);
    }

    expect(trackOpenCodeStreamEvent(state, event)).toBe(false);
    expect(state.exhausted).toBe(true);
  });
});

describe('trackOpenCodeTextBytes', () => {
  it('fails closed and releases all tracked state when cumulative text bytes exceed the limit', () => {
    const state = createStreamTrackingState();
    state.textOffsets.set('text-1', 1);
    state.textRedactors.set('text-1', {} as never);
    state.sensitiveSources.add({ token: 'secret-before-text-limit' });

    expect(trackOpenCodeTextBytes(state, 'a'.repeat(OPENCODE_STREAM_TEXT_BYTE_LIMIT))).toBe(true);
    expect(trackOpenCodeTextBytes(state, 'b')).toBe(false);

    expect(state.exhausted).toBe(true);
    expect(state.textOffsets.size).toBe(0);
    expect(state.textRedactors.size).toBe(0);
    expect(state.sensitiveSources.values.size).toBe(0);
    expect(sanitizeSensitiveTextWithKnownValues('unknown-after-text-limit', state.sensitiveSources)).toBe('[REDACTED]');
  });

  it('counts UTF-8 bytes across multiple text part ids', () => {
    const state = createStreamTrackingState();
    const first = 'あ'.repeat(Math.floor(OPENCODE_STREAM_TEXT_BYTE_LIMIT / 6));
    const second = 'い'.repeat(Math.floor(OPENCODE_STREAM_TEXT_BYTE_LIMIT / 6) + 1);

    expect(trackOpenCodeTextBytes(state, first)).toBe(true);
    expect(trackOpenCodeTextBytes(state, second)).toBe(true);
    expect(trackOpenCodeTextBytes(state, 'う')).toBe(false);
    expect(state.exhausted).toBe(true);
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
