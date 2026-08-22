import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderType, StreamEvent } from '../../shared/types/provider.js';
import { PROVIDER_EVENTS_LOG_FILE_SUFFIX } from './contracts.js';
import { normalizeProviderEvent } from './providerEvent.js';

export interface ProviderEventLoggerConfig {
  logsDir: string;
  sessionId: string;
  runId: string;
  enabled: boolean;
}

export interface ProviderEventLogContext {
  readonly provider: ProviderType;
  readonly providerModel: string;
  readonly step: string;
}

export interface ProviderEventLogger {
  readonly filepath: string;
  logEvent(context: ProviderEventLogContext, event: StreamEvent): void;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`[provider-events] ${field} is required`);
  }
}

export function createProviderEventLogger(config: ProviderEventLoggerConfig): ProviderEventLogger {
  if (config.enabled) {
    assertNonEmpty(config.logsDir, 'logsDir');
    assertNonEmpty(config.sessionId, 'sessionId');
    assertNonEmpty(config.runId, 'runId');
  }

  const filepath = join(config.logsDir, `${config.sessionId}${PROVIDER_EVENTS_LOG_FILE_SUFFIX}`);
  let hasReportedWriteFailure = false;

  const write = (context: ProviderEventLogContext, event: StreamEvent): void => {
    try {
      const record = normalizeProviderEvent(
        event,
        context.provider,
        context.providerModel,
        context.step,
        config.runId,
      );
      appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (error) {
      if (hasReportedWriteFailure) {
        return;
      }
      hasReportedWriteFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[takt] Failed to write provider event log: ${message}\n`);
    }
  };

  return {
    filepath,
    logEvent(context: ProviderEventLogContext, event: StreamEvent): void {
      if (!config.enabled) {
        return;
      }
      assertNonEmpty(context.step, 'step');
      assertNonEmpty(context.providerModel, 'providerModel');
      write(context, event);
    },
  };
}

export function isProviderEventsEnabled(config?: {
  logging?: {
    providerEvents?: boolean;
  };
}): boolean {
  return config?.logging?.providerEvents === true;
}
