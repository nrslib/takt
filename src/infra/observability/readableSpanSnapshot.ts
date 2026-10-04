import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { SpanSnapshot } from '../../core/logging/span-to-ndjson-mapper.js';

export function readableSpanSnapshot(span: ReadableSpan): SpanSnapshot {
  return {
    name: span.name,
    attributes: span.attributes,
    startTime: span.startTime,
    endTime: span.endTime,
  };
}
