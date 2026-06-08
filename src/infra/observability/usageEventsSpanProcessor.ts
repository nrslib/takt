import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { appendJsonLine } from '../fs/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import {
  mapSpanEndToPhaseUsageEvent,
  type PhaseUsageEventLogRecord,
} from '../../core/logging/phaseUsageEvent.js';
import type { SpanSnapshot } from '../../core/logging/span-to-ndjson-mapper.js';

const log = createLogger('usage-events-span-processor');

export interface UsageEventsSpanProcessorOptions {
  runId: string;
  sessionId: string;
  phaseUsageLogPath: string;
}

export class UsageEventsSpanProcessor implements SpanProcessor {
  private readonly registrations = new Map<string, UsageEventsSpanProcessorOptions>();
  private readonly reportedWriteFailureRunIds = new Set<string>();

  constructor(options?: UsageEventsSpanProcessorOptions) {
    if (options) {
      this.register(options);
    }
  }

  register(options: UsageEventsSpanProcessorOptions): () => void {
    if (this.registrations.has(options.runId)) {
      log.warn('Ignoring duplicate phase usage event registration', {
        runId: options.runId,
        phaseUsageLogPath: options.phaseUsageLogPath,
      });
      return () => {};
    }
    this.registrations.set(options.runId, options);
    return () => {
      this.registrations.delete(options.runId);
      this.reportedWriteFailureRunIds.delete(options.runId);
    };
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const options = this.optionsForSpan(span);
    if (!options) {
      return;
    }
    const record = mapSpanEndToPhaseUsageEvent(toSpanSnapshot(span), {
      runId: options.runId,
      sessionId: options.sessionId,
    });
    this.safeAppend(options, record);
  }

  private optionsForSpan(span: ReadableSpan): UsageEventsSpanProcessorOptions | undefined {
    const runId = span.attributes['takt.run.id'];
    return typeof runId === 'string' ? this.registrations.get(runId) : undefined;
  }

  private safeAppend(options: UsageEventsSpanProcessorOptions, record: PhaseUsageEventLogRecord | undefined): void {
    if (!record) {
      return;
    }
    try {
      appendJsonLine(options.phaseUsageLogPath, record);
    } catch (error) {
      if (this.reportedWriteFailureRunIds.has(options.runId)) {
        return;
      }
      this.reportedWriteFailureRunIds.add(options.runId);
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to append phase usage event log record', {
        runId: options.runId,
        phaseUsageLogPath: options.phaseUsageLogPath,
        error: message,
      });
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.registrations.clear();
    this.reportedWriteFailureRunIds.clear();
  }
}

function toSpanSnapshot(span: ReadableSpan): SpanSnapshot {
  return {
    name: span.name,
    attributes: span.attributes,
    startTime: span.startTime,
    endTime: span.endTime,
  };
}
