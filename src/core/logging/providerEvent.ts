import type { ProviderType, StreamEvent } from '../../shared/types/provider.js';
import { normalizeLogMetadata, normalizeLogValue } from '../../shared/utils/logMetadata.js';

export interface ProviderEventLogRecord {
  timestamp: string;
  provider: ProviderType;
  provider_model: string;
  event_type: string;
  run_id: string;
  step: string;
  session_id?: string;
  message_id?: string;
  call_id?: string;
  request_id?: string;
  data: Record<string, unknown>;
}

const TRUNCATED_MARKER = '...[truncated]';
const MAX_SERIALIZED_RECORD_LENGTH = 50_000;

function sanitizeEventData(event: StreamEvent): Record<string, unknown> {
  const serialized = JSON.stringify(event.data, normalizeLogValue);
  if (serialized === undefined) {
    throw new Error('Provider event data is not serializable');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function normalizeProviderEvent(
  event: StreamEvent,
  provider: ProviderType,
  providerModel: string,
  step: string,
  runId: string,
): ProviderEventLogRecord {
  const data = sanitizeEventData(event);
  const sessionId = pickString(data, ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']);
  const messageId = pickString(data, ['message_id', 'messageId', 'item_id', 'itemId']);
  const callId = pickString(data, ['call_id', 'callId', 'id']);
  const requestId = pickString(data, ['request_id', 'requestId']);
  const record: ProviderEventLogRecord = {
    timestamp: new Date().toISOString(),
    provider,
    provider_model: normalizeLogMetadata(providerModel),
    event_type: normalizeLogMetadata(event.type),
    run_id: normalizeLogMetadata(runId),
    step: normalizeLogMetadata(step),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(messageId !== undefined ? { message_id: messageId } : {}),
    ...(callId !== undefined ? { call_id: callId } : {}),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    data,
  };
  if (JSON.stringify(record).length <= MAX_SERIALIZED_RECORD_LENGTH) {
    return record;
  }
  const truncatedRecord = {
    ...record,
    data: { __takt_truncated__: TRUNCATED_MARKER },
  };
  if (JSON.stringify(truncatedRecord).length > MAX_SERIALIZED_RECORD_LENGTH) {
    throw new Error(`Provider event record exceeds ${MAX_SERIALIZED_RECORD_LENGTH} serialized characters`);
  }
  return truncatedRecord;
}
