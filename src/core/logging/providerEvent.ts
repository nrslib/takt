import type { ProviderType, StreamEvent } from '../../shared/types/provider.js';
import { normalizeLogMetadata, normalizeProviderEventValue } from '../../shared/utils/logMetadata.js';
import { redactExecutionSecrets, redactExecutionValue } from '../../shared/utils/execution-secrets.js';

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

export function normalizeProviderEventData(event: StreamEvent): Record<string, unknown> {
  const serialized = JSON.stringify(event.data, (key, value: unknown) => normalizeProviderEventValue(key, value, []));
  if (serialized === undefined) {
    throw new Error('Provider event data is not serializable');
  }
  const source = JSON.parse(serialized) as Record<string, unknown>;
  const data = redactExecutionValue(source);
  // These fields identify events and provider state; bodies and tool inputs remain redacted.
  for (const key of ['model', 'sessionId', 'session_id', 'sessionID', 'thread_id', 'threadId',
    'message_id', 'messageId', 'item_id', 'itemId', 'call_id', 'callId', 'id', 'completedToolIds',
    'request_id', 'requestId', 'tool', 'permission', 'reply', 'permissionMode', 'allowedTools',
    'failureCategory', 'status', 'rateLimitType', 'overageStatus']) {
    if (Object.hasOwn(source, key)) data[key] = source[key];
  }
  if (event.type === 'permission_summary') {
    const permissions = source.resolvedPermissions as typeof event.data.resolvedPermissions;
    data.resolvedPermissions = permissions.map((entry) => ({ ...entry, pattern: redactExecutionSecrets(entry.pattern) }));
  }
  return data;
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
  const data = normalizeProviderEventData(event);
  const sessionId = pickString(data, ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']);
  const messageId = pickString(data, ['message_id', 'messageId', 'item_id', 'itemId']);
  const callId = pickString(data, ['call_id', 'callId', 'id']);
  const requestId = pickString(data, ['request_id', 'requestId']);
  const record: ProviderEventLogRecord = {
    timestamp: new Date().toISOString(),
    provider,
    provider_model: normalizeLogMetadata(providerModel, []),
    event_type: normalizeLogMetadata(event.type, []),
    run_id: normalizeLogMetadata(runId, []),
    step: normalizeLogMetadata(step, []),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(messageId !== undefined ? { message_id: messageId } : {}),
    ...(callId !== undefined ? { call_id: callId } : {}),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    data,
  };
  return record;
}
