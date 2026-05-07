import { createRequire } from 'node:module';
import type { ResolvedObservabilityConfig } from '../../core/models/config-types.js';

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

let activeSdk: SharedOtelSdk | undefined;
let startingSdk: Promise<SharedOtelSdk> | undefined;

export async function initializeOtelFoundation(
  config: ResolvedObservabilityConfig,
): Promise<OtelFoundationHandle> {
  if (config.enabled !== true) {
    return createNoopHandle();
  }

  const shared = await getOrStartSdk();
  shared.refCount += 1;

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

function createNoopHandle(): OtelFoundationHandle {
  return {
    async shutdown(): Promise<void> {},
  };
}

async function getOrStartSdk(): Promise<SharedOtelSdk> {
  if (activeSdk) {
    return activeSdk;
  }
  if (!startingSdk) {
    startingSdk = startSdk().then(
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

async function startSdk(): Promise<OtelSdk> {
  const { NodeSDK, resources } = await import('@opentelemetry/sdk-node');
  const sdk = new NodeSDK({
    autoDetectResources: false,
    instrumentations: [],
    logRecordProcessors: [],
    metricReaders: [],
    resource: resources.resourceFromAttributes({
      'service.name': 'takt',
      'service.version': TAKT_VERSION,
    }),
    spanProcessors: [],
  });
  sdk.start();
  return sdk;
}

async function releaseSdk(shared: SharedOtelSdk): Promise<void> {
  shared.refCount -= 1;
  if (shared.refCount > 0) {
    return;
  }
  activeSdk = undefined;
  await shared.sdk.shutdown();
}
