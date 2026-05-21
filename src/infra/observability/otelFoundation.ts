import { createRequire } from 'node:module';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { IMetricReader } from '@opentelemetry/sdk-metrics';
import type { ResolvedObservabilityConfig } from '../../core/models/config-types.js';
import { SessionLogSpanProcessor, type SessionLogSpanProcessorOptions } from './sessionLogSpanProcessor.js';
import { MonitorJsonMetricExporter, type MonitorJsonMetricExporterOptions } from './monitorJsonMetricExporter.js';

const require = createRequire(import.meta.url);
const { version: TAKT_VERSION } = require('../../../package.json') as { version: string };

type OtelSdk = {
  start(): void;
  shutdown(): Promise<void>;
};

type SharedOtelSdk = {
  sdk: OtelSdk;
  refCount: number;
};

export type OtelFoundationHandle = {
  shutdown(): Promise<void>;
};

export interface OtelFoundationOptions {
  sessionLogExporter?: SessionLogSpanProcessorOptions;
  monitorJsonExporter?: MonitorJsonMetricExporterOptions;
}

let activeSdk: SharedOtelSdk | undefined;
let startingSdk: Promise<SharedOtelSdk> | undefined;
let stoppingSdk: Promise<void> | undefined;

export async function initializeOtelFoundation(
  config: ResolvedObservabilityConfig,
  options: OtelFoundationOptions | undefined = undefined,
): Promise<OtelFoundationHandle> {
  if (!config.enabled) {
    return createNoopHandle();
  }

  const shared = await acquireSdk(config, options);

  let released = false;
  return {
    async shutdown(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await releaseSdk(shared);
    },
  };
}

async function acquireSdk(
  config: ResolvedObservabilityConfig,
  options: OtelFoundationOptions | undefined,
): Promise<SharedOtelSdk> {
  if (stoppingSdk) {
    await stoppingSdk;
  }

  if (activeSdk) {
    activeSdk.refCount += 1;
    return activeSdk;
  }

  const shared = await getOrStartSdk(config, options);
  shared.refCount += 1;
  return shared;
}

function createNoopHandle(): OtelFoundationHandle {
  return {
    async shutdown(): Promise<void> {},
  };
}

async function getOrStartSdk(
  config: ResolvedObservabilityConfig,
  options: OtelFoundationOptions | undefined,
): Promise<SharedOtelSdk> {
  if (activeSdk) {
    return activeSdk;
  }
  if (!startingSdk) {
    startingSdk = startSdk(config, options).then(
      (sdk) => {
        const shared = { sdk, refCount: 0 };
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

function createSpanProcessors(
  config: ResolvedObservabilityConfig,
  options: OtelFoundationOptions | undefined,
): SpanProcessor[] {
  const spanProcessors: SpanProcessor[] = [];
  if (config.sessionLogExporter && options?.sessionLogExporter) {
    spanProcessors.push(new SessionLogSpanProcessor(options.sessionLogExporter));
  }
  return spanProcessors;
}

async function createMetricReaders(
  config: ResolvedObservabilityConfig,
  options: OtelFoundationOptions | undefined,
): Promise<IMetricReader[]> {
  if (!config.monitor || !options?.monitorJsonExporter) {
    return [];
  }
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
  return [
    new PeriodicExportingMetricReader({
      exporter: new MonitorJsonMetricExporter(options.monitorJsonExporter),
      exportIntervalMillis: 1000,
    }),
  ];
}

async function startSdk(
  config: ResolvedObservabilityConfig,
  options: OtelFoundationOptions | undefined,
): Promise<OtelSdk> {
  const spanProcessors = createSpanProcessors(config, options);
  const metricReaders = await createMetricReaders(config, options);
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
  return sdk;
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
