import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  UsageEventLogger,
  UsageEventLoggerConfig,
} from '../core/logging/usageEventLogger.js';
import type { StepType } from '../core/logging/usageEvent.js';
import type { ProviderType } from '../shared/types/provider.js';

interface UsageEventLoggerModule {
  createUsageEventLogger(config: UsageEventLoggerConfig): UsageEventLogger;
  isUsageEventsEnabled(config?: { logging?: { usageEvents?: boolean } }): boolean;
}

const USAGE_EVENT_LOGGER_MODULE_PATH = ['..', 'core', 'logging', 'usageEventLogger.js'].join('/');

async function loadUsageEventLoggerModule(): Promise<UsageEventLoggerModule> {
  return (await import(USAGE_EVENT_LOGGER_MODULE_PATH)) as UsageEventLoggerModule;
}

describe('usageEventLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-usage-events-'));
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
      enabled: true,
    });

    logger.logUsageFor({
      provider: 'codex',
      providerModel: 'gpt-5-codex',
      step: 'implement',
      stepType: 'normal',
    }, {
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
      step: string;
      step_type: StepType;
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
    expect(parsed.step).toBe('implement');
    expect(parsed.step_type).toBe('normal');
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
      enabled: true,
    });

    logger.logUsageFor({
      provider: 'opencode',
      providerModel: 'openai/gpt-4.1',
      step: 'implement',
      stepType: 'normal',
    }, {
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

  it('should require explicit immutable context for each record', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-3',
      runId: 'run-3',
      enabled: true,
    });

    logger.logUsageFor({
      provider: 'claude', providerModel: 'sonnet', step: 'plan', stepType: 'normal',
    }, {
      success: true,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, usageMissing: false },
    });

    logger.logUsageFor({
      provider: 'codex', providerModel: 'gpt-5-codex', step: 'implement', stepType: 'parallel',
    }, {
      success: true,
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, usageMissing: false },
    });

    const lines = readFileSync(logger.filepath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '{}') as { provider: ProviderType; provider_model: string; step: string; step_type: StepType };
    const second = JSON.parse(lines[1] ?? '{}') as { provider: ProviderType; provider_model: string; step: string; step_type: StepType };

    expect(first.provider).toBe('claude');
    expect(first.provider_model).toBe('sonnet');
    expect(first.step).toBe('plan');
    expect(first.step_type).toBe('normal');

    expect(second.provider).toBe('codex');
    expect(second.provider_model).toBe('gpt-5-codex');
    expect(second.step).toBe('implement');
    expect(second.step_type).toBe('parallel');
  });

  it('should keep explicit context for interleaved delegated usage records', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-delegated',
      runId: 'run-delegated',
      enabled: true,
    });
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, usageMissing: false };

    logger.logUsageFor(
      { provider: 'codex', providerModel: 'gpt-5', step: 'review-a', stepType: 'parallel' },
      { success: true, usage },
    );
    logger.logUsageFor(
      { provider: 'opencode', providerModel: 'openai/gpt-4.1', step: 'review-b', stepType: 'parallel' },
      { success: true, usage },
    );
    logger.logUsageFor(
      { provider: 'codex', providerModel: 'gpt-5', step: 'review-a', stepType: 'parallel' },
      { success: false, usage },
    );

    const records = readFileSync(logger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { provider: ProviderType; provider_model: string; step: string });
    expect(records).toEqual([
      expect.objectContaining({ provider: 'codex', provider_model: 'gpt-5', step: 'review-a' }),
      expect.objectContaining({ provider: 'opencode', provider_model: 'openai/gpt-4.1', step: 'review-b' }),
      expect.objectContaining({ provider: 'codex', provider_model: 'gpt-5', step: 'review-a' }),
    ]);
  });

  it('should redact and bound delegated step metadata without adding derived identifiers', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-sensitive-delegated',
      runId: 'run-sensitive-delegated',
      enabled: true,
    });
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, usageMissing: false };
    const firstStep = `implement.Authorization: Bearer TOP_SECRET_VALUE-${'x'.repeat(50_000)}\uD800`;
    const secondStep = `implement.Authorization: Bearer TOP_SECRET_VALUE-${'x'.repeat(50_000)}\uD801`;

    for (const step of [firstStep, secondStep]) {
      logger.logUsageFor({
        provider: 'codex',
        providerModel: 'gpt-5',
        step,
        stepType: 'team_leader',
      }, { success: true, usage });
    }

    const serialized = readFileSync(logger.filepath, 'utf-8').trim();
    const records = serialized
      .split('\n')
      .map((line) => JSON.parse(line) as { step: string });
    expect(serialized).not.toContain('TOP_SECRET_VALUE');
    expect(records.every((record) => record.step.length <= 1_000)).toBe(true);
    expect(records[0]?.step).toContain('[REDACTED]');
    expect(records[0]).not.toHaveProperty('step_digest');
    expect(records[1]).not.toHaveProperty('step_digest');
  });

  it('should redact URL credentials before applying the delegated step length limit', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-url-credentials',
      runId: 'run-url-credentials',
      enabled: true,
    });
    const secret = 'UNIQUE_USAGE_LEAK_VALUE';
    const credentialUrl = `https://${'a'.repeat(980)}:${secret}@example.com`;

    logger.logUsageFor({
      provider: 'codex',
      providerModel: 'gpt-5',
      step: credentialUrl,
      stepType: 'team_leader',
    }, {
      success: true,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, usageMissing: false },
    });

    const persisted = readFileSync(logger.filepath, 'utf-8').trim();
    const record = JSON.parse(persisted) as { step: string };
    expect(record.step).toContain('[REDACTED]');
    expect(record).not.toHaveProperty('step_digest');
    expect(persisted).not.toContain(secret);
  });

  it('should not write records when disabled', async () => {
    const { createUsageEventLogger } = await loadUsageEventLoggerModule();
    const logger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-disabled',
      runId: 'run-disabled',
      enabled: false,
    });

    logger.logUsageFor({
      provider: 'claude', providerModel: 'sonnet', step: 'plan', stepType: 'normal',
    }, {
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
      enabled: true,
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.logUsageFor({
        provider: 'claude', providerModel: 'sonnet', step: 'plan', stepType: 'normal',
      }, {
        success: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, usageMissing: false },
      });
      logger.logUsageFor({
        provider: 'claude', providerModel: 'sonnet', step: 'plan', stepType: 'normal',
      }, {
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
