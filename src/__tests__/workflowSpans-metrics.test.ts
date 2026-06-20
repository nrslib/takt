import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('workflow OpenTelemetry metrics', () => {
  afterEach(() => {
    metrics.disable();
    vi.resetModules();
  });

  it('records metrics when workflowSpans is imported before the meter provider is registered', async () => {
    metrics.disable();
    vi.resetModules();

    const workflowSpans = await import('../core/workflow/observability/workflowSpans.js');
    const exported: ResourceMetrics[] = [];
    const exporter: PushMetricExporter = {
      export(resourceMetrics, resultCallback) {
        exported.push(resourceMetrics);
        resultCallback({ code: 0 });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const provider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: 60_000,
        }),
      ],
    });

    metrics.setGlobalMeterProvider(provider);
    try {
      await workflowSpans.runWithWorkflowSpan({
        enabled: true,
        runId: 'run-late-provider',
        workflowName: 'test-workflow',
        initialStep: 'implement',
        stepCount: 1,
        maxSteps: 3,
        runMode: 'full',
        resumeDepth: 0,
      }, async () => 'ok', () => ({
        status: 'completed',
        iterations: 1,
      }));
      await provider.forceFlush();
    } finally {
      await provider.shutdown();
      metrics.disable();
    }

    const exportedMetrics = exported.flatMap((resourceMetrics) =>
      resourceMetrics.scopeMetrics.flatMap((scopeMetrics) => scopeMetrics.metrics)
    );
    const workflowRunMetric = exportedMetrics.find((metric) =>
      metric.descriptor.name === 'takt.workflow.runs'
    );
    const workflowDurationMetric = exportedMetrics.find((metric) =>
      metric.descriptor.name === 'takt.workflow.duration'
    );

    expect(workflowRunMetric?.dataPoints.some((point) =>
      point.attributes['takt.run.id'] === 'run-late-provider'
      && point.attributes['takt.workflow.status'] === 'completed'
    )).toBe(true);
    expect(workflowDurationMetric?.dataPoints.some((point) =>
      point.attributes['takt.run.id'] === 'run-late-provider'
      && point.attributes['takt.workflow.status'] === 'completed'
    )).toBe(true);
  });
});
