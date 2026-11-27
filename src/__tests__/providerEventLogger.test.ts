import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProviderEventLogger,
  isProviderEventsEnabled,
} from '../core/logging/providerEventLogger.js';
import type { ProviderEventLogRecord } from '../core/logging/providerEvent.js';
import type { ProviderType } from '../core/workflow/index.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { setExecutionSecrets } from '../shared/utils/execution-secrets.js';

describe('providerEventLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-events-'));
  });

  afterEach(() => {
    setExecutionSecrets([]);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should disable provider events by default', () => {
    expect(isProviderEventsEnabled()).toBe(false);
    expect(isProviderEventsEnabled({})).toBe(false);
    expect(isProviderEventsEnabled({ logging: {} })).toBe(false);
    expect(isProviderEventsEnabled({ logging: { providerEvents: false } })).toBe(false);
  });

  it.each([
    ['FAKE_VALUE', 'a9 [REDACTED]'],
    ['a', '[REDACTED]9 FAKE_VALUE'],
  ])('preserves event context while redacting %s in the same provider response', (secret, expected) => {
    setExecutionSecrets([secret]);
    const logger = createProviderEventLogger({ logsDir: tempDir, sessionId: 'session-a', runId: 'run-a', enabled: true });
    logger.logEvent({ provider: 'claude', providerModel: 'model-a', step: 'analyze' },
      { type: 'result', data: { result: 'a9 FAKE_VALUE', sessionId: 'session-a', success: false } });
    const saved = JSON.parse(readFileSync(logger.filepath, 'utf8'));
    expect(saved).toMatchObject({ provider: 'claude', provider_model: 'model-a', step: 'analyze',
      run_id: 'run-a', event_type: 'result', session_id: 'session-a',
      data: { result: expected, sessionId: 'session-a', success: false } });
  });

  it.each(['text', 'thinking', 'tool_output'] as const)('redacts a distributed credential split across %s events before storage', (type) => {
    setExecutionSecrets(['arbitrary-distributed-value']);
    const logger = createProviderEventLogger({ logsDir: tempDir, sessionId: 'split', runId: 'run', enabled: true });
    const context = { provider: 'mock' as const, providerModel: 'mock', step: 'work' };
    const field = type === 'text' ? 'text' : type === 'thinking' ? 'thinking' : 'output';
    const event = (value: string): StreamEvent => type === 'text' ? { type, data: { text: value } }
      : type === 'thinking' ? { type, data: { thinking: value } } : { type, data: { tool: 'Read', id: 'call', output: value } };
    logger.logEvent(context, event('before arbitrary-'));
    expect(readFileSync(logger.filepath, 'utf8')).not.toContain('arbitrary-');
    logger.logEvent(context, event('distributed-value after'));
    logger.flush();
    const records = readFileSync(logger.filepath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(records.map((record) => record.data[field]).join('')).toBe('before [REDACTED] after');
  });

  it('preserves large benign stream output and flushes its tail on the result event', () => {
    setExecutionSecrets(['arbitrary-distributed-value']);
    const logger = createProviderEventLogger({ logsDir: tempDir, sessionId: 'large', runId: 'run', enabled: true });
    const context = { provider: 'mock' as const, providerModel: 'mock', step: 'work' };
    const text = 'normal output '.repeat(2000);
    logger.logEvent(context, { type: 'text', data: { text } });
    logger.logEvent(context, { type: 'result', data: { result: 'done', sessionId: 'session', success: true } });
    const records = readFileSync(logger.filepath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(records.filter((record) => record.event_type === 'text').map((record) => record.data.text).join('')).toBe(text);
  });

  it.each(['z', 'xy', 'abc', 'D'])('redacts short value %s across chunks without changing event identifiers', (secret) => {
    setExecutionSecrets([secret]);
    const logger = createProviderEventLogger({ logsDir: tempDir, sessionId: 'session', runId: 'run', enabled: true });
    const context = { provider: 'mock' as const, providerModel: 'model', step: 'work' };
    const split = Math.max(1, secret.length - 1);
    logger.logEvent(context, { type: 'text', data: { text: 'before ' + secret.slice(0, split) } });
    logger.logEvent(context, { type: 'text', data: { text: secret.slice(split) + '123 end' } });
    logger.logEvent(context, { type: 'result', data: { result: 'done', sessionId: 'session', success: true } });
    const records = readFileSync(logger.filepath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ProviderEventLogRecord);
    const textRecords = records.filter((record) => record.event_type === 'text');
    expect(textRecords.map((record) => record.data.text).join('')).toBe('before [REDACTED]123 end');
    for (const record of textRecords) expect(record).toMatchObject({ provider: 'mock', provider_model: 'model',
      event_type: 'text', run_id: 'run', step: 'work' });
  });

  it('should enable provider events only when explicitly true', () => {
    expect(isProviderEventsEnabled({ logging: { providerEvents: true } })).toBe(true);
  });

  it('should not enable provider events from legacy observability key', () => {
    const legacyOnlyConfig = {
      observability: { providerEvents: true },
    } as unknown as Parameters<typeof isProviderEventsEnabled>[0];
    expect(isProviderEventsEnabled(legacyOnlyConfig)).toBe(false);
  });

  it('should write normalized JSONL records with explicit context', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-1',
      runId: 'run-1',
      enabled: true,
    });

    logger.logEvent({ provider: 'opencode', providerModel: 'openai/gpt-4.1', step: 'implement' }, {
      type: 'tool_use',
      data: {
        tool: 'Read',
        id: 'call-123',
        input: {},
      },
    });

    expect(existsSync(logger.filepath)).toBe(true);
    const parsed = JSON.parse(readFileSync(logger.filepath, 'utf-8').trim()) as {
      provider: ProviderType;
      provider_model: string;
      event_type: string;
      run_id: string;
      step: string;
      call_id?: string;
      data: Record<string, unknown>;
    };

    expect(parsed.provider).toBe('opencode');
    expect(parsed.provider_model).toBe('openai/gpt-4.1');
    expect(parsed.event_type).toBe('tool_use');
    expect(parsed.run_id).toBe('run-1');
    expect(parsed.step).toBe('implement');
    expect(parsed.call_id).toBe('call-123');
    expect(parsed.data).toEqual({ tool: 'Read', id: 'call-123', input: {} });
  });

  it('should preserve message identifiers from provider payloads', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-message',
      runId: 'run-message',
      enabled: true,
    });

    logger.logEvent({
      provider: 'claude',
      providerModel: 'haiku',
      step: 'implement',
    }, {
      type: 'text',
      data: { text: 'complete', messageId: 'message-123' },
    } as StreamEvent);

    const parsed = JSON.parse(readFileSync(logger.filepath, 'utf-8').trim()) as ProviderEventLogRecord;
    expect(parsed.message_id).toBe('message-123');
    expect(parsed.data).toEqual({ text: 'complete', messageId: 'message-123' });
  });

  it('should use the provider-events filename suffix', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-suffix',
      runId: 'run-suffix',
      enabled: true,
    });

    expect(logger.filepath.endsWith('-provider-events.jsonl')).toBe(true);
    expect(logger.filepath.endsWith('-usage-events.jsonl')).toBe(false);
  });

  it('should reject an empty provider model before writing an enabled record', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-model-required',
      runId: 'run-model-required',
      enabled: true,
    });

    expect(() => logger.logEvent({ provider: 'codex', providerModel: '', step: 'implement' }, {
      type: 'text',
      data: { text: 'hello' },
    })).toThrow(/providerModel is required/);
    expect(existsSync(logger.filepath)).toBe(false);
  });

  it('should normalize permission_asked events for provider logs', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-permission',
      runId: 'run-permission',
      enabled: true,
    });

    logger.logEvent({ provider: 'opencode', providerModel: 'openai/gpt-4.1', step: 'reviewers' }, {
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

    const parsed = JSON.parse(readFileSync(logger.filepath, 'utf-8').trim()) as {
      event_type: string;
      session_id?: string;
      request_id?: string;
      data: Record<string, unknown>;
    };
    expect(parsed.event_type).toBe('permission_asked');
    expect(parsed.session_id).toBe('opencode-session-1');
    expect(parsed.request_id).toBe('perm-1');
    expect(parsed.data['permission']).toBe('bash');
    expect(parsed.data['patterns']).toEqual(['**']);
    expect(parsed.data['always']).toEqual([]);
    expect(parsed.data['reply']).toBe('reject');
  });

  it('should preserve permission summary payloads', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-permission-summary',
      runId: 'run-permission-summary',
      enabled: true,
    });

    logger.logEvent({ provider: 'opencode', providerModel: 'openai/gpt-4.1', step: 'reviewers' }, {
      type: 'permission_summary',
      data: {
        sessionId: 'opencode-session-2',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Write'],
        networkAccess: false,
        resolvedPermissions: [
          { permission: 'bash', pattern: 'npm test', action: 'allow' },
        ],
      },
    });

    const persisted = readFileSync(logger.filepath, 'utf-8').trim();
    const parsed = JSON.parse(persisted) as ProviderEventLogRecord;
    expect(parsed.session_id).toBe('opencode-session-2');
    expect(parsed.data).toEqual({
      sessionId: 'opencode-session-2',
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Write'],
      networkAccess: false,
      resolvedPermissions: [
        { permission: 'bash', pattern: 'npm test', action: 'allow' },
      ],
    });
  });

  it('should normalize every supported rate-limit metadata field', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-rate-limit',
      runId: 'run-rate-limit',
      enabled: true,
    });

    logger.logEvent({ provider: 'claude', providerModel: 'sonnet', step: 'implement' }, {
      type: 'rate_limit',
      data: {
        sessionId: 'claude-session-1',
        status: 'allowed_warning',
        rateLimitType: 'tokens',
        overageStatus: 'rejected',
        overageDisabledReason: 'budget',
        resetsAt: 100,
        overageResetsAt: 200,
        isUsingOverage: false,
      },
    });

    const parsed = JSON.parse(readFileSync(logger.filepath, 'utf-8').trim()) as ProviderEventLogRecord;
    expect(parsed.session_id).toBe('claude-session-1');
    expect(parsed.data).toEqual({
      sessionId: 'claude-session-1',
      status: 'allowed_warning',
      rateLimitType: 'tokens',
      overageStatus: 'rejected',
      overageDisabledReason: 'budget',
      resetsAt: 100,
      overageResetsAt: 200,
      isUsingOverage: false,
    });
  });

  it('should preserve provider event data beyond 1000 characters', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-metadata-boundary',
      runId: 'run-metadata-boundary',
      enabled: true,
    });
    const atLimit = 'a'.repeat(1_000);
    const overLimit = 'b'.repeat(1_001);

    logger.logEvent({ provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' }, {
      type: 'tool_use',
      data: { tool: atLimit, id: 'call-at-limit', input: {} },
    });
    logger.logEvent({ provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' }, {
      type: 'tool_use',
      data: { tool: overLimit, id: 'call-over-limit', input: {} },
    });

    const records = readFileSync(logger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(records[0]?.data['tool']).toBe(atLimit);
    expect(records[1]?.data['tool']).toBe(overLimit);
  });

  it('should retain a large provider event and mask secrets within it', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-large-event',
      runId: 'run-large-event',
      enabled: true,
    });
    const content = `begin-${'x'.repeat(51_000)}-end`;
    logger.logEvent({ provider: 'codex', providerModel: 'gpt-5', step: 'review' }, {
      type: 'tool_result',
      data: { id: 'large-call', content, isError: false, token: 'SECRET_VALUE' },
    } as import('../shared/types/provider.js').StreamEvent);

    const persisted = readFileSync(logger.filepath, 'utf-8').trim();
    const record = JSON.parse(persisted) as ProviderEventLogRecord;
    expect(record.data['content']).toBe(content);
    expect(record.data['token']).toBe('[REDACTED]');
    expect(persisted).not.toContain('SECRET_VALUE');
  });

  it('should bound long step metadata without adding derived identifiers', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-step-identity',
      runId: 'run-step-identity',
      enabled: true,
    });
    const commonPrefix = 'x'.repeat(1_001);
    const steps = [`${commonPrefix}-first`, `${commonPrefix}-second`];

    for (const step of steps) {
      logger.logEvent({ provider: 'codex', providerModel: 'gpt-5-codex', step }, {
        type: 'text',
        data: { text: 'routing' },
      });
    }

    const records = readFileSync(logger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(records[0]?.step).toBe(records[1]?.step);
    expect(records[0]?.step).toMatch(/\.\.\.\[truncated\]$/);
    expect(records[0]).not.toHaveProperty('step_digest');
    expect(records[1]).not.toHaveProperty('step_digest');
  });

  it('should recursively redact sensitive payload keys while preserving safe payload fields', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-sensitive-payload',
      runId: 'run-sensitive-payload',
      enabled: true,
    });

    logger.logEvent({ provider: 'codex', providerModel: 'gpt-5', step: 'implement' }, {
      type: 'tool_use',
      data: {
        tool: 'Fetch',
        id: 'call-sensitive',
        input: {
          url: 'https://example.com',
          headers: {
            authorization: 'Bearer OBJECT_TOKEN',
            cookie: 'session=COOKIE_TOKEN',
          },
        },
      },
    });

    const persisted = readFileSync(logger.filepath, 'utf-8').trim();
    const parsed = JSON.parse(persisted) as ProviderEventLogRecord;
    expect(parsed.data).toMatchObject({
      tool: 'Fetch',
      input: {
        url: 'https://example.com',
        headers: {
          authorization: '[REDACTED]',
          cookie: '[REDACTED]',
        },
      },
    });
    expect(persisted).not.toContain('OBJECT_TOKEN');
    expect(persisted).not.toContain('COOKIE_TOKEN');
  });

  it('should redact URL credentials before applying the metadata length limit', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-url-credentials',
      runId: 'run-url-credentials',
      enabled: true,
    });
    const secret = 'UNIQUE_PROVIDER_LEAK_VALUE';
    const credentialUrl = `https://${'a'.repeat(980)}:${secret}@example.com`;

    logger.logEvent({
      provider: 'codex',
      providerModel: 'gpt-5-codex',
      step: credentialUrl,
    }, {
      type: 'text',
      data: { text: 'routing' },
    });

    const persisted = readFileSync(logger.filepath, 'utf-8').trim();
    const record = JSON.parse(persisted) as ProviderEventLogRecord;
    expect(record.step).toContain('[REDACTED]');
    expect(persisted).not.toContain(secret);
  });

  it('should keep explicit context for interleaved provider events', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-interleaved',
      runId: 'run-interleaved',
      enabled: true,
    });

    logger.logEvent(
      { provider: 'claude', providerModel: 'sonnet', step: 'plan' },
      { type: 'init', data: { model: 'sonnet', sessionId: 's-1' } },
    );
    logger.logEvent(
      { provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' },
      { type: 'result', data: { result: 'ok', sessionId: 's-2', success: true } },
    );
    logger.logEvent(
      { provider: 'claude', providerModel: 'sonnet', step: 'plan' },
      { type: 'result', data: { result: 'ok', sessionId: 's-1', success: true } },
    );

    const records = readFileSync(logger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { provider: ProviderType; step: string });
    expect(records).toEqual([
      expect.objectContaining({ provider: 'claude', step: 'plan' }),
      expect.objectContaining({ provider: 'codex', step: 'implement' }),
      expect.objectContaining({ provider: 'claude', step: 'plan' }),
    ]);
  });

  it('should not write records when disabled', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-disabled',
      runId: 'run-disabled',
      enabled: false,
    });

    logger.logEvent(
      { provider: 'claude', providerModel: 'sonnet', step: 'plan' },
      { type: 'text', data: { text: 'hello' } },
    );
    expect(existsSync(logger.filepath)).toBe(false);
  });

  it('should preserve tool inputs while redacting nested credentials', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-tool-use',
      runId: 'run-tool-use',
      enabled: true,
    });

    logger.logEvent({ provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' }, {
      type: 'tool_use',
      data: {
        tool: 'Fetch',
        id: 'call-sensitive',
        input: {
          headers: {
            authorization: 'Bearer nested-secret-value',
          },
        },
      },
    });

    const parsed = JSON.parse(readFileSync(logger.filepath, 'utf-8').trim()) as {
      data: Record<string, unknown>;
    };
    expect(parsed.data).toEqual({
      tool: 'Fetch',
      id: 'call-sensitive',
      input: {
        headers: {
          authorization: '[REDACTED]',
        },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('nested-secret-value');
  });

  it('should preserve provider event bodies after redacting credential patterns', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-raw-bodies',
      runId: 'run-raw-bodies',
      enabled: true,
    });
    const secret = 'sk-provider-secret-12345';
    const privateKeyTail = '-----BEGIN OPENSSH PRIVATE KEY-----\nsplit-private-key-material\n-----END OPENSSH PRIVATE KEY-----';
    const toolResultContent = `prefix {"authorization":{"value":"Bearer ${secret}"}}`;
    const toolOutput = `line 1\n{"api_key":"${secret}"}`;
    const text = `text ${privateKeyTail}`;
    const thinking = `thinking ${secret}`;
    const result = `result ${secret}`;
    const events: StreamEvent[] = [
      {
        type: 'tool_result',
        data: {
          content: toolResultContent,
          isError: false,
        },
      },
      {
        type: 'tool_output',
        data: { tool: 'Read', output: toolOutput },
      },
      { type: 'text', data: { text } },
      { type: 'thinking', data: { thinking } },
      {
        type: 'result',
        data: { result, sessionId: 'result-session', success: false, error: secret },
      },
      { type: 'assistant_error', data: { error: secret, sessionId: 'assistant-session' } },
      { type: 'error', data: { message: secret, raw: privateKeyTail } },
    ];

    for (const event of events) {
      logger.logEvent({ provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' }, event);
    }

    const persisted = readFileSync(logger.filepath, 'utf-8');
    const records = persisted.trim().split('\n').map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(records.map((record) => record.data)).toEqual([
      { content: 'prefix {"authorization":{"value":"Bearer [REDACTED]"}}', isError: false },
      { tool: 'Read', output: 'line 1\n{"api_key":"[REDACTED]"}' },
      { text: 'text [REDACTED]' },
      { thinking: 'thinking [REDACTED]' },
      {
        result: 'result [REDACTED]',
        sessionId: 'result-session',
        success: false,
        error: '[REDACTED]',
      },
      { error: '[REDACTED]', sessionId: 'assistant-session' },
      { message: '[REDACTED]', raw: '[REDACTED]' },
    ]);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('split-private-key-material');
    expect(persisted).not.toContain('PRIVATE KEY');
  });

  it('should report file write failures to stderr only once', () => {
    const logger = createProviderEventLogger({
      logsDir: join(tempDir, 'missing', 'nested'),
      sessionId: 'session-err',
      runId: 'run-err',
      enabled: true,
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      logger.logEvent(
        { provider: 'claude', providerModel: 'sonnet', step: 'plan' },
        { type: 'text', data: { text: 'first' } },
      );
      logger.logEvent(
        { provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' },
        { type: 'text', data: { text: 'second' } },
      );

      expect(stderrSpy).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('should isolate serialization failures and continue the provider stream callback', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-serialization-error',
      runId: 'run-serialization-error',
      enabled: true,
    });
    const circularInput: Record<string, unknown> = {
      get self(): Record<string, unknown> {
        return circularInput;
      },
    };
    const event: StreamEvent = {
      type: 'tool_use',
      data: {
        tool: 'Read',
        id: 'call-circular',
        input: circularInput,
      },
    };
    const downstream = vi.fn();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const handleProviderStream = (streamEvent: StreamEvent): void => {
        logger.logEvent(
          { provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' },
          streamEvent,
        );
        downstream(streamEvent);
      };

      expect(() => handleProviderStream(event)).not.toThrow();
      expect(downstream).toHaveBeenCalledWith(event);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(existsSync(logger.filepath)).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('should write init event records with typed data objects', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-init',
      runId: 'run-init',
      enabled: true,
    });

    logger.logEvent({ provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement' }, {
      type: 'init',
      data: {
        model: 'gpt-5-codex',
        sessionId: 'thread-1',
      },
    });

    const parsed = JSON.parse(readFileSync(logger.filepath, 'utf-8').trim()) as {
      provider: ProviderType;
      event_type: string;
      session_id?: string;
      data: { model: string; sessionId: string };
    };
    expect(parsed.provider).toBe('codex');
    expect(parsed.event_type).toBe('init');
    expect(parsed.session_id).toBe('thread-1');
    expect(parsed.data.model).toBe('gpt-5-codex');
    expect(parsed.data.sessionId).toBe('thread-1');
  });
});
