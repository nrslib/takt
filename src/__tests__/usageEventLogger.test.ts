import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type ProviderType = 'claude' | 'codex' | 'opencode';
type MovementType = 'normal' | 'parallel' | 'arpeggio' | 'team_leader';

interface ProviderUsageSnapshot {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly usageMissing: boolean;
  readonly reason?: string;
}

interface UsageEventLoggerConfig {
  readonly logsDir: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly provider: ProviderType;
  readonly providerModel: string;
  readonly movement: string;
  readonly movementType: MovementType;
  readonly enabled: boolean;
}

interface UsageEventLogger {
  readonly filepath: string;
  setMovement(movement: string, movementType: MovementType): void;
  setProvider(provider: ProviderType, providerModel: string): void;
  logUsage(params: {
    readonly success: boolean;
    readonly usage: ProviderUsageSnapshot;
    readonly timestamp?: Date;
  }): void;
}

interface UsageEventLoggerModule {
  createUsageEventLogger(config: UsageEventLoggerConfig): UsageEventLogger;
  isUsageEventsEnabled(config?: { logging?: { usageEvents?: boolean } }): boolean;
}

const USAGE_EVENT_LOGGER_MODULE_PATH = ['..', 'shared', 'utils', 'usageEventLogger.js'].join('/');

async function loadUsageEventLoggerModule(): Promise<UsageEventLoggerModule> {
  return (await import(USAGE_EVENT_LOGGER_MODULE_PATH)) as UsageEventLoggerModule;
}

describe('usageEventLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `takt-usage-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should disable usage events by default', async () => {
    const { isUsageEventsEnabled } = await loadUsageEventLoggerModule();

    expect(isUsageEventsEnabled()).toBe(false);
    expect(isUsageEventsEnabled({})).toBe(false);
    expect(isUsageEventsEnabled({ logging: {} })).toBe(false);
  });

  it('should enable usage events only when explicitly true', async () => {
    const { isUsageEventsEnabled } = await loadUsageEventLoggerModule();

    expect(isUsageEventsEnabled({ logging: { usageEvents: true } })).toBe(true);
    expect(isUsageEventsEnabled({ logging: { usageEvents: false } })).toBe(false);
  });

  it('should write usage event records with required fields', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-1',
      runId: 'run-1',
      provider: 'codex',
      providerModel: 'gpt-5-codex',
      movement: 'implement',
      movementType: 'normal',
      enabled: true,
    });

    logger.logUsage({
      success: true,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedInputTokens: 4,
        usageMissing: false,
      },
      timestamp: new Date('2026-03-04T12:00:00.000Z'),
    });

    expect(existsSync(logger.filepath)).toBe(true);

    const line = readFileSync(logger.filepath, 'utf-8').trim();
    const parsed = JSON.parse(line) as {
      run_id: string;
      session_id: string;
      provider: ProviderType;
      provider_model: string;
      movement: string;
      movement_type: MovementType;
      timestamp: string;
      success: boolean;
      usage_missing: boolean;
      reason?: string;
      usage: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        cached_input_tokens?: number;
      };
    };

    expect(parsed.run_id).toBe('run-1');
    expect(parsed.session_id).toBe('session-1');
    expect(parsed.provider).toBe('codex');
    expect(parsed.provider_model).toBe('gpt-5-codex');
    expect(parsed.movement).toBe('implement');
    expect(parsed.movement_type).toBe('normal');
    expect(parsed.success).toBe(true);
    expect(parsed.usage_missing).toBe(false);
    expect(parsed.timestamp).toBe('2026-03-04T12:00:00.000Z');
    expect(parsed.usage.input_tokens).toBe(12);
    expect(parsed.usage.output_tokens).toBe(8);
    expect(parsed.usage.total_tokens).toBe(20);
    expect(parsed.usage.cached_input_tokens).toBe(4);
  });

  it('should write usage_missing and reason when provider usage is unavailable', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-2',
      runId: 'run-2',
      provider: 'opencode',
      providerModel: 'openai/gpt-4.1',
      movement: 'implement',
      movementType: 'normal',
      enabled: true,
    });

    logger.logUsage({
      success: true,
      usage: {
        usageMissing: true,
        reason: 'usage_not_supported_by_provider',
      },
    });

    const line = readFileSync(logger.filepath, 'utf-8').trim();
    const parsed = JSON.parse(line) as {
      provider: ProviderType;
      usage_missing: boolean;
      reason?: string;
      usage: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        cached_input_tokens?: number;
      };
    };

    expect(parsed.provider).toBe('opencode');
    expect(parsed.usage_missing).toBe(true);
    expect(parsed.reason).toBe('usage_not_supported_by_provider');
    expect(parsed.usage).toEqual({});
  });

  it('should update movement and provider metadata for subsequent records', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-3',
      runId: 'run-3',
      provider: 'claude',
      providerModel: 'sonnet',
      movement: 'plan',
      movementType: 'normal',
      enabled: true,
    });

    logger.logUsage({
      success: true,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, usageMissing: false },
    });

    logger.setMovement('implement', 'parallel');
    logger.setProvider('codex', 'gpt-5-codex');
    logger.logUsage({
      success: true,
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, usageMissing: false },
    });

    const lines = readFileSync(logger.filepath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '{}') as { provider: ProviderType; provider_model: string; movement: string; movement_type: MovementType };
    const second = JSON.parse(lines[1] ?? '{}') as { provider: ProviderType; provider_model: string; movement: string; movement_type: MovementType };

    expect(first.provider).toBe('claude');
    expect(first.provider_model).toBe('sonnet');
    expect(first.movement).toBe('plan');
    expect(first.movement_type).toBe('normal');

    expect(second.provider).toBe('codex');
    expect(second.provider_model).toBe('gpt-5-codex');
    expect(second.movement).toBe('implement');
    expect(second.movement_type).toBe('parallel');
  });

  it('should not write records when disabled', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-disabled',
      runId: 'run-disabled',
      provider: 'claude',
      providerModel: 'sonnet',
      movement: 'plan',
      movementType: 'normal',
      enabled: false,
    });

    logger.logUsage({
      success: true,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, usageMissing: false },
    });

    expect(existsSync(logger.filepath)).toBe(false);
  });

  it('should report file write failures to stderr only once', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: join(tempDir, 'missing', 'nested'),
      sessionId: 'session-err',
      runId: 'run-err',
      provider: 'claude',
      providerModel: 'sonnet',
      movement: 'plan',
      movementType: 'normal',
      enabled: true,
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.logUsage({
        success: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, usageMissing: false },
      });
      logger.logUsage({
        success: true,
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, usageMissing: false },
      });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0]?.[0]).toContain('Failed to write usage event log');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
