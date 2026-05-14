import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type ObservabilityConfigForTest = {
  enabled: boolean;
  monitor: boolean;
  sessionLogExporter: boolean;
  usageEventsPhase: boolean;
};

type NodeSdkOptionsForTest = {
  resource?: {
    attributes?: Record<string, string>;
  };
  spanProcessors?: unknown[];
  traceExporter?: unknown;
};

const disabledObservability: ObservabilityConfigForTest = {
  enabled: false,
  monitor: false,
  sessionLogExporter: false,
  usageEventsPhase: false,
};

const enabledObservability: ObservabilityConfigForTest = {
  enabled: true,
  monitor: false,
  sessionLogExporter: false,
  usageEventsPhase: false,
};

async function loadFoundationWithMockedSdk(): Promise<{
  initializeOtelFoundation: (config: ObservabilityConfigForTest) => Promise<{ shutdown(): Promise<void> }>;
  sdkImportCount: () => number;
  constructedOptions: NodeSdkOptionsForTest[];
  startMock: ReturnType<typeof vi.fn>;
  shutdownMock: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  let sdkImportCount = 0;
  const constructedOptions: NodeSdkOptionsForTest[] = [];
  const startMock = vi.fn();
  const shutdownMock = vi.fn().mockResolvedValue(undefined);

  vi.doMock('@opentelemetry/sdk-node', () => {
    sdkImportCount += 1;
    return {
      NodeSDK: class {
        constructor(options: NodeSdkOptionsForTest) {
          constructedOptions.push(options);
        }

        start(): void {
          startMock();
        }

        async shutdown(): Promise<void> {
          await shutdownMock();
        }
      },
      resources: {
        resourceFromAttributes: (attributes: Record<string, string>) => ({ attributes }),
      },
    };
  });

  const module = await import('../infra/observability/otelFoundation.js') as {
    initializeOtelFoundation: (config: ObservabilityConfigForTest) => Promise<{ shutdown(): Promise<void> }>;
  };

  return {
    initializeOtelFoundation: module.initializeOtelFoundation,
    sdkImportCount: () => sdkImportCount,
    constructedOptions,
    startMock,
    shutdownMock,
  };
}

describe('otel foundation', () => {
  afterEach(() => {
    vi.doUnmock('@opentelemetry/sdk-node');
    vi.resetModules();
  });

  it('should not import or start the SDK when observability is disabled', async () => {
    const foundation = await loadFoundationWithMockedSdk();

    const handle = await foundation.initializeOtelFoundation(disabledObservability);
    await handle.shutdown();

    expect(foundation.sdkImportCount()).toBe(0);
    expect(foundation.constructedOptions).toEqual([]);
    expect(foundation.startMock).not.toHaveBeenCalled();
    expect(foundation.shutdownMock).not.toHaveBeenCalled();
  });

  it('should start the SDK with takt resource attributes when observability is enabled', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string;
    };

    const handle = await foundation.initializeOtelFoundation(enabledObservability);
    await handle.shutdown();

    expect(foundation.sdkImportCount()).toBe(1);
    expect(foundation.startMock).toHaveBeenCalledOnce();
    expect(foundation.constructedOptions).toHaveLength(1);
    expect(foundation.constructedOptions[0]?.resource?.attributes).toMatchObject({
      'service.name': 'takt',
      'service.version': packageJson.version,
    });
    expect(foundation.constructedOptions[0]?.spanProcessors).toEqual([]);
    expect(foundation.constructedOptions[0]).not.toHaveProperty('traceExporter');
    expect(foundation.shutdownMock).toHaveBeenCalledOnce();
  });

  it('should share one SDK instance across concurrent enabled handles and shutdown once', async () => {
    const foundation = await loadFoundationWithMockedSdk();

    const firstHandle = foundation.initializeOtelFoundation(enabledObservability);
    const secondHandle = foundation.initializeOtelFoundation(enabledObservability);
    const [first, second] = await Promise.all([firstHandle, secondHandle]);

    expect(foundation.sdkImportCount()).toBe(1);
    expect(foundation.startMock).toHaveBeenCalledOnce();
    expect(foundation.constructedOptions).toHaveLength(1);

    await first.shutdown();
    await first.shutdown();
    expect(foundation.shutdownMock).not.toHaveBeenCalled();

    await second.shutdown();
    await second.shutdown();
    expect(foundation.shutdownMock).toHaveBeenCalledOnce();
  });

  it('should count an active SDK acquisition before the caller awaits the new handle', async () => {
    const foundation = await loadFoundationWithMockedSdk();

    const first = await foundation.initializeOtelFoundation(enabledObservability);
    const secondPromise = foundation.initializeOtelFoundation(enabledObservability);

    await first.shutdown();
    expect(foundation.shutdownMock).not.toHaveBeenCalled();

    const second = await secondPromise;
    await second.shutdown();

    expect(foundation.shutdownMock).toHaveBeenCalledOnce();
  });

  it('should wait for SDK shutdown before starting a replacement SDK', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    let resolveShutdown!: () => void;
    const pendingShutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    foundation.shutdownMock.mockImplementationOnce(() => pendingShutdown);

    const first = await foundation.initializeOtelFoundation(enabledObservability);
    const firstShutdown = first.shutdown();
    await Promise.resolve();

    expect(foundation.shutdownMock).toHaveBeenCalledOnce();

    const secondPromise = foundation.initializeOtelFoundation(enabledObservability);
    await Promise.resolve();

    expect(foundation.startMock).toHaveBeenCalledOnce();

    resolveShutdown();
    await firstShutdown;

    const second = await secondPromise;

    expect(foundation.startMock).toHaveBeenCalledTimes(2);

    await second.shutdown();

    expect(foundation.shutdownMock).toHaveBeenCalledTimes(2);
  });

  it('should reset pending SDK startup after a start failure so a later call can retry', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    foundation.startMock.mockImplementationOnce(() => {
      throw new Error('sdk start failed');
    });

    await expect(foundation.initializeOtelFoundation(enabledObservability)).rejects.toThrow('sdk start failed');

    const handle = await foundation.initializeOtelFoundation(enabledObservability);
    await handle.shutdown();

    expect(foundation.startMock).toHaveBeenCalledTimes(2);
    expect(foundation.constructedOptions).toHaveLength(2);
    expect(foundation.shutdownMock).toHaveBeenCalledOnce();
  });
});
