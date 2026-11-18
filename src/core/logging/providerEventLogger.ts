import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderType, StreamEvent } from '../../shared/types/provider.js';
import { PROVIDER_EVENTS_LOG_FILE_SUFFIX } from './contracts.js';
import { normalizeProviderEvent, type ProviderEventLogRecord } from './providerEvent.js';
import { getExecutionSecrets } from '../../shared/utils/execution-secrets.js';
import { createSensitiveTextStreamRedactor, type SensitiveTextStreamRedactor } from '../../shared/utils/sensitiveText.js';

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
  flush(): void;
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
  const streams = new Map<string, { context: ProviderEventLogContext; record: ProviderEventLogRecord;
    field: string; redactor: SensitiveTextStreamRedactor }>();

  const reportFailure = (error: unknown): void => {
    if (hasReportedWriteFailure) return;
    hasReportedWriteFailure = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[takt] Failed to write provider event log: ${message}\n`);
  };
  const persist = (record: ProviderEventLogRecord): void => {
    try { appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8'); }
    catch (error) { reportFailure(error); }
  };
  const flush = (context?: ProviderEventLogContext): void => {
    for (const [key, stream] of streams) {
      if (context !== undefined && (stream.context.provider !== context.provider
        || stream.context.providerModel !== context.providerModel || stream.context.step !== context.step)) continue;
      const credentials = getExecutionSecrets();
      const text = stream.redactor.flush({ credentials }, credentials);
      if (text.length > 0) persist({ ...stream.record, data: { ...stream.record.data, [stream.field]: text } });
      streams.delete(key);
    }
  };

  const write = (context: ProviderEventLogContext, event: StreamEvent): void => {
    try {
      const record = normalizeProviderEvent(
        event,
        context.provider,
        context.providerModel,
        context.step,
        config.runId,
      );
      const field = event.type === 'text' ? 'text' : event.type === 'thinking' ? 'thinking'
        : event.type === 'tool_output' ? 'output' : undefined;
      const text = field === undefined ? undefined : (event.data as unknown as Record<string, unknown>)[field];
      const credentials = getExecutionSecrets();
      if (field !== undefined && typeof text === 'string' && credentials.length > 0) {
        const key = JSON.stringify([context.provider, context.providerModel, context.step, event.type,
          event.type === 'tool_output' ? event.data.id : undefined]);
        const redactor = streams.get(key)?.redactor ?? createSensitiveTextStreamRedactor();
        let sanitized = '';
        // Feed bounded pieces so a large legitimate event does not exhaust the pending buffer.
        for (let offset = 0; offset < text.length; offset += 1024) {
          sanitized += redactor.write(text.slice(offset, offset + 1024), { credentials }, credentials);
        }
        record.data[field] = sanitized;
        streams.set(key, { context: { ...context }, record, field, redactor });
      } else if (event.type === 'result' || event.type === 'error' || event.type === 'assistant_error') flush(context);
      persist(record);
    } catch (error) {
      reportFailure(error);
    }
  };

  return {
    filepath,
    flush: () => flush(),
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
