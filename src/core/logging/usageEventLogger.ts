import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderType } from '../../shared/types/provider.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import { USAGE_EVENTS_LOG_FILE_SUFFIX } from './contracts.js';
import {
  buildUsageEventRecord,
  type MovementType,
} from './providerEvent.js';

export interface UsageEventLoggerConfig {
  readonly logsDir: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly provider: ProviderType;
  readonly providerModel: string;
  readonly movement: string;
  readonly movementType: MovementType;
  readonly enabled: boolean;
}

export interface UsageEventLogger {
  readonly filepath: string;
  setMovement(movement: string, movementType: MovementType): void;
  setProvider(provider: ProviderType, providerModel: string): void;
  logUsage(params: {
    readonly success: boolean;
    readonly usage: ProviderUsageSnapshot;
    readonly timestamp?: Date;
  }): void;
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
    assertNonEmpty(config.providerModel, 'providerModel');
    assertNonEmpty(config.movement, 'movement');
  }

  const filepath = join(config.logsDir, `${config.sessionId}${USAGE_EVENTS_LOG_FILE_SUFFIX}`);
  let movement = config.movement;
  let movementType = config.movementType;
  let provider = config.provider;
  let providerModel = config.providerModel;
  let hasReportedWriteFailure = false;

  return {
    filepath,
    setMovement(nextMovement: string, nextMovementType: MovementType): void {
      assertNonEmpty(nextMovement, 'movement');
      movement = nextMovement;
      movementType = nextMovementType;
    },
    setProvider(nextProvider: ProviderType, nextProviderModel: string): void {
      assertNonEmpty(nextProviderModel, 'providerModel');
      provider = nextProvider;
      providerModel = nextProviderModel;
    },
    logUsage(params: {
      readonly success: boolean;
      readonly usage: ProviderUsageSnapshot;
      readonly timestamp?: Date;
    }): void {
      if (!config.enabled) {
        return;
      }

      const record = buildUsageEventRecord(
        {
          runId: config.runId,
          sessionId: config.sessionId,
          provider,
          providerModel,
          movement,
          movementType,
        },
        params
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
