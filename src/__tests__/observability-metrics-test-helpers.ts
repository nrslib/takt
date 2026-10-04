import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

export interface CapturedMetricPoint {
  name: string;
  attributes: Record<string, unknown>;
  value: unknown;
}

export async function collectMetricPoints(
  run: () => Promise<void> | void,
): Promise<CapturedMetricPoint[]> {
  metrics.disable();

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
    await run();
    await provider.forceFlush();
    return flattenMetricPoints(exported);
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
}

export function metricPoint(
  points: CapturedMetricPoint[],
  name: string,
  expectedAttributes: Record<string, unknown>,
): CapturedMetricPoint | undefined {
  return points.find((point) =>
    point.name === name
    && Object.entries(expectedAttributes).every(([key, value]) => point.attributes[key] === value)
  );
}

function flattenMetricPoints(resourceMetrics: ResourceMetrics[]): CapturedMetricPoint[] {
  return resourceMetrics.flatMap((resourceMetric) =>
    resourceMetric.scopeMetrics.flatMap((scopeMetric) =>
      scopeMetric.metrics.flatMap((metric) =>
        metric.dataPoints.map((point) => ({
          name: metric.descriptor.name,
          attributes: point.attributes,
          value: point.value,
        }))
      )
    )
  );
}
