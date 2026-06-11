import { createRequire } from 'node:module';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { IMetricReader } from '@opentelemetry/sdk-metrics';
import type { ResolvedObservabilityConfig } from '../../core/models/config-types.js';
import {
  resolveOtlpExporterConfigFromEnv,
  type EnabledOtlpExporterConfig,
  type OtlpExporterConfig,
} from '../../shared/telemetry/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import { SessionLogSpanProcessor, type SessionLogSpanProcessorOptions } from './sessionLogSpanProcessor.js';
import { MonitorJsonMetricExporter, type MonitorJsonMetricExporterOptions } from './monitorJsonMetricExporter.js';
import { UsageEventsSpanProcessor, type UsageEventsSpanProcessorOptions } from './usageEventsSpanProcessor.js';

const require = createRequire(import.meta.url);
const { version: TAKT_VERSION } = require('../../../package.json') as { version: string };
const log = createLogger('otel-foundation');

type OtelSdk = {
  start(): void;
  shutdown(): Promise<void>;
};

type SharedOtelSdk = {
  sdk: OtelSdk;
  refCount: number;
  metricReaders: IMetricReader[];
  nonBlockingMetricReaders: IMetricReader[];
  sessionLogSpanProcessor?: SessionLogSpanProcessor;
  usageEventsSpanProcessor?: UsageEventsSpanProcessor;
  monitorJsonMetricExporter?: MonitorJsonMetricExporter;
};

type StartedOtelSdk = Omit<SharedOtelSdk, 'refCount'>;

export type OtelFoundationHandle = {
  shutdown(): Promise<void>;
};

export interface OtelFoundationOptions {
  sessionLogExporter?: SessionLogSpanProcessorOptions;
  usageEventsExporter?: UsageEventsSpanProcessorOptions;
  monitorJsonExporter?: MonitorJsonMetricExporterOptions;
}

type OtelRegistration = () => void;

let activeSdk: SharedOtelSdk | undefined;
let startingSdk: Promise<SharedOtelSdk> | undefined;
let stoppingSdk: Promise<void> | undefined;

export async function initializeOtelFoundation(
  config: ResolvedObservabilityConfig,
  options: OtelFoundationOptions | undefined = undefined,
): Promise<OtelFoundationHandle> {
  const otlpConfig = resolveOtlpExporterConfigFromEnv(config.enabled);
  if (!config.enabled) {
    return createNoopHandle();
  }
  validateRunScopedExporterIds(options);

  const shared = await acquireSdk(otlpConfig);
  let registrations: OtelRegistration[];
  try {
    registrations = registerRunExporters(shared, options);
  } catch (error) {
    await releaseSdk(shared);
    throw error;
  }

  let released = false;
  return {
    async shutdown(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      try {
        if (shared.metricReaders.length > 0) {
          await forceFlushMetricReaders(shared.metricReaders, shared.nonBlockingMetricReaders);
        }
      } finally {
        for (const unregister of registrations.splice(0).reverse()) {
          unregister();
        }
        await releaseSdk(shared);
      }
    },
  };
}

async function acquireSdk(otlpConfig: OtlpExporterConfig): Promise<SharedOtelSdk> {
  if (stoppingSdk) {
    await stoppingSdk;
  }

  if (activeSdk) {
    activeSdk.refCount += 1;
    return activeSdk;
  }

  const shared = await getOrStartSdk(otlpConfig);
  shared.refCount += 1;
  return shared;
}

function createNoopHandle(): OtelFoundationHandle {
  return {
    async shutdown(): Promise<void> {},
  };
}

async function getOrStartSdk(otlpConfig: OtlpExporterConfig): Promise<SharedOtelSdk> {
  if (activeSdk) {
    return activeSdk;
  }
  if (!startingSdk) {
    startingSdk = startSdk(otlpConfig).then(
      (started) => {
        const shared = { ...started, refCount: 0 };
        activeSdk = shared;
        startingSdk = undefined;
        return shared;
      },
      (error: unknown) => {
        startingSdk = undefined;
        throw error;
      },
    );
  }
  return startingSdk;
}

function registerRunExporters(
  shared: SharedOtelSdk,
  options: OtelFoundationOptions | undefined,
): OtelRegistration[] {
  const registrations: OtelRegistration[] = [];
  try {
    if (options?.sessionLogExporter && shared.sessionLogSpanProcessor) {
      registrations.push(shared.sessionLogSpanProcessor.register(options.sessionLogExporter));
    }
    if (options?.usageEventsExporter && shared.usageEventsSpanProcessor) {
      registrations.push(shared.usageEventsSpanProcessor.register(options.usageEventsExporter));
    }
    if (options?.monitorJsonExporter && shared.monitorJsonMetricExporter) {
      registrations.push(shared.monitorJsonMetricExporter.register(options.monitorJsonExporter));
    }
  } catch (error) {
    unregisterAll(registrations);
    throw error;
  }
  return registrations;
}

function validateRunScopedExporterIds(options: OtelFoundationOptions | undefined): void {
  const runIds = [
    options?.sessionLogExporter?.runId,
    options?.usageEventsExporter?.runId,
    options?.monitorJsonExporter?.runId,
  ].filter((runId): runId is string => typeof runId === 'string');
  const uniqueRunIds = new Set(runIds);
  if (uniqueRunIds.size > 1) {
    throw new Error('Run-scoped OpenTelemetry exporters must share the same runId');
  }
}

