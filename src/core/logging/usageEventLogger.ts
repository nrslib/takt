import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderType } from '../../shared/types/provider.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import { USAGE_EVENTS_LOG_FILE_SUFFIX } from './contracts.js';
import {
  buildUsageEventRecord,
  type StepType,
} from './usageEvent.js';

export interface UsageEventLoggerConfig {
  readonly logsDir: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly enabled: boolean;
}

export interface UsageEventLogContext {
  readonly provider: ProviderType;
  readonly providerModel: string;
  readonly step: string;
  readonly stepType: StepType;
}

export interface UsageEventLogParams {
  readonly success: boolean;
  readonly usage: ProviderUsageSnapshot;
  readonly timestamp?: Date;
}

export interface UsageEventLogger {
  readonly filepath: string;
  logUsageFor(context: UsageEventLogContext, params: UsageEventLogParams): void;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`[usage-events] ${field} is required`);
  }
}

export function createUsageEventLogger(config: UsageEventLoggerConfig): UsageEventLogger {
  if (config.enabled) {
    assertNonEmpty(config.logsDir, 'logsDir');
    assertNonEmpty(config.sessionId, 'sessionId');
    assertNonEmpty(config.runId, 'runId');
  }

  const filepath = join(config.logsDir, `${config.sessionId}${USAGE_EVENTS_LOG_FILE_SUFFIX}`);
  let hasReportedWriteFailure = false;

  const write = (context: UsageEventLogContext, params: UsageEventLogParams): void => {
    if (!config.enabled) {
      return;
    }
    assertNonEmpty(context.step, 'step');
    assertNonEmpty(context.providerModel, 'providerModel');
    const record = buildUsageEventRecord(
      {
        runId: config.runId,
        sessionId: config.sessionId,
        ...context,
      },
      params,
    );

    try {
      appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (error) {
      if (hasReportedWriteFailure) {
        return;
      }
      hasReportedWriteFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[takt] Failed to write usage event log: ${message}\n`);
    }
  };

  return {
    filepath,
    logUsageFor(context: UsageEventLogContext, params: UsageEventLogParams): void {
      write(context, params);
    },
  };
}

export function isUsageEventsEnabled(config?: {
  logging?: {
    usageEvents?: boolean;
  };
}): boolean {
  return config?.logging?.usageEvents === true;
}
