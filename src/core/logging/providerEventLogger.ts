import { join } from 'node:path';
import type { ProviderType, StreamCallback, StreamEvent } from '../../shared/types/provider.js';
import type { ProviderTypeOrAuto } from '../models/config-types.js';
import { PROVIDER_EVENTS_LOG_FILE_SUFFIX } from './contracts.js';
import { normalizeProviderEvent } from './providerEvent.js';
import {
  createSensitiveTextStreamRedactor,
  createBoundedSensitiveValues,
  type SensitiveTextStreamRedactor,
} from '../../shared/utils/sensitiveText.js';
import { existsSync } from 'node:fs';
import { appendPrivateFile, repairPrivateDirectory } from '../../shared/utils/private-file.js';

export interface ProviderEventLoggerConfig {
  logsDir: string;
  sessionId: string;
  runId: string;
  provider: ProviderTypeOrAuto;
  step: string;
  enabled: boolean;
}

export interface ProviderEventLogger {
  readonly filepath: string;
  setStep(step: string): void;
  setProvider(provider: ProviderType): void;
  flush(): void;
  wrapCallback(original?: StreamCallback): StreamCallback;
}

export const PROVIDER_EVENT_STREAM_LIMIT = 1_024;

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
    assertNonEmpty(config.step, 'step');
    if (existsSync(config.logsDir)) {
      repairPrivateDirectory(config.logsDir);
    }
  }

  const filepath = join(config.logsDir, `${config.sessionId}${PROVIDER_EVENTS_LOG_FILE_SUFFIX}`);
  let step = config.step;
  let provider: ProviderTypeOrAuto = config.provider;
  let hasReportedWriteFailure = false;
  const stepSensitiveSources = createBoundedSensitiveValues();
  const streamRedactors = new Map<string, {
    redactor: SensitiveTextStreamRedactor;
    event: StreamEvent;
    field: 'text' | 'thinking';
  }>();

  const sensitiveSourceFor = (event: StreamEvent): unknown => {
    if (event.type === 'tool_use') {
      return event.data.input;
    }
    return stepSensitiveSources;
  };

  const advanceState = (event: StreamEvent): void => {
    if (event.type === 'tool_use') {
      stepSensitiveSources.add(event.data.input);
    } else if (event.type === 'result') {
      stepSensitiveSources.reset();
    }
  };

  const writeRecord = (event: StreamEvent): void => {
    const record = normalizeProviderEvent(event, provider, step, config.runId, sensitiveSourceFor(event));
    try {
      appendPrivateFile(filepath, JSON.stringify(record) + '\n');
    } catch (error) {
      if (!hasReportedWriteFailure) {
        hasReportedWriteFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[takt] Failed to write provider event log: ${message}\n`);
      }
    }
  };

  const writeStreamChunk = (event: StreamEvent): boolean => {
    const data = event.data as unknown as Record<string, unknown>;
    const field = event.type === 'text'
      ? 'text'
      : event.type === 'thinking'
        ? 'thinking'
        : undefined;
    if (field === undefined || typeof data[field] !== 'string') {
      return false;
    }
    const streamId = `${event.type}:${String(data['messageId'] ?? data['id'] ?? '')}`;
    let stream = streamRedactors.get(streamId);
    if (stream === undefined && streamRedactors.size >= PROVIDER_EVENT_STREAM_LIMIT) {
      streamRedactors.clear();
      stepSensitiveSources.exhaust();
    }
    stream ??= {
      redactor: createSensitiveTextStreamRedactor(),
      event,
      field,
    };
    stream.event = event;
    if (!stepSensitiveSources.exhausted) {
      streamRedactors.set(streamId, stream);
    }
    const text = stream.redactor.write(data[field], stepSensitiveSources);
    if (text.length > 0) {
      writeRecord({ ...event, data: { ...event.data, [field]: text } } as StreamEvent);
    }
    return true;
  };

  const flushStreams = (): void => {
    for (const stream of streamRedactors.values()) {
      const text = stream.redactor.flush(stepSensitiveSources);
      if (text.length > 0) {
        writeRecord({
          ...stream.event,
          data: { ...stream.event.data, [stream.field]: text },
        } as StreamEvent);
      }
    }
    streamRedactors.clear();
  };

  const write = (event: StreamEvent): void => {
    if (writeStreamChunk(event)) {
      return;
    }
    flushStreams();
    writeRecord(event);
    advanceState(event);
  };

  return {
    filepath,
    setStep(nextStep: string): void {
      assertNonEmpty(nextStep, 'step');
      flushStreams();
      step = nextStep;
      stepSensitiveSources.reset();
    },
    setProvider(nextProvider: ProviderType): void {
      flushStreams();
      provider = nextProvider;
    },
    flush(): void {
      flushStreams();
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
