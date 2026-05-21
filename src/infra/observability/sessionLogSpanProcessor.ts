import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { appendNdjsonLine, type NdjsonRecord, type NdjsonWorkflowStart } from '../fs/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import {
  mapSpanEndToNdjson,
  mapSpanStartToNdjson,
  type SpanSnapshot,
} from '../../core/logging/span-to-ndjson-mapper.js';

const log = createLogger('session-log-span-processor');

export interface SessionLogSpanProcessorOptions {
  shadowLogPath: string;
  sanitizedTask: string;
  workflowName: string;
}

export class SessionLogSpanProcessor implements SpanProcessor {
  private readonly shadowLogPath: string;

  constructor(options: SessionLogSpanProcessorOptions) {
    this.shadowLogPath = options.shadowLogPath;
    const startRecord: NdjsonWorkflowStart = {
      type: 'workflow_start',
      task: options.sanitizedTask,
      workflowName: options.workflowName,
      startTime: new Date().toISOString(),
    };
    this.safeAppend(startRecord);
  }

  onStart(span: Span, _parentContext: Context): void {
    const record = mapSpanStartToNdjson(toSpanSnapshot(span));
    this.safeAppend(record);
  }

  onEnd(span: ReadableSpan): void {
    const record = mapSpanEndToNdjson(toSpanSnapshot(span));
    this.safeAppend(record);
  }

  private safeAppend(record: NdjsonRecord | undefined): void {
    if (!record) {
      return;
    }
    try {
      appendNdjsonLine(this.shadowLogPath, record);
    } catch (error) {
      log.error('Failed to append shadow session log record', {
        shadowLogPath: this.shadowLogPath,
        recordType: record.type,
        error,
      });
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

function toSpanSnapshot(span: ReadableSpan): SpanSnapshot {
  return {
    name: span.name,
    attributes: span.attributes,
    startTime: span.startTime,
    endTime: span.endTime,
  };
}
