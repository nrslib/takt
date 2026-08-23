import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { recordTokenUsageMetricsFromSpan } from '../../core/workflow/observability/workflowMetrics.js';
import { estimateProviderTokenCostUsd } from '../providers/tokenCost.js';
import { readableSpanSnapshot } from './readableSpanSnapshot.js';

export class WorkflowMetricsSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    recordTokenUsageMetricsFromSpan(readableSpanSnapshot(span), estimateProviderTokenCostUsd);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
