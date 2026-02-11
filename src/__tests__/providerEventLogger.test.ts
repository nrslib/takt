import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProviderEventLogger,
  isProviderEventsEnabled,
} from '../shared/utils/providerEventLogger.js';
import type { ProviderType } from '../core/piece/index.js';

describe('providerEventLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `takt-provider-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should disable provider events by default', () => {
    expect(isProviderEventsEnabled()).toBe(false);
    expect(isProviderEventsEnabled({})).toBe(false);
    expect(isProviderEventsEnabled({ observability: {} })).toBe(false);
  });

  it('should enable provider events only when explicitly true', () => {
    expect(isProviderEventsEnabled({ observability: { providerEvents: true } })).toBe(true);
  });

  it('should disable provider events only when explicitly false', () => {
    expect(isProviderEventsEnabled({ observability: { providerEvents: false } })).toBe(false);
  });

  it('should write normalized JSONL records when enabled', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-1',
      runId: 'run-1',
      provider: 'opencode',
      movement: 'implement',
      enabled: true,
    });

    const original = vi.fn();
    const wrapped = logger.wrapCallback(original);

    wrapped({
      type: 'tool_use',
      data: {
        tool: 'Read',
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
      movement: string;
      session_id?: string;
      call_id?: string;
      message_id?: string;
      request_id?: string;
      data: Record<string, unknown>;
    };

    expect(parsed.provider).toBe('opencode');
    expect(parsed.event_type).toBe('tool_use');
    expect(parsed.run_id).toBe('run-1');
    expect(parsed.movement).toBe('implement');
    expect(parsed.session_id).toBe('session-abc');
    expect(parsed.call_id).toBe('call-123');
    expect(parsed.message_id).toBe('msg-123');
    expect(parsed.request_id).toBe('req-123');
    expect(parsed.data['tool']).toBe('Read');
  });

  it('should update movement and provider for subsequent events', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-2',
      runId: 'run-2',
      provider: 'claude',
      movement: 'plan',
      enabled: true,
    });

    const wrapped = logger.wrapCallback();

    wrapped({ type: 'init', data: { model: 'sonnet', sessionId: 's-1' } });
    logger.setMovement('implement');
    logger.setProvider('codex');
    wrapped({ type: 'result', data: { result: 'ok', sessionId: 's-1', success: true } });

    const lines = readFileSync(logger.filepath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as { provider: ProviderType; movement: string };
    const second = JSON.parse(lines[1]!) as { provider: ProviderType; movement: string };

    expect(first.provider).toBe('claude');
    expect(first.movement).toBe('plan');
    expect(second.provider).toBe('codex');
    expect(second.movement).toBe('implement');
  });

  it('should not write records when disabled', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-3',
      runId: 'run-3',
      provider: 'claude',
      movement: 'plan',
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
      movement: 'plan',
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

  it('should write init event records with typed data objects', () => {
    const logger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-5',
      runId: 'run-5',
      provider: 'codex',
      movement: 'implement',
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
    expect(parsed.session_id).toBe('thread-1');
    expect(parsed.data.model).toBe('gpt-5-codex');
    expect(parsed.data.sessionId).toBe('thread-1');
  });
});
