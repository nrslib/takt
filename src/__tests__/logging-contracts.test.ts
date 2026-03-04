import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PROVIDER_EVENTS_LOG_FILE_SUFFIX,
  USAGE_EVENTS_LOG_FILE_SUFFIX,
  USAGE_MISSING_REASONS,
} from '../core/logging/contracts.js';
import { buildUsageEventRecord } from '../core/logging/providerEvent.js';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import { createUsageEventLogger } from '../core/logging/usageEventLogger.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';

describe('logging contracts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `takt-logging-contracts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should use shared file suffix contracts for provider and usage loggers', () => {
    const providerLogger = createProviderEventLogger({
      logsDir: tempDir,
      sessionId: 'session-a',
      runId: 'run-a',
      provider: 'claude',
      movement: 'plan',
      enabled: false,
    });
    const usageLogger = createUsageEventLogger({
      logsDir: tempDir,
      sessionId: 'session-b',
      runId: 'run-b',
      provider: 'codex',
      providerModel: 'gpt-5-codex',
      movement: 'implement',
      movementType: 'normal',
      enabled: false,
    });

    expect(providerLogger.filepath.endsWith(PROVIDER_EVENTS_LOG_FILE_SUFFIX)).toBe(true);
    expect(usageLogger.filepath.endsWith(USAGE_EVENTS_LOG_FILE_SUFFIX)).toBe(true);
  });

  it('should accept shared ProviderUsageSnapshot contract in usage record builder', () => {
    const usage: ProviderUsageSnapshot = {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cachedInputTokens: 4,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 2,
      usageMissing: false,
    };

    const record = buildUsageEventRecord(
      {
        runId: 'run-1',
        sessionId: 'session-1',
        provider: 'claude',
        providerModel: 'sonnet',
        movement: 'implement',
        movementType: 'normal',
      },
      { success: true, usage, timestamp: new Date('2026-03-04T12:00:00.000Z') },
    );

    expect(record.usage.cached_input_tokens).toBe(4);
  });

  it('should reject usage_missing records with unknown reason values', () => {
    expect(() =>
      buildUsageEventRecord(
        {
          runId: 'run-2',
          sessionId: 'session-2',
          provider: 'opencode',
          providerModel: 'openai/gpt-4.1',
          movement: 'implement',
          movementType: 'normal',
        },
        {
          success: true,
          usage: {
            usageMissing: true,
            reason: 'invalid_reason',
          } as ProviderUsageSnapshot,
        },
      ),
    ).toThrow('[usage-events] reason is invalid');

    expect(() =>
      buildUsageEventRecord(
        {
          runId: 'run-3',
          sessionId: 'session-3',
          provider: 'opencode',
          providerModel: 'openai/gpt-4.1',
          movement: 'implement',
          movementType: 'normal',
        },
        {
          success: true,
          usage: {
            usageMissing: true,
            reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
          },
        },
      ),
    ).not.toThrow();
  });
});
