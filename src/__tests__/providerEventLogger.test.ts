import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProviderEventLogger,
  isProviderEventsEnabled,
} from '../shared/utils/providerEventLogger.js';
import { PROVIDER_EVENT_STREAM_LIMIT } from '../core/logging/providerEventLogger.js';
import type { ProviderType } from '../core/workflow/index.js';
import {
  createStreamTrackingState,
  emitCodexItemCompleted,
  emitCodexItemStart,
} from '../infra/codex/CodexStreamHandler.js';
import { sdkMessageToStreamEvent } from '../infra/claude/stream-converter.js';
import { normalizeClaudeTerminalResponse } from '../infra/claude-terminal/response-normalizer.js';

const TEST_TMPDIR = realpathSync(tmpdir());

describe('providerEventLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(TEST_TMPDIR, `takt-provider-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should disable provider events by default', () => {
    expect(isProviderEventsEnabled()).toBe(false);
    expect(isProviderEventsEnabled({})).toBe(false);
    expect(isProviderEventsEnabled({ logging: {} })).toBe(false);
  });

  it('should enable provider events only when explicitly true', () => {
    expect(isProviderEventsEnabled({ logging: { providerEvents: true } })).toBe(true);
  });

  it('should disable provider events only when explicitly false', () => {
    expect(isProviderEventsEnabled({ logging: { providerEvents: false } })).toBe(false);
  });

  it('should not enable provider events from legacy observability key', () => {
    const legacyOnlyConfig = {
      observability: { providerEvents: true },
    } as unknown as Parameters<typeof isProviderEventsEnabled>[0];
    expect(isProviderEventsEnabled(legacyOnlyConfig)).toBe(false);
  });

  it('should write normalized JSONL records when enabled', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-1',
      runId: 'run-1',
      provider: 'opencode',
      step: 'implement',
      enabled: true,
    });

    const original = vi.fn();
    const wrapped = logger.wrapCallback(original);

    wrapped({
      type: 'tool_use',
      data: {
        tool: 'Read',
        input: {},
        id: 'call-123',
        messageId: 'msg-123',
        requestId: 'req-123',
        sessionID: 'session-abc',
      },
    });

    expect(original).toHaveBeenCalledTimes(1);
    expect(existsSync(logger.filepath)).toBe(true);

    const lines = readFileSync(logger.filepath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as {
      provider: ProviderType;
      event_type: string;
      run_id: string;
      step: string;
      session_id?: string;
      call_id?: string;
      message_id?: string;
      request_id?: string;
      data: Record<string, unknown>;
    };

    expect(parsed.provider).toBe('opencode');
    expect(parsed.event_type).toBe('tool_use');
    expect(parsed.run_id).toBe('run-1');
    expect(parsed.step).toBe('implement');
    expect(parsed.session_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(parsed)).not.toContain('session-abc');
    expect(parsed.call_id).toBe('call-123');
    expect(parsed.message_id).toBe('msg-123');
    expect(parsed.request_id).toBe('req-123');
    expect(parsed.data['tool']).toBe('Read');
  });

  it('should redact PEM private keys from tool results before writing provider JSONL', () => {
    const privateKey = '-----BEGIN PRIVATE KEY-----\ncHJpdmF0ZS1rZXk=\n-----END PRIVATE KEY-----';
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-1',
      runId: 'run-1',
      provider: 'opencode',
      step: 'implement',
      enabled: true,
    });

    logger.wrapCallback(vi.fn())({
      type: 'tool_result',
      data: { content: privateKey },
    });

    const jsonl = readFileSync(logger.filepath, 'utf-8');
    expect(jsonl).toContain('[REDACTED]');
    expect(jsonl).not.toContain('cHJpdmF0ZS1rZXk=');
    expect(jsonl).not.toContain('BEGIN PRIVATE KEY');
  });

  it('should flush every pending stream exactly once', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-flush',
      runId: 'run-flush',
      provider: 'opencode',
      step: 'review',
      enabled: true,
    });
    const wrapped = logger.wrapCallback();
    wrapped({ type: 'text', data: { text: 'Authoriza', messageId: 'message-a' } });
    wrapped({ type: 'thinking', data: { thinking: 'session_', messageId: 'message-b' } });

    logger.flush();
    const firstFlush = readFileSync(logger.filepath, 'utf-8');
    logger.flush();

    expect(readFileSync(logger.filepath, 'utf-8')).toBe(firstFlush);
    const records = firstFlush.trim().split('\n').map((line) => JSON.parse(line) as { event_type: string });
    expect(records.map((record) => record.event_type).sort()).toEqual(['text', 'thinking']);
  });

  it('should flush distinct text streams with their own message ids exactly once', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-multiple-text-streams',
      runId: 'run-multiple-text-streams',
      provider: 'opencode',
      step: 'review',
      enabled: true,
    });
    const callback = logger.wrapCallback();
    callback({
      type: 'tool_use',
      data: { tool: 'remote', input: { token: 'known-stream-secret' }, id: 'call-streams' },
    });
    callback({ type: 'text', data: { text: 'first tail', messageId: 'message-a' } });
    callback({ type: 'text', data: { text: 'second tail', messageId: 'message-b' } });

    logger.flush();
    logger.flush();

    const records = readFileSync(logger.filepath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as {
        event_type: string;
        message_id?: string;
        data: { text?: string };
      })
      .filter((record) => record.event_type === 'text');
    expect(records).toEqual([
      expect.objectContaining({ message_id: 'message-a', data: expect.objectContaining({ text: 'first tail' }) }),
      expect.objectContaining({ message_id: 'message-b', data: expect.objectContaining({ text: 'second tail' }) }),
    ]);
  });

  it('fails closed after the number of concurrent text streams exceeds the limit', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-stream-limit',
      runId: 'run-stream-limit',
      provider: 'opencode',
      step: 'review',
      enabled: true,
    });
    const callback = logger.wrapCallback();
    callback({
      type: 'tool_use',
      data: { tool: 'remote', input: { token: 'known-before-limit' }, id: 'call-limit' },
    });
    for (let index = 0; index <= PROVIDER_EVENT_STREAM_LIMIT; index += 1) {
      callback({ type: 'text', data: { text: 'x', messageId: `message-${index}` } });
    }
    callback({ type: 'text', data: { text: 'unknown-after-limit', messageId: 'message-after-limit' } });
    logger.flush();

    const records = readFileSync(logger.filepath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as {
        message_id?: string;
        data: { text?: string };
      });
    const afterLimit = records.filter((record) => record.message_id === 'message-after-limit');
    expect(afterLimit).toHaveLength(1);
    expect(afterLimit[0]?.data.text).toBe('[REDACTED]');
  });

  it('should flush pending streams before changing step or provider ownership', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-state-switch',
      runId: 'run-state-switch',
      provider: 'claude',
      step: 'plan',
      enabled: true,
    });
    const callback = logger.wrapCallback();
    callback({
      type: 'tool_use',
      data: { tool: 'remote', input: { token: 'state-switch-secret' }, id: 'call-state-switch' },
    });
    callback({ type: 'text', data: { text: 'before step switch', messageId: 'message-step' } });

    logger.setStep('review');
    callback({ type: 'text', data: { text: 'before provider switch', messageId: 'message-provider' } });
    logger.setProvider('codex');
    callback({ type: 'result', data: { result: 'done', sessionId: 'session-state-switch', success: true } });

    const records = readFileSync(logger.filepath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as {
        event_type: string;
        provider: ProviderType;
        step: string;
        message_id?: string;
      });
    expect(records.find((record) => record.message_id === 'message-step')).toMatchObject({
      provider: 'claude',
      step: 'plan',
    });
    expect(records.find((record) => record.message_id === 'message-provider')).toMatchObject({
      provider: 'claude',
      step: 'review',
    });
    expect(records.find((record) => record.event_type === 'result')).toMatchObject({
      provider: 'codex',
      step: 'review',
    });
  });

  it('should enforce private modes for existing provider log artifacts', () => {
    chmodSync(tempDir, 0o777);
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-mode',
      runId: 'run-mode',
      provider: 'opencode',
      step: 'review',
      enabled: true,
    });
    const originalUmask = process.umask(0);
    try {
      logger.wrapCallback()({ type: 'init', data: { model: 'probe', sessionId: 'session-mode' } });
      chmodSync(logger.filepath, 0o666);
      logger.wrapCallback()({ type: 'result', data: { result: 'done', sessionId: 'session-mode', success: true } });
    } finally {
      process.umask(originalUmask);
    }

    expect(statSync(tempDir).mode & 0o777).toBe(0o700);
    expect(statSync(logger.filepath).mode & 0o777).toBe(0o600);
  });

  it('should redact permission arrays before writing provider JSONL', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-permission-secret',
      runId: 'run-permission-secret',
      provider: 'opencode',
      step: 'review',
      enabled: true,
    });

    logger.wrapCallback()({
      type: 'permission_asked',
      data: {
        requestId: 'permission-secret',
        sessionId: 'session-permission-secret',
        permission: 'bash',
        patterns: ['Authorization: Bearer provider-permission-secret'],
        always: ['session_id: provider-session-secret'],
        reply: 'reject',
      },
    });

    const jsonl = readFileSync(logger.filepath, 'utf-8');
    expect(jsonl).not.toContain('provider-permission-secret');
    expect(jsonl).not.toContain('provider-session-secret');
    expect(jsonl).toContain('[REDACTED]');
  });

  it('should keep provider-events filename suffix for backward compatibility', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-compat',
      runId: 'run-compat',
      provider: 'claude',
      step: 'plan',
      enabled: true,
    });

    expect(logger.filepath.endsWith('-provider-events.jsonl')).toBe(true);
    expect(logger.filepath.endsWith('-usage-events.jsonl')).toBe(false);
  });

  it('should normalize permission_asked events for provider logs', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-permission',
      runId: 'run-permission',
      provider: 'opencode',
      step: 'reviewers',
      enabled: true,
    });

    const wrapped = logger.wrapCallback();

    wrapped({
      type: 'permission_asked',
      data: {
        requestId: 'perm-1',
        sessionId: 'opencode-session-1',
        permission: 'bash',
        patterns: ['**'],
        always: [],
        reply: 'reject',
      },
    });

    const lines = readFileSync(logger.filepath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as {
      event_type: string;
      session_id?: string;
      request_id?: string;
      data: Record<string, unknown>;
    };

    expect(parsed.event_type).toBe('permission_asked');
    expect(parsed.session_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.data['sessionId']).toBe('[REDACTED]');
    expect(JSON.stringify(parsed)).not.toContain('opencode-session-1');
    expect(parsed.request_id).toBe('perm-1');
    expect(parsed.data['permission']).toBe('bash');
    expect(parsed.data['patterns']).toEqual(['**']);
    expect(parsed.data['reply']).toBe('reject');
  });

  it('should update step and provider for subsequent events', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-2',
      runId: 'run-2',
      provider: 'claude',
      step: 'plan',
      enabled: true,
    });

    const wrapped = logger.wrapCallback();

    wrapped({ type: 'init', data: { model: 'sonnet', sessionId: 's-1' } });
    logger.setStep('implement');
    logger.setProvider('codex');
    wrapped({ type: 'result', data: { result: 'ok', sessionId: 's-1', success: true } });

    const lines = readFileSync(logger.filepath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as { provider: ProviderType; step: string };
    const second = JSON.parse(lines[1]!) as { provider: ProviderType; step: string };

    expect(first.provider).toBe('claude');
    expect(first.step).toBe('plan');
    expect(second.provider).toBe('codex');
    expect(second.step).toBe('implement');
  });

  it('should not write records when disabled', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-3',
      runId: 'run-3',
      provider: 'claude',
      step: 'plan',
      enabled: false,
    });

    const original = vi.fn();
    const wrapped = logger.wrapCallback(original);
    wrapped({ type: 'text', data: { text: 'hello' } });

    expect(original).toHaveBeenCalledTimes(1);
    expect(existsSync(logger.filepath)).toBe(false);
  });

  it('should truncate long text fields', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-4',
      runId: 'run-4',
      provider: 'claude',
      step: 'plan',
      enabled: true,
    });

    const wrapped = logger.wrapCallback();
    const longText = 'a'.repeat(11_000);
    wrapped({ type: 'text', data: { text: longText } });

    const line = readFileSync(logger.filepath, 'utf-8').trim();
    const parsed = JSON.parse(line) as { data: { text: string } };

    expect(parsed.data.text.length).toBeLessThan(longText.length);
    expect(parsed.data.text).toContain('...[truncated]');
  });

  it('should correlate reverse Codex MCP completions by call id and redact each result', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'codex-log',
      runId: 'run-codex',
      provider: 'codex',
      step: 'review',
      enabled: true,
    });
    const state = createStreamTrackingState();
    const firstInput = { Authorization: 'Bearer first-codex-secret' };
    const secondInput = { Authorization: 'Bearer second-codex-secret' };

    emitCodexItemStart(
      { id: 'codex-tool-1', type: 'mcp_tool_call', tool: 'remote', arguments: firstInput },
      logger.wrapCallback(),
      state,
    );
    emitCodexItemStart(
      { id: 'codex-tool-2', type: 'mcp_tool_call', tool: 'remote', arguments: secondInput },
      logger.wrapCallback(),
      state,
    );
    emitCodexItemCompleted(
      {
        id: 'codex-tool-2',
        type: 'mcp_tool_call',
        status: 'completed',
        result: { content: 'echoed first-codex-secret and second-codex-secret' },
      },
      logger.wrapCallback(),
      state,
    );
    emitCodexItemCompleted(
      {
        id: 'codex-tool-1',
        type: 'mcp_tool_call',
        status: 'completed',
        result: { content: 'echoed first-codex-secret' },
      },
      logger.wrapCallback(),
      state,
    );

    const resultRecords = readFileSync(logger.filepath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as { event_type: string; call_id?: string; data: unknown })
      .filter((record) => record.event_type === 'tool_result');
    expect(resultRecords.map((record) => record.call_id)).toEqual(['codex-tool-2', 'codex-tool-1']);
    for (const record of resultRecords) {
      const serialized = JSON.stringify(record.data);
      expect(serialized).not.toContain('first-codex-secret');
      expect(serialized).not.toContain('second-codex-secret');
      expect(serialized).toContain('[REDACTED]');
    }
  });

  it('should correlate reverse Claude SDK completions by tool-use id and redact each result', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'claude-log',
      runId: 'run-claude',
      provider: 'claude-sdk',
      step: 'review',
      enabled: true,
    });
    const callback = logger.wrapCallback();

    sdkMessageToStreamEvent({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'claude-tool-1',
          name: 'remote',
          input: { credentials: 'first-claude-secret' },
        }, {
          type: 'tool_use',
          id: 'claude-tool-2',
          name: 'remote',
          input: { credentials: 'second-claude-secret' },
        }],
      },
      uuid: 'assistant-1',
      session_id: 'claude-session',
      parent_tool_use_id: null,
    }, callback, false);
    sdkMessageToStreamEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'claude-tool-2',
          content: 'echoed second-claude-secret',
        }],
      },
      tool_use_result: {
        tool_use_id: 'claude-tool-2',
        content: 'echoed second-claude-secret',
        is_error: false,
      },
      uuid: 'user-1',
      session_id: 'claude-session',
      parent_tool_use_id: null,
    }, callback, false);
    sdkMessageToStreamEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'claude-tool-1',
          content: 'echoed first-claude-secret',
        }],
      },
      tool_use_result: {
        tool_use_id: 'claude-tool-1',
        content: 'echoed first-claude-secret',
        is_error: false,
      },
      uuid: 'user-2',
      session_id: 'claude-session',
      parent_tool_use_id: null,
    }, callback, false);

    const resultRecords = readFileSync(logger.filepath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as { event_type: string; call_id?: string; data: unknown })
      .filter((record) => record.event_type === 'tool_result');
    expect(resultRecords.map((record) => record.call_id)).toEqual(['claude-tool-2', 'claude-tool-1']);
    for (const record of resultRecords) {
      const serialized = JSON.stringify(record.data);
      expect(serialized).not.toContain('first-claude-secret');
      expect(serialized).not.toContain('second-claude-secret');
      expect(serialized).toContain('[REDACTED]');
    }
  });

  it('should redact multiple Claude terminal tool inputs from each later provider-event record', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'claude-terminal-log',
      runId: 'run-claude-terminal',
      provider: 'claude-terminal',
      step: 'review',
      enabled: true,
    });

    normalizeClaudeTerminalResponse({
      agentName: 'reviewer',
      sessionId: 'claude-terminal-session',
      assistantText: 'echoed first-terminal-secret and second-terminal-secret',
      events: [{
        type: 'tool_use',
        id: 'terminal-tool-1',
        tool: 'remote',
        input: { token: 'first-terminal-secret' },
      }, {
        type: 'tool_use',
        id: 'terminal-tool-2',
        tool: 'remote',
        input: { token: 'second-terminal-secret' },
      }],
      onStream: logger.wrapCallback(),
    });

    const records = readFileSync(logger.filepath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as { event_type: string; call_id?: string; data: unknown });
    expect(records.map((record) => record.event_type)).toEqual(['tool_use', 'tool_use', 'text', 'result']);
    expect(records.slice(0, 2).map((record) => record.call_id)).toEqual([
      'terminal-tool-1',
      'terminal-tool-2',
    ]);
    for (const record of records.filter((record) => record.event_type === 'text' || record.event_type === 'result')) {
      const serialized = JSON.stringify(record.data);
      expect(serialized).not.toContain('first-terminal-secret');
      expect(serialized).not.toContain('second-terminal-secret');
      expect(serialized).toContain('[REDACTED]');
    }
  });

  it.each(['codex', 'claude-sdk'] as const)(
    'should redact a known secret split at every stream boundary for %s',
    (provider) => {
      const secret = 'split-secret-value';
      for (let split = 1; split < secret.length; split += 1) {
        const logger = createProviderEventLogger({
          logsDir: tempDir,
          sessionId: `${provider}-${split}`,
          runId: `run-${provider}`,
          provider,
          step: 'review',
          enabled: true,
        });
        const callback = logger.wrapCallback();
        callback({
          type: 'tool_use',
          data: { tool: 'remote', input: { token: secret }, id: `call-${split}` },
        });
        callback({ type: 'text', data: { text: secret.slice(0, split) } });
        callback({ type: 'text', data: { text: secret.slice(split) } });
        callback({
          type: 'result',
          data: { result: 'done', sessionId: `session-${split}`, success: true },
        });

        const records = readFileSync(logger.filepath, 'utf-8').trim().split('\n')
          .map((line) => JSON.parse(line) as { event_type: string; data: unknown });
        const streamedData = records
          .filter((record) => record.event_type === 'text')
          .map((record) => JSON.stringify(record.data))
          .join('');
        expect(streamedData).not.toContain(secret);
        expect(streamedData).toContain('[REDACTED]');
      }
    },
  );

  it('should redact an unregistered token split at every stream boundary', () => {
    const secret = 'sk-abcdefgh';
    for (let split = 1; split < secret.length; split += 1) {
      const logger = createProviderEventLogger({
        logsDir: tempDir,
        sessionId: `unregistered-${split}`,
        runId: 'run-unregistered',
        provider: 'opencode',
        step: 'review',
        enabled: true,
      });
      const callback = logger.wrapCallback();
      callback({ type: 'text', data: { text: secret.slice(0, split) } });
      callback({ type: 'text', data: { text: secret.slice(split) } });
      callback({ type: 'result', data: { result: 'done', sessionId: `session-${split}`, success: true } });

      const contents = readFileSync(logger.filepath, 'utf-8');
      expect(contents).not.toContain(secret);
      expect(contents).toContain('[REDACTED]');
    }
  });

  it.each([
    ['Authorization: Bearer ', 'authorization'],
    ['session_id: ', 'session'],
    ['token=', 'token'],
  ])('should not persist long split credentials in provider JSONL: %s', (prefix, label) => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: `long-${label}`,
      runId: 'run-long-secret',
      provider: 'opencode',
      step: 'review',
      enabled: true,
    });
    const secret = `${label}-${'x'.repeat(512)}`;
    const callback = logger.wrapCallback();

    callback({ type: 'text', data: { text: prefix, messageId: 'long-message' } });
    callback({ type: 'text', data: { text: secret, messageId: 'long-message' } });
    logger.flush();

    const contents = readFileSync(logger.filepath, 'utf-8');
    expect(contents).not.toContain(secret);
    expect(contents).toContain('[REDACTED]');
  });

  it('should report file write failures to stderr only once', () => {
    const logger = createProviderEventLogger({
      logsDir: join(tempDir, 'missing', 'nested'),
      sessionId: 'session-err',
      runId: 'run-err',
      provider: 'claude',
      step: 'plan',
      enabled: true,
    });

    const original = vi.fn();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const wrapped = logger.wrapCallback(original);
      wrapped({ type: 'text', data: { text: 'first' } });
      wrapped({ type: 'text', data: { text: 'second' } });

      expect(original).toHaveBeenCalledTimes(2);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0]?.[0]).toContain('Failed to write provider event log');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('should preserve call correlation and masking state across write failures and reverse completion', () => {
    const logsDir = join(tempDir, 'temporarily-missing');
    const logger = createProviderEventLogger({
      logsDir,
      sessionId: 'session-recovery',
      runId: 'run-recovery',
      provider: 'codex',
      step: 'review',
      enabled: true,
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const wrapped = logger.wrapCallback();
      wrapped({
        type: 'tool_use',
        data: { tool: 'remote', input: { token: 'first-sensitive-value' }, id: 'call-1' },
      });
      wrapped({
        type: 'tool_use',
        data: { tool: 'remote', input: { token: 'second-sensitive-value' }, id: 'call-2' },
      });

      mkdirSync(logsDir, { recursive: true });
      wrapped({
        type: 'tool_result',
        data: { id: 'call-2', content: 'second-sensitive-value', isError: false },
      });
      wrapped({
        type: 'tool_result',
        data: { id: 'call-1', content: 'first-sensitive-value', isError: false },
      });
      wrapped({ type: 'text', data: { text: 'first-sensitive-value second-sensitive-value' } });

      const records = readFileSync(logger.filepath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { call_id?: string; data: Record<string, unknown> });
      expect(records.slice(0, 2).map((record) => record.call_id)).toEqual(['call-2', 'call-1']);
      expect(JSON.stringify(records)).not.toContain('first-sensitive-value');
      expect(JSON.stringify(records)).not.toContain('second-sensitive-value');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('should redact known values from provider and assistant error events', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-errors',
      runId: 'run-errors',
      provider: 'claude-sdk',
      step: 'review',
      enabled: true,
    });
    const wrapped = logger.wrapCallback();
    wrapped({
      type: 'tool_use',
      data: { tool: 'remote', input: { token: 'error-sensitive-value' }, id: 'call-error' },
    });
    wrapped({
      type: 'error',
      data: { message: 'error-sensitive-value', raw: 'raw error-sensitive-value' },
    });
    wrapped({
      type: 'assistant_error',
      data: { error: 'assistant error-sensitive-value', sessionId: 'session-errors' },
    });

    const jsonl = readFileSync(logger.filepath, 'utf-8');
    expect(jsonl).not.toContain('error-sensitive-value');
    expect(jsonl).toContain('[REDACTED]');
  });

  it('should write init event records with typed data objects', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-5',
      runId: 'run-5',
      provider: 'codex',
      step: 'implement',
      enabled: true,
    });

    const wrapped = logger.wrapCallback();
    wrapped({
      type: 'init',
      data: {
        model: 'gpt-5-codex',
        sessionId: 'thread-1',
      },
    });

    const line = readFileSync(logger.filepath, 'utf-8').trim();
    const parsed = JSON.parse(line) as {
      provider: ProviderType;
      event_type: string;
      session_id?: string;
      data: { model: string; sessionId: string };
    };

    expect(parsed.provider).toBe('codex');
    expect(parsed.event_type).toBe('init');
    expect(parsed.session_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.data.model).toBe('gpt-5-codex');
    expect(parsed.data.sessionId).toBe('[REDACTED]');
    expect(JSON.stringify(parsed)).not.toContain('thread-1');
  });
});
