import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderType, StreamCallback, StreamEvent } from '../../core/piece/index.js';

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

interface ProviderEventLogRecord {
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

function buildLogRecord(
  event: StreamEvent,
  provider: ProviderType,
  movement: string,
  runId: string,
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

export function createProviderEventLogger(config: ProviderEventLoggerConfig): ProviderEventLogger {
  const filepath = join(config.logsDir, `${config.sessionId}-provider-events.jsonl`);
  let movement = config.movement;
  let provider = config.provider;

  const write = (event: StreamEvent): void => {
    try {
      const record = buildLogRecord(event, provider, movement, config.runId);
      appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // Silently fail - observability logging should not interrupt main flow.
    }
  };

  return {
    filepath,
    setMovement(nextMovement: string): void {
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
  observability?: {
    providerEvents?: boolean;
  };
}): boolean {
  return config?.observability?.providerEvents === true;
}
