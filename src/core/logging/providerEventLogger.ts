import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderType, StreamCallback, StreamEvent } from '../../shared/types/provider.js';
import { PROVIDER_EVENTS_LOG_FILE_SUFFIX } from './contracts.js';
import { normalizeProviderEvent } from './providerEvent.js';

export interface ProviderEventLoggerConfig {
  logsDir: string;
  sessionId: string;
  runId: string;
  provider: ProviderType;
  movement: string;
  enabled: boolean;
}

export interface ProviderEventLogger {
  readonly filepath: string;
  setMovement(movement: string): void;
  setProvider(provider: ProviderType): void;
  wrapCallback(original?: StreamCallback): StreamCallback;
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
    assertNonEmpty(config.movement, 'movement');
  }

  const filepath = join(config.logsDir, `${config.sessionId}${PROVIDER_EVENTS_LOG_FILE_SUFFIX}`);
  let movement = config.movement;
  let provider = config.provider;
  let hasReportedWriteFailure = false;

  const write = (event: StreamEvent): void => {
    const record = normalizeProviderEvent(event, provider, movement, config.runId);
    try {
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
    setMovement(nextMovement: string): void {
      assertNonEmpty(nextMovement, 'movement');
      movement = nextMovement;
    },
    setProvider(nextProvider: ProviderType): void {
      provider = nextProvider;
    },
    wrapCallback(original?: StreamCallback): StreamCallback {
      if (!config.enabled && original) {
        return original;
      }
      if (!config.enabled) {
        return () => {};
      }

      return (event: StreamEvent): void => {
        write(event);
        original?.(event);
      };
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