function unregisterAll(registrations: OtelRegistration[]): void {
  for (const unregister of registrations.splice(0).reverse()) {
    unregister();
  }
}

async function createSpanProcessorState(otlpConfig: OtlpExporterConfig): Promise<{
  spanProcessors: SpanProcessor[];
  sessionLogSpanProcessor: SessionLogSpanProcessor;
  usageEventsSpanProcessor: UsageEventsSpanProcessor;
}> {
  const sessionLogSpanProcessor = new SessionLogSpanProcessor();
  const usageEventsSpanProcessor = new UsageEventsSpanProcessor();
  const spanProcessors: SpanProcessor[] = [sessionLogSpanProcessor, usageEventsSpanProcessor];
  if (otlpConfig.enabled) {
    spanProcessors.push(await createOtlpSpanProcessor(otlpConfig));
  }
  return {
    spanProcessors,
    sessionLogSpanProcessor,
    usageEventsSpanProcessor,
  };
}

async function createOtlpSpanProcessor(otlpConfig: EnabledOtlpExporterConfig): Promise<SpanProcessor> {
  const [{ OTLPTraceExporter }, { BatchSpanProcessor }] = await Promise.all([
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/sdk-trace-base'),
  ]);
  return new NonBlockingSpanProcessor(
    new BatchSpanProcessor(new OTLPTraceExporter({ url: otlpConfig.traces.endpoint })),
  );
}

class NonBlockingSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(...args: Parameters<SpanProcessor['onStart']>): void {
    this.delegate.onStart(...args);
  }

  onEnd(...args: Parameters<SpanProcessor['onEnd']>): void {
    this.delegate.onEnd(...args);
  }

  async forceFlush(): Promise<void> {
    await continueOnNonBlockingSpanProcessorFailure('forceFlush', () => this.delegate.forceFlush());
  }

  async shutdown(): Promise<void> {
    await continueOnNonBlockingSpanProcessorFailure('shutdown', () => this.delegate.shutdown());
  }
}

async function continueOnNonBlockingSpanProcessorFailure(
  operation: 'forceFlush' | 'shutdown',
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log.warn(`Non-blocking OpenTelemetry span processor ${operation} failed; continuing shutdown`, {
      errorType: getErrorType(error),
    });
  }
}

async function createMetricReaders(otlpConfig: OtlpExporterConfig): Promise<{
  metricReaders: IMetricReader[];
  nonBlockingMetricReaders: IMetricReader[];
  monitorJsonMetricExporter: MonitorJsonMetricExporter;
}> {
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
  const monitorJsonMetricExporter = new MonitorJsonMetricExporter();
  const metricReaders: IMetricReader[] = [
    new PeriodicExportingMetricReader({
      exporter: monitorJsonMetricExporter,
      exportIntervalMillis: 1000,
    }),
  ];
  const nonBlockingMetricReaders: IMetricReader[] = [];
  if (otlpConfig.enabled) {
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const otlpMetricReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: otlpConfig.metrics.endpoint }),
    });
    metricReaders.push(otlpMetricReader);
    nonBlockingMetricReaders.push(otlpMetricReader);
  }
  return {
    metricReaders,
    nonBlockingMetricReaders,
    monitorJsonMetricExporter,
  };
}

async function startSdk(otlpConfig: OtlpExporterConfig): Promise<StartedOtelSdk> {
  const { spanProcessors, sessionLogSpanProcessor, usageEventsSpanProcessor } = await createSpanProcessorState(otlpConfig);
  const { metricReaders, nonBlockingMetricReaders, monitorJsonMetricExporter } = await createMetricReaders(otlpConfig);
  const { NodeSDK, resources } = await import('@opentelemetry/sdk-node');
  const sdk = new NodeSDK({
    autoDetectResources: false,
    instrumentations: [],
    logRecordProcessors: [],
    metricReaders,
    resource: resources.resourceFromAttributes({
      'service.name': 'takt',
      'service.version': TAKT_VERSION,
    }),
    spanProcessors,
  });
  sdk.start();
  return {
    sdk,
    metricReaders,
    nonBlockingMetricReaders,
    sessionLogSpanProcessor,
    usageEventsSpanProcessor,
    monitorJsonMetricExporter,
  };
}

async function forceFlushMetricReaders(
  metricReaders: IMetricReader[],
  nonBlockingMetricReaders: IMetricReader[],
): Promise<void> {
  const nonBlockingReaders = new Set(nonBlockingMetricReaders);
  await Promise.all(metricReaders.map(async (reader) => {
    if (nonBlockingReaders.has(reader)) {
      try {
        await reader.forceFlush();
      } catch (error) {
        log.warn('Non-blocking OpenTelemetry metric reader forceFlush failed; continuing shutdown', {
          errorType: getErrorType(error),
        });
        return;
      }
      return;
    }
    await reader.forceFlush();
  }));
}

function getErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function releaseSdk(shared: SharedOtelSdk): Promise<void> {
  shared.refCount -= 1;
  if (shared.refCount > 0) {
    return;
  }

  const shutdownPromise = shared.sdk.shutdown().finally(() => {
    if (activeSdk === shared) {
      activeSdk = undefined;
    }
    if (stoppingSdk === shutdownPromise) {
      stoppingSdk = undefined;
    }
  });
  stoppingSdk = shutdownPromise;
  await shutdownPromise;
}
