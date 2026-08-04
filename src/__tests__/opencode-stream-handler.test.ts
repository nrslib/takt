/**
 * Tests for OpenCode stream event handling
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
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
import {
  maskOpenCodeToolContentInText,
  sanitizeOpenCodeToolInput,
} from '../infra/opencode/tool-input-sanitizer.js';
import { startTimerPump } from './helpers/opencode-client-test-helpers.js';

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

  it('should keep text and reasoning offsets independent across delta and snapshot updates', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();

    handlePartUpdated(
      { id: 'text-1', type: 'text', text: 'Hello world' },
      'Hello',
      onStream,
      state,
    );
    handlePartUpdated(
      { id: 'reasoning-1', type: 'reasoning', text: 'Thinking...' },
      'Think',
      onStream,
      state,
    );
    handlePartUpdated(
      { id: 'text-1', type: 'text', text: 'Hello world' },
      undefined,
      onStream,
      state,
    );
    handlePartUpdated(
      { id: 'reasoning-1', type: 'reasoning', text: 'Thinking...' },
      undefined,
      onStream,
      state,
    );

    expect(onStream.mock.calls.map(([event]) => event)).toEqual([
      { type: 'text', data: { text: 'Hello' } },
      { type: 'thinking', data: { thinking: 'Think' } },
      { type: 'text', data: { text: ' world' } },
      { type: 'thinking', data: { thinking: 'ing...' } },
    ]);
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

  it('should not apply the text byte limit to reasoning parts', () => {
    const onStream = vi.fn();
    const state = createStreamTrackingState();
    const repeatCount = Math.floor(OPENCODE_STREAM_TEXT_BYTE_LIMIT / 'Reasoning '.length) + 1;
    const reasoning = 'Reasoning '.repeat(repeatCount);
    const part: OpenCodeReasoningPart = {
      id: 'r1',
      sessionID: 'session-1',
      type: 'reasoning',
      text: reasoning,
    };

    handlePartUpdated(part, reasoning, onStream, state);

    expect(onStream).toHaveBeenCalledWith({
      type: 'thinking',
      data: { thinking: reasoning },
    });
    expect(state.textBytes).toBe(0);
    expect(state.exhausted).toBe(false);
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

  it('does not count message.part.delta toward the structural event limit', () => {
    const state = createStreamTrackingState();
    const deltaEvent: OpenCodeStreamEvent = {
      type: 'message.part.delta',
      properties: { sessionID: 'session-1', partID: 'part-1', field: 'text', delta: 'x' },
    };
    for (let index = 0; index < OPENCODE_STREAM_EVENT_LIMIT + 100; index += 1) {
      expect(trackOpenCodeStreamEvent(state, deltaEvent)).toBe(true);
    }
    expect(state.exhausted).toBe(false);
    expect(state.eventCount).toBe(0);
  });

  it('does not count message.part.updated toward the structural event limit', () => {
    const state = createStreamTrackingState();
    const partUpdatedEvent: OpenCodeStreamEvent = {
      type: 'message.part.updated',
      properties: {
        part: { id: 'part-1', sessionID: 'session-1', type: 'text', text: 'x' },
      },
    };
    for (let index = 0; index < OPENCODE_STREAM_EVENT_LIMIT + 100; index += 1) {
      expect(trackOpenCodeStreamEvent(state, partUpdatedEvent)).toBe(true);
    }
    expect(state.exhausted).toBe(false);
    expect(state.eventCount).toBe(0);
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


// ---------------------------------------------------------------------------
// OpenCode tool body sanitization（旧 opencode-tool-input-sanitizer.test.ts）
// ---------------------------------------------------------------------------

describe('OpenCode tool body sanitization', () => {
  it.each([
    ['edit', 'oldString', 'source body'],
    ['edit', 'newString', 'replacement body'],
    ['write', 'content', 'complete file body'],
    ['apply_patch', 'patchText', '*** Begin Patch\nsecret body\n*** End Patch'],
  ])('should apply the shared descriptor contract to %s.%s in inputs and quoted output', (
    tool,
    key,
    body,
  ) => {
    const input = { filePath: 'src/example.ts', [key]: body };
    const sanitizedInput = sanitizeOpenCodeToolInput(input, tool);
    const sanitizedText = maskOpenCodeToolContentInText(`Tool failed:\n${body}`, tool, input);

    expect(sanitizedInput.filePath).toBe('src/example.ts');
    expect(sanitizedInput[key]).toMatchObject({ length: body.length });
    expect((sanitizedInput[key] as { sha256: string }).sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(sanitizedInput)).not.toContain(body);
    expect(sanitizedText).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
    expect(sanitizedText).not.toContain(body);
  });

  it.each([
    ['write', { content: 'write body' }],
    ['apply_patch', { patchText: 'patch body' }],
  ])('should keep %s bodies out of emitted tool_result provider events', (tool, input) => {
    const onStream = vi.fn();
    const body = Object.values(input)[0]!;

    emitToolResult(
      onStream,
      `Tool failed while processing ${body}`,
      true,
      [input],
      'tool-1',
      tool,
      input,
    );

    const serialized = JSON.stringify(onStream.mock.calls);
    expect(serialized).not.toContain(body);
    expect(serialized).toMatch(/sha256/);
  });

  it('should not rewrite an unknown key for an unrelated tool', () => {
    expect(sanitizeOpenCodeToolInput({ content: 'ordinary argument' }, 'custom')).toEqual({
      content: 'ordinary argument',
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCodeClient 経由のツール失敗ログ・イベントのマスク配線
// （旧 opencode-client-tool-error-log-sanitize.test.ts。sanitizer 単体の
// 有界走査・循環参照の性質は sensitiveText.test.ts が単体で固定している）
// ---------------------------------------------------------------------------

type MockStreamEvent = Record<string, unknown>;

function createEvents(events: MockStreamEvent[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

const { createOpencodeMock, debugLogSpy, infoLogSpy } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
  debugLogSpy: vi.fn(),
  infoLogSpy: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      unref: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        cb();
      }),
      address: vi.fn(() => ({ port: 62100 })),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

// createLogger 以外の実エクスポートはそのまま使う。debug だけをスパイに
// 差し替え、client.ts のモジュール読み込み時に一度だけ生成される
// `log`（createLogger('opencode-sdk')）が常にこのスパイを参照するようにする。
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    trace: vi.fn(),
    debug: debugLogSpy,
    info: infoLogSpy,
    warn: vi.fn(),
    error: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  }),
}));

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

function installOpenCodeMock(events: MockStreamEvent[] | MockStreamEvent[][]) {
  const runs = Array.isArray(events[0]) ? events as MockStreamEvent[][] : [events as MockStreamEvent[]];
  let runIndex = 0;
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn().mockImplementation(() => {
    const run = runs[runIndex];
    runIndex += 1;
    if (run === undefined) {
      throw new Error(`Missing stream events for attempt ${runIndex}`);
    }
    return Promise.resolve({ stream: createEvents(run) });
  });

  createOpencodeMock.mockResolvedValue({
    client: {
      instance: { dispose: vi.fn() },
      session: {
        create: sessionCreate,
        promptAsync,
        abort: vi.fn().mockResolvedValue({ data: true }),
      },
      event: { subscribe },
      permission: { reply: vi.fn().mockResolvedValue({ data: {} }) },
    },
    server: { close: vi.fn() },
  });

  return { sessionCreate, promptAsync, subscribe };
}

function providerErrorEvent(type: string, error: unknown): MockStreamEvent {
  if (type === 'session.error') {
    return { type, properties: { sessionID: 'session-1', error } };
  }
  return {
    type,
    properties: {
      info: { sessionID: 'session-1', role: 'assistant', error },
    },
  };
}

function sensitiveToolEvent(secret: string): MockStreamEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'sensitive-source',
        sessionID: 'session-1',
        type: 'tool',
        callID: 'call-sensitive-source',
        tool: 'remote',
        state: { status: 'running', input: { token: secret } },
      },
    },
  };
}

describe('OpenCodeClient tool call failure logging', () => {
  // transient retry の backoff（実時間 250-500ms）を fake timers のポンプで
  // 実時間ゼロに圧縮する。アサーションは同一。
  let pump: { stop: () => Promise<void> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetSharedServer();
    pump = startTimerPump(20);
  });

  afterEach(async () => {
    await pump.stop();
  });

  it.each([
    'message.updated',
    'message.completed',
    'message.failed',
    'session.error',
  ])('%s の外部エラーをdebugログ・provider JSONL・AgentResponseでマスクする', async (eventType) => {
    const knownSecret = `known-${eventType}-secret`;
    const apiKeySecret = `opaque-api-key-${eventType}`;
    const childEnvSecret = `opaque-child-env-${eventType}`;
    const authorizationSecret = `authorization-${eventType}-secret`;
    const rawError = [
      `provider rejected ${knownSecret}`,
      apiKeySecret,
      childEnvSecret,
      `Authorization: Bearer ${authorizationSecret}`,
    ].join('; ');
    installOpenCodeMock([
      sensitiveToolEvent(knownSecret),
      providerErrorEvent(eventType, { name: 'ProviderError', data: { message: rawError } }),
    ]);
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-opencode-provider-error-'));

    try {
      const providerLogger = createProviderEventLogger({
        logsDir,
        sessionId: `provider-error-${eventType}`,
        runId: 'provider-error-run',
        enabled: true,
      });
      const observed = vi.fn();
      const client = new OpenCodeClient();
      const result = await client.call('coder', 'prompt', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        onStream: (event) => {
          providerLogger.logEvent({
            provider: 'opencode',
            providerModel: 'big-pickle',
            step: 'review',
          }, event);
          observed(event);
        },
        opencodeApiKey: apiKeySecret,
        childProcessEnv: { OPENCODE_ACCESS_TOKEN: childEnvSecret },
      });
      const evidence = JSON.stringify({
        result,
        debugCalls: debugLogSpy.mock.calls,
        infoCalls: infoLogSpy.mock.calls,
        streamCalls: observed.mock.calls,
        jsonl: readFileSync(providerLogger.filepath, 'utf8'),
      });
      expect(result.status).toBe('error');
      expect(evidence).not.toContain(knownSecret);
      expect(evidence).not.toContain(apiKeySecret);
      expect(evidence).not.toContain(childEnvSecret);
      expect(evidence).not.toContain(authorizationSecret);
      expect(evidence).toContain('[REDACTED]');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it.each([
    'message.updated',
    'message.completed',
    'message.failed',
    'session.error',
  ])('onStream なしでも %s の外部エラーから tool input をマスクする', async (eventType) => {
    const toolSecret = `silent-tool-${eventType}-secret`;
    installOpenCodeMock([
      sensitiveToolEvent(toolSecret),
      providerErrorEvent(eventType, {
        name: 'ProviderError',
        data: { message: `provider quoted ${toolSecret}` },
      }),
    ]);
    const client = new OpenCodeClient();

    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const evidence = JSON.stringify({ result, debugCalls: debugLogSpy.mock.calls });
    expect(result.status).toBe('error');
    expect(evidence).not.toContain(toolSecret);
    expect(evidence).toContain('[REDACTED]');
  });

  it('transient SSEエラーとprompt例外のretryログ・結果イベントをマスクする', async () => {
    const sseSecret = 'retry-sse-provider-secret';
    const exceptionSecret = 'retry-exception-provider-secret';
    const childEnvSecret = 'retry-child-env-provider-secret';
    const { promptAsync } = installOpenCodeMock([
      [
        sensitiveToolEvent(sseSecret),
        providerErrorEvent('session.error', {
          name: 'RequestError',
          data: { message: `fetch failed; token=${sseSecret}` },
        }),
      ],
      [],
      [{ type: 'session.idle', properties: { sessionID: 'session-1' } }],
    ]);
    promptAsync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error(`fetch failed; ${exceptionSecret}; ${childEnvSecret}`))
      .mockResolvedValueOnce(undefined);
    const observed = vi.fn();
    const client = new OpenCodeClient();

    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream: observed,
      opencodeApiKey: exceptionSecret,
      childProcessEnv: { OPENCODE_ACCESS_TOKEN: childEnvSecret },
    });

    const evidence = JSON.stringify({
      result,
      debugCalls: debugLogSpy.mock.calls,
      infoCalls: infoLogSpy.mock.calls,
      streamCalls: observed.mock.calls,
    });
    expect(result.status).toBe('done');
    expect(evidence).not.toContain(sseSecret);
    expect(evidence).not.toContain(exceptionSecret);
    expect(evidence).not.toContain(childEnvSecret);
    expect(evidence).toContain('[REDACTED]');
  });

  it('unknown message.part.delta part types do not leak secrets while staying out of text processing', async () => {
    const secret = 'unknown-delta-secret';
    const partId = 'mystery-part';
    installOpenCodeMock([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: partId,
            sessionID: 'session-1',
            type: 'mystery',
          },
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          partID: partId,
          field: 'text',
          delta: secret,
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ]);
    const client = new OpenCodeClient();
    const observed = vi.fn();

    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream: observed,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('');

    const visibleEvents = observed.mock.calls
      .map(([event]) => event as { type: string; data?: { text?: string; thinking?: string } })
      .filter((event) => event.type === 'text' || event.type === 'thinking');
    expect(visibleEvents).toEqual([]);
    for (const event of visibleEvents) {
      const value = event.type === 'text' ? event.data?.text : event.data?.thinking;
      expect(value).not.toContain(secret);
      expect(value).not.toContain(partId);
    }

    const evidence = JSON.stringify({
      result,
      debugCalls: debugLogSpy.mock.calls,
    });
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain(partId);
  });

  it('onStream なしのtool inputを同一attemptのprompt例外とretry結果からマスクする', async () => {
    const toolSecret = 'silent-tool-prompt-exception-secret';
    const { promptAsync } = installOpenCodeMock([
      [sensitiveToolEvent(toolSecret), { type: 'session.idle', properties: { sessionID: 'session-1' } }],
      [{ type: 'session.idle', properties: { sessionID: 'session-1' } }],
    ]);
    promptAsync
      .mockRejectedValueOnce(new Error(`fetch failed; provider quoted ${toolSecret}`))
      .mockResolvedValueOnce(undefined);
    const client = new OpenCodeClient();

    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const evidence = JSON.stringify({ result, debugCalls: debugLogSpy.mock.calls });
    expect(result.status).toBe('done');
    expect(evidence).not.toContain(toolSecret);
  });

  it('bash command に API キーらしき文字列を含む失敗ツール呼び出しがあっても、debug ログにその文字列がそのまま出ない', async () => {
    const secret = 'sk-liveTestSecretDoNotLeak1234567890';
    const proxySecret = 'Basic proxyOpaqueCredential';
    const cookieSecret = 'sid=opaqueCookieValue';
    const sessionSecret = 'opaque-provider-session';
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'Bash',
            state: {
              status: 'error',
              input: {
                command: `curl -H "Authorization: Bearer ${secret}" https://example.com/api`,
                'Proxy-Authorization': proxySecret,
                cookies: cookieSecret,
                sessionId: sessionSecret,
              },
              error: `Command failed: ${secret}; ${proxySecret}; ${cookieSecret}; ${sessionSecret}`,
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const failureCall = debugLogSpy.mock.calls.find(([message]) => message === 'OpenCode tool call failed');
    expect(failureCall).toBeDefined();

    // ログ呼び出し全体（メッセージ + 付随データ）のどこにも生の秘密文字列が
    // 残っていないことを確認する。マスクが input/error の一部だけに効いて
    // 他の経路で漏れるケースも拾えるよう、呼び出し引数全体を対象にする。
    const serializedCall = JSON.stringify(failureCall);
    expect(serializedCall).not.toContain(secret);
    expect(serializedCall).not.toContain(proxySecret);
    expect(serializedCall).not.toContain(cookieSecret);
    expect(serializedCall).not.toContain(sessionSecret);

    // マスクされてもキー名（command）とツール名は残り、後から
    // 「何のツールの何の引数が壊れたか」を特定できる。
    const [, data] = failureCall as [string, { tool: string; input: { command: string }; error: string }];
    expect(data.tool).toBe('Bash');
    expect(data.input).toHaveProperty('command');
    expect(data.input.command).toContain('[REDACTED]');
    expect(data.error).toContain('[REDACTED]');
  });

  it('permission rejection の patterns / always を debug ログへ渡す前にマスクする', async () => {
    const patternSecret = 'permission-pattern-secret';
    const alwaysSecret = 'permission-always-secret';
    installOpenCodeMock([
      {
        type: 'permission.asked',
        properties: {
          id: 'permission-1',
          sessionID: 'session-1',
          permission: 'bash',
          patterns: [`Authorization: Bearer ${patternSecret}`],
          always: [`session_id: ${alwaysSecret}`],
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ]);
    const client = new OpenCodeClient();

    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'readonly',
    });

    const rejectionCall = infoLogSpy.mock.calls.find(([message]) => (
      typeof message === 'string' && message.includes('permission rejected')
    ));
    expect(rejectionCall).toBeDefined();
    const serializedCall = JSON.stringify(rejectionCall);
    expect(serializedCall).not.toContain(patternSecret);
    expect(serializedCall).not.toContain(alwaysSecret);
    expect(serializedCall).toContain('[REDACTED]');
  });

  it('edit の oldString / newString はソース本文を残さず {sha256, length} にマスクされ、filePath は従来どおり残る（codex ブロッカー3）', async () => {
    const sourceBody = 'const secretLookingSourceLine = computeThing(privateValue);';
    const replacementBody = 'const replacedSourceLine = computeThing(publicValue);';
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-edit',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-edit',
            tool: 'edit',
            state: {
              status: 'error',
              input: {
                filePath: 'src/features/pipeline/execute.ts',
                oldString: sourceBody,
                newString: replacementBody,
              },
              error: 'oldString not found in content',
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const failureCall = debugLogSpy.mock.calls.find(([message]) => message === 'OpenCode tool call failed');
    expect(failureCall).toBeDefined();

    // ログ呼び出し全体のどこにも oldString / newString の本文が残らない。
    const serializedCall = JSON.stringify(failureCall);
    expect(serializedCall).not.toContain(sourceBody);
    expect(serializedCall).not.toContain(replacementBody);

    // 本文は {sha256 先頭12桁, length} に置き換わり、filePath 等の他の引数は
    // 残る（ツール失敗デバッグ機能の本体は維持）。
    const [, data] = failureCall as [string, {
      tool: string;
      input: { filePath: string; oldString: { sha256: string; length: number }; newString: { sha256: string; length: number } };
    }];
    expect(data.input.filePath).toBe('src/features/pipeline/execute.ts');
    expect(data.input.oldString.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(data.input.oldString.length).toBe(sourceBody.length);
    expect(data.input.newString.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(data.input.newString.length).toBe(replacementBody.length);
  });

  it('エラー文そのものに oldString 本文が引用されていても debug ログに本文が残らない（codex 2巡目ブロッカー）', async () => {
    const sourceBody = 'const leakedThroughErrorText = computeThing(privateValue); // opencode quotes this in the error';
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-edit-err',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-edit-err',
            tool: 'edit',
            state: {
              status: 'error',
              input: {
                filePath: 'src/features/pipeline/steps.ts',
                oldString: sourceBody,
                newString: 'replacement text',
              },
              // OpenCode の edit エラー文は oldString の内容を引用することがある。
              error: `Could not find the following text in src/features/pipeline/steps.ts:\n${sourceBody}`,
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const failureCall = debugLogSpy.mock.calls.find(([message]) => message === 'OpenCode tool call failed');
    expect(failureCall).toBeDefined();

    // ログ呼び出し全体のどこにも本文が残らない（input 側は {sha256,length}、
    // error 側はプレースホルダ置換）。
    const serializedCall = JSON.stringify(failureCall);
    expect(serializedCall).not.toContain(sourceBody);

    const [, data] = failureCall as [string, { error: string; input: { filePath: string } }];
    expect(data.error).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
    // エラー文の骨格（どのファイルで何が起きたか）は読める形で残る。
    expect(data.error).toContain('Could not find the following text');
    expect(data.input.filePath).toBe('src/features/pipeline/steps.ts');
  });

  it.each(['a', 'ab', 'abc', 'abcd', 'abcde'])(
    '短い edit 本文 %s もエラー文とログ入力へ露出しない',
    async (sourceBody) => {
      installOpenCodeMock([{
        type: 'message.part.updated',
        properties: {
          part: {
            id: `part-short-${sourceBody.length}`,
            sessionID: 'session-1',
            type: 'tool',
            callID: `call-short-${sourceBody.length}`,
            tool: 'edit',
            state: {
              status: 'error',
              input: { filePath: 'src/short.ts', oldString: sourceBody, newString: 'replacement' },
              error: `Could not find text: ${sourceBody}`,
            },
          },
        },
      }, { type: 'session.idle', properties: { sessionID: 'session-1' } }]);
      const client = new OpenCodeClient();

      await client.call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });

      const failureCall = debugLogSpy.mock.calls.find(([message]) => message === 'OpenCode tool call failed');
      expect(failureCall).toBeDefined();
      const [, data] = failureCall as [string, { error: string; input: { oldString: unknown } }];
      expect(data.input.oldString).not.toBe(sourceBody);
      expect(data.error).toContain(`length:${sourceBody.length}`);
    },
  );

  it('onStream の全イベント（tool_use / tool_result）に oldString/newString 本文が一切現れない — provider event logging で永続化される経路（codex 3〜4巡目ブロッカー）', async () => {
    const sourceBody = 'const leakedViaOnStream = computeThing(privateValue); // opencode quotes this in the error';
    const replacementBody = 'const replacedViaOnStream = computeThing(publicValue);';
    // 最初のイベントがいきなり status: 'error' のケース: 未開始ツールの
    // tool_use 発火（state.input）が、マスク済み tool_result より先に走る。
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-edit-stream',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-edit-stream',
            tool: 'edit',
            state: {
              status: 'error',
              input: {
                filePath: 'src/core/workflow/engine/StepExecutor.ts',
                oldString: sourceBody,
                newString: replacementBody,
              },
              error: `Could not find the following text in src/core/workflow/engine/StepExecutor.ts:\n${sourceBody}`,
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    const streamEvents: unknown[] = [];
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream: (event) => {
        streamEvents.push(event);
      },
    });

    // onStream はライブ表示専用ではない: provider event logging 有効時は
    // イベント全文が *-provider-events.jsonl へ永続化される
    // （providerEventLogger.ts）。tool_use / tool_result を含む全イベントの
    // どこにも本文が残ってはならない。
    const serializedEvents = JSON.stringify(streamEvents);
    expect(serializedEvents).not.toContain(sourceBody);
    expect(serializedEvents).not.toContain(replacementBody);

    // tool_use: 本文フィールドだけ {sha256, length} に置換され、filePath は残る。
    const toolUses = streamEvents.filter((event) => (
      (event as { type?: string }).type === 'tool_use'
    )) as Array<{ data: { tool: string; input: Record<string, unknown> } }>;
    expect(toolUses.length).toBeGreaterThan(0);
    const editUse = toolUses.find((use) => use.data.tool === 'edit');
    expect(editUse).toBeDefined();
    expect(editUse!.data.input.filePath).toBe('src/core/workflow/engine/StepExecutor.ts');
    const oldStringMask = editUse!.data.input.oldString as { sha256: string; length: number };
    expect(oldStringMask.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(oldStringMask.length).toBe(sourceBody.length);
    const newStringMask = editUse!.data.input.newString as { sha256: string; length: number };
    expect(newStringMask.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(newStringMask.length).toBe(replacementBody.length);

    // tool_result: エラー文経由の本文もプレースホルダ置換済みで、骨格は読める。
    const toolResults = streamEvents.filter((event) => (
      (event as { type?: string }).type === 'tool_result'
    )) as Array<{ data: { content: string; isError: boolean } }>;
    expect(toolResults.length).toBeGreaterThan(0);
    const errorResult = toolResults.find((result) => result.data.isError);
    expect(errorResult).toBeDefined();
    expect(errorResult!.data.content).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
    expect(errorResult!.data.content).toContain('Could not find the following text');
  });

  it('password や Authorization / Cookie など機密キーの値は形式によらずマスクされ、offset や誤字キーの値はそのまま残る', async () => {
    // sanitizeSensitiveText() はテキスト全体から「キー名: 値」という並びを
    // 正規表現で見つけてマスクする実装のため、値を単独の文字列として渡すと
    // キーの文脈が失われ、"hunter2" や "Bearer opaque-value" のような非定型の
    // 値はマスクされなかった（修正前の実測挙動）。オブジェクトを再帰的に
    // 走査する際にキー名の文脈を引き継ぎ、機密キーなら値の形式・型を問わず
    // 丸ごとマスクする。
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-2',
            tool: 'Edit',
            state: {
              status: 'error',
              input: {
                password: 'hunter2',
                Authorization: 'Bearer opaque-value',
                headers: { Cookie: 'session=abc' },
                // qwen が read に offset: "290.0" という文字列を、edit に
                // filepaath という誤字キーを渡していた（実測）。この2つは
                // 機密キーではないため、後から引数の壊れ方を特定できるよう
                // マスクせずそのまま残す必要がある。
                offset: '290.0',
                filepaath: '/x',
              },
              error: 'Tool call failed',
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const failureCall = debugLogSpy.mock.calls.find(([message]) => message === 'OpenCode tool call failed');
    expect(failureCall).toBeDefined();
    const [, data] = failureCall as [string, { input: Record<string, unknown> }];

    expect(data.input.password).toBe('[REDACTED]');
    expect(data.input.Authorization).toBe('[REDACTED]');
    expect((data.input.headers as Record<string, unknown>).Cookie).toBe('[REDACTED]');

    expect(data.input.offset).toBe('290.0');
    expect(data.input.filepaath).toBe('/x');
  });

  it.each([
    'message.updated',
    'message.completed',
    'message.failed',
    'session.error',
  ])('%s の tracking-limit 風エラーでも known secret をマスクする', async (eventType) => {
    const knownSecret = `known-tracking-limit-${eventType}-secret`;
    const rawError = `OpenCode stream tracking limit exceeded: provider rejected ${knownSecret}`;
    installOpenCodeMock([
      sensitiveToolEvent(knownSecret),
      providerErrorEvent(eventType, { name: 'ProviderError', data: { message: rawError } }),
    ]);
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-opencode-provider-error-'));

    try {
      const providerLogger = createProviderEventLogger({
        logsDir,
        sessionId: `provider-error-tracking-limit-${eventType}`,
        runId: 'provider-error-tracking-limit-run',
        enabled: true,
      });
      const observed = vi.fn();
      const client = new OpenCodeClient();
      const result = await client.call('coder', 'prompt', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        onStream: (event) => {
          providerLogger.logEvent({
            provider: 'opencode',
            providerModel: 'big-pickle',
            step: 'review',
          }, event);
          observed(event);
        },
        opencodeApiKey: `opaque-api-key-${eventType}`,
        childProcessEnv: { OPENCODE_ACCESS_TOKEN: `opaque-child-env-${eventType}` },
      });
      const evidence = JSON.stringify({
        result,
        debugCalls: debugLogSpy.mock.calls,
        infoCalls: infoLogSpy.mock.calls,
        streamCalls: observed.mock.calls,
        jsonl: readFileSync(providerLogger.filepath, 'utf8'),
      });
      expect(result.status).toBe('error');
      expect(evidence).not.toContain(knownSecret);
      expect(evidence).not.toContain(`opaque-api-key-${eventType}`);
      expect(evidence).not.toContain(`opaque-child-env-${eventType}`);
      expect(evidence).toContain('[REDACTED]');
      expect(evidence).toContain('OpenCode stream tracking limit exceeded');
      for (const internalReason of [
        'event_count',
        'tracked_id_count',
        'text_bytes',
        'sensitive_sources',
      ]) {
        expect(result.error).not.toContain(internalReason);
        expect(evidence).not.toContain(internalReason);
      }
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
