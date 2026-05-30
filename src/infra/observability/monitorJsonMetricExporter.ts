import { dirname } from 'node:path';
import type {
  AggregationTemporality,
  DataPoint,
  DataPointType,
  MetricData,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { ensureDir, writeFileAtomic } from '../config/index.js';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('monitor-json-metric-exporter');

export interface MonitorJsonMetricExporterOptions {
  runId: string;
  monitorPath: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export class MonitorJsonMetricExporter implements PushMetricExporter {
  private readonly registrations = new Map<string, MonitorJsonMetricExporterOptions>();
  private shutdownRequested = false;

  constructor(options?: MonitorJsonMetricExporterOptions) {
    if (options) {
      this.register(options);
    }
  }

  register(options: MonitorJsonMetricExporterOptions): () => void {
    if (this.registrations.has(options.runId)) {
      // A live run already owns this runId; keep it rather than redirect its
      // monitor.json output to a colliding path.
      log.warn('Ignoring duplicate monitor.json metric registration', {
        runId: options.runId,
        monitorPath: options.monitorPath,
      });
      return () => {};
    }
    this.registrations.set(options.runId, options);
    return () => {
      this.registrations.delete(options.runId);
    };
  }

  export(metrics: ResourceMetrics, resultCallback: Parameters<PushMetricExporter['export']>[1]): void {
    if (this.shutdownRequested) {
      resultCallback({ code: 1, error: new Error('MonitorJsonMetricExporter is shut down') });
      return;
    }

    for (const options of this.registrations.values()) {
      try {
        const filtered = filterResourceMetricsByRun(metrics, options.runId);
        if (filtered.scopeMetrics.length === 0) {
          continue;
        }
        ensureDir(dirname(options.monitorPath));
        writeFileAtomic(
          options.monitorPath,
          `${JSON.stringify(serializeResourceMetrics(filtered), null, 2)}\n`,
        );
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        log.error('Failed to write monitor.json metrics', {
          runId: options.runId,
          error: wrapped.message,
        });
      }
    }
    resultCallback({ code: 0 });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.registrations.clear();
  }
}

function filterResourceMetricsByRun(metrics: ResourceMetrics, runId: string): ResourceMetrics {
  return {
    ...metrics,
    scopeMetrics: metrics.scopeMetrics
      .map((scopeMetrics) => ({
        ...scopeMetrics,
        metrics: scopeMetrics.metrics
          .map((metric) => ({
            ...metric,
            dataPoints: metric.dataPoints.filter((point) => point.attributes['takt.run.id'] === runId),
          }))
          .filter((metric) => metric.dataPoints.length > 0) as MetricData[],
      }))
      .filter((scopeMetrics) => scopeMetrics.metrics.length > 0),
  };
}

function serializeResourceMetrics(metrics: ResourceMetrics): JsonValue {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    resource: toJsonObject(metrics.resource.attributes ?? {}),
    scopeMetrics: metrics.scopeMetrics.map((scopeMetrics) => ({
      scope: {
        name: scopeMetrics.scope.name,
        ...(scopeMetrics.scope.version ? { version: scopeMetrics.scope.version } : {}),
      },
      metrics: scopeMetrics.metrics.map(serializeMetricData),
    })),
  };
}

function serializeMetricData(metric: MetricData): JsonValue {
  return {
    name: metric.descriptor.name,
    description: metric.descriptor.description,
    unit: metric.descriptor.unit,
    dataPointType: dataPointTypeName(metric.dataPointType),
    aggregationTemporality: aggregationTemporalityName(metric.aggregationTemporality),
    ...('isMonotonic' in metric ? { isMonotonic: metric.isMonotonic } : {}),
    points: metric.dataPoints.map(serializeDataPoint),
  };
}

function serializeDataPoint(point: DataPoint<unknown>): JsonValue {
  return {
    startTime: hrTimeToIso(point.startTime),
    endTime: hrTimeToIso(point.endTime),
    attributes: toJsonObject(point.attributes),
    value: toJsonValue(point.value),
  };
}

function dataPointTypeName(type: DataPointType): string {
  switch (type) {
    case 0:
      return 'histogram';
    case 1:
      return 'exponential_histogram';
    case 2:
      return 'gauge';
    case 3:
      return 'sum';
    default:
      return String(type);
  }
}

function aggregationTemporalityName(temporality: AggregationTemporality): string {
  switch (temporality) {
    case 0:
      return 'delta';
    case 1:
      return 'cumulative';
    default:
      return String(temporality);
  }
}

function hrTimeToIso(time: readonly [number, number]): string {
  const [seconds, nanoseconds] = time;
  return new Date((seconds * 1000) + Math.floor(nanoseconds / 1_000_000)).toISOString();
}

function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = toJsonValue(item);
  }
  return result;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === 'object' && value !== null) {
    return toJsonObject(value as Record<string, unknown>);
  }
  return String(value);
}
