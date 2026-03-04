import type { ProviderType, StreamEvent } from '../../shared/types/provider.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import { USAGE_MISSING_REASONS, type UsageMissingReason } from './contracts.js';

export type MovementType = 'normal' | 'parallel' | 'arpeggio' | 'team_leader';

export interface ProviderEventLogRecord {
  timestamp: string;
  provider: ProviderType;
  event_type: string;
  run_id: string;
  movement: string;
  session_id?: string;
  message_id?: string;
  call_id?: string;
  request_id?: string;
  data: Record<string, unknown>;
}

export interface UsageEventLogRecord {
  run_id: string;
  session_id: string;
  provider: ProviderType;
  provider_model: string;
  movement: string;
  movement_type: MovementType;
  timestamp: string;
  success: boolean;
  usage_missing: boolean;
  reason?: UsageMissingReason;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number;
  };
}

interface UsageEventMeta {
  runId: string;
  sessionId: string;
  provider: ProviderType;
  providerModel: string;
  movement: string;
  movementType: MovementType;
}

interface BuildUsageRecordParams {
  success: boolean;
  usage: ProviderUsageSnapshot;
  timestamp?: Date;
}

const MAX_TEXT_LENGTH = 10_000;
const HEAD_LENGTH = 5_000;
const TAIL_LENGTH = 2_000;
const TRUNCATED_MARKER = '...[truncated]';

function truncateString(value: string): string {
  if (value.length <= MAX_TEXT_LENGTH) {
    return value;
  }
  return value.slice(0, HEAD_LENGTH) + TRUNCATED_MARKER + value.slice(-TAIL_LENGTH);
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, truncateString(value)];
      }
      return [key, value];
    })
  );
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function assertFiniteNumber(value: number | undefined, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`[usage-events] ${field} is required`);
  }
}

function assertUsageMissingReason(value: string): UsageMissingReason {
  for (const reason of Object.values(USAGE_MISSING_REASONS)) {
    if (value === reason) {
      return value;
    }
  }
  throw new Error('[usage-events] reason is invalid');
}

export function normalizeProviderEvent(
  event: StreamEvent,
  provider: ProviderType,
  movement: string,
  runId: string
): ProviderEventLogRecord {
  const data = sanitizeData(event.data as unknown as Record<string, unknown>);
  const sessionId = pickString(data, ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']);
  const messageId = pickString(data, ['message_id', 'messageId', 'item_id', 'itemId']);
  const callId = pickString(data, ['call_id', 'callId', 'id']);
  const requestId = pickString(data, ['request_id', 'requestId']);

  return {
    timestamp: new Date().toISOString(),
    provider,
    event_type: event.type,
    run_id: runId,
    movement,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    ...(callId ? { call_id: callId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    data,
  };
}

export function buildUsageEventRecord(
  meta: UsageEventMeta,
  params: BuildUsageRecordParams
): UsageEventLogRecord {
  if (params.usage.usageMissing) {
    if (typeof params.usage.reason !== 'string' || params.usage.reason.length === 0) {
      throw new Error('[usage-events] reason is required when usageMissing=true');
    }
    return {
      run_id: meta.runId,
      session_id: meta.sessionId,
      provider: meta.provider,
      provider_model: meta.providerModel,
      movement: meta.movement,
      movement_type: meta.movementType,
      timestamp: (params.timestamp ?? new Date()).toISOString(),
      success: params.success,
      usage_missing: true,
      reason: assertUsageMissingReason(params.usage.reason),
      usage: {},
    };
  }

  assertFiniteNumber(params.usage.inputTokens, 'usage.inputTokens');
  assertFiniteNumber(params.usage.outputTokens, 'usage.outputTokens');
  assertFiniteNumber(params.usage.totalTokens, 'usage.totalTokens');

  const usage = {
    input_tokens: params.usage.inputTokens,
    output_tokens: params.usage.outputTokens,
    total_tokens: params.usage.totalTokens,
    ...(Number.isFinite(params.usage.cachedInputTokens)
      ? { cached_input_tokens: params.usage.cachedInputTokens }
      : {}),
  };

  return {
    run_id: meta.runId,
    session_id: meta.sessionId,
    provider: meta.provider,
    provider_model: meta.providerModel,
    movement: meta.movement,
    movement_type: meta.movementType,
    timestamp: (params.timestamp ?? new Date()).toISOString(),
    success: params.success,
    usage_missing: false,
    usage,
  };
}
