import { createHash } from 'node:crypto';
import type { ProviderType, StreamEvent } from '../../shared/types/provider.js';
import type { ProviderTypeOrAuto } from '../models/config-types.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import { USAGE_MISSING_REASONS, type UsageMissingReason } from './contracts.js';
import {
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValue,
  sanitizeSensitiveValueWithKnownValues,
} from '../../shared/utils/sensitiveText.js';

export type StepType = 'normal' | 'parallel' | 'arpeggio' | 'team_leader' | 'workflow_call';

export interface ProviderEventLogRecord {
  timestamp: string;
  provider: ProviderTypeOrAuto;
  event_type: string;
  run_id: string;
  step: string;
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
  step: string;
  step_type: StepType;
  timestamp: string;
  success: boolean;
  usage_missing: boolean;
  reason?: UsageMissingReason;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export type UsageEventPayload = Pick<UsageEventLogRecord, 'usage_missing' | 'reason' | 'usage'>;

interface UsageEventMeta {
  runId: string;
  sessionId: string;
  provider: ProviderType;
  providerModel: string;
  step: string;
  stepType: StepType;
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

function sanitizeData(
  eventType: StreamEvent['type'],
  data: Record<string, unknown>,
  knownSensitiveSource: unknown,
): Record<string, unknown> {
  const sanitized = eventType === 'tool_use'
    ? {
      ...data,
      input: sanitizeSensitiveValueWithKnownValues(data['input'], knownSensitiveSource),
    }
    : eventType === 'tool_result' || eventType === 'tool_output'
      ? sanitizeSensitiveValueWithKnownValues(data, knownSensitiveSource) as Record<string, unknown>
      : eventType === 'result'
        ? {
          ...data,
          ...(typeof data['result'] === 'string'
            ? { result: sanitizeSensitiveTextWithKnownValues(data['result'], knownSensitiveSource) }
            : {}),
          ...(typeof data['error'] === 'string'
            ? { error: sanitizeSensitiveTextWithKnownValues(data['error'], knownSensitiveSource) }
            : {}),
        }
        : eventType === 'text'
          || eventType === 'thinking'
          || eventType === 'error'
      || eventType === 'assistant_error'
          ? Object.fromEntries(Object.entries(data).map(([key, value]) => [
            key,
            typeof value === 'string'
              ? sanitizeSensitiveTextWithKnownValues(value, knownSensitiveSource)
              : value,
          ]))
      : eventType === 'permission_asked'
        ? {
          ...data,
          permission: sanitizeSensitiveValue(data['permission']),
          patterns: sanitizeSensitiveValue(data['patterns']),
          always: sanitizeSensitiveValue(data['always']),
        }
        : data;
  const fullySanitized = sanitizeSensitiveValueWithKnownValues(
    sanitized,
    knownSensitiveSource,
  ) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(fullySanitized).map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, truncateString(value)];
      }
      return [key, value];
    })
  );
}

function correlateProviderIdentifier(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  provider: ProviderTypeOrAuto,
  step: string,
  runId: string,
  knownSensitiveSource: unknown,
): ProviderEventLogRecord {
  const rawData = event.data as unknown as Record<string, unknown>;
  const sessionId = pickString(rawData, ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']);
  const messageId = pickString(rawData, ['message_id', 'messageId', 'item_id', 'itemId']);
  const callId = pickString(rawData, ['call_id', 'callId', 'id']);
  const requestId = pickString(rawData, ['request_id', 'requestId']);
  const data = sanitizeData(event.type, rawData, knownSensitiveSource);

  return {
    timestamp: new Date().toISOString(),
    provider,
    event_type: event.type,
    run_id: runId,
    step,
    ...(sessionId ? { session_id: correlateProviderIdentifier(sessionId) } : {}),
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
  const payload = buildUsageEventPayload(params.usage);
  return {
    run_id: meta.runId,
    session_id: meta.sessionId,
    provider: meta.provider,
    provider_model: meta.providerModel,
    step: meta.step,
    step_type: meta.stepType,
    timestamp: (params.timestamp ?? new Date()).toISOString(),
    success: params.success,
    ...payload,
  };
}

export function buildUsageEventPayload(usageSnapshot: ProviderUsageSnapshot): UsageEventPayload {
  if (usageSnapshot.usageMissing) {
    if (typeof usageSnapshot.reason !== 'string' || usageSnapshot.reason.length === 0) {
      throw new Error('[usage-events] reason is required when usageMissing=true');
    }
    return {
      usage_missing: true,
      reason: assertUsageMissingReason(usageSnapshot.reason),
      usage: {},
    };
  }

  assertFiniteNumber(usageSnapshot.inputTokens, 'usage.inputTokens');
  assertFiniteNumber(usageSnapshot.outputTokens, 'usage.outputTokens');
  assertFiniteNumber(usageSnapshot.totalTokens, 'usage.totalTokens');

  const usage = {
    input_tokens: usageSnapshot.inputTokens,
    output_tokens: usageSnapshot.outputTokens,
    total_tokens: usageSnapshot.totalTokens,
    ...(Number.isFinite(usageSnapshot.cachedInputTokens)
      ? { cached_input_tokens: usageSnapshot.cachedInputTokens }
      : {}),
    ...(Number.isFinite(usageSnapshot.cacheCreationInputTokens)
      ? { cache_creation_input_tokens: usageSnapshot.cacheCreationInputTokens }
      : {}),
    ...(Number.isFinite(usageSnapshot.cacheReadInputTokens)
      ? { cache_read_input_tokens: usageSnapshot.cacheReadInputTokens }
      : {}),
  };

  return {
    usage_missing: false,
    usage,
  };
}
