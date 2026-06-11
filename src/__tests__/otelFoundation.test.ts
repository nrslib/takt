import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createLoggerMock, warnLogMock } = vi.hoisted(() => {
  const warnLogMock = vi.fn();
  return {
    warnLogMock,
    createLoggerMock: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnLogMock,
      error: vi.fn(),
      enter: vi.fn(),
      exit: vi.fn(),
    })),
  };
});

vi.mock('../shared/utils/debug.js', () => ({
  createLogger: createLoggerMock,
}));

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
  metricReaders?: unknown[];
  traceExporter?: unknown;
};

type UsageEventsProcessorForTest = {
  onEnd(span: unknown): void;
  registrations?: Map<string, unknown>;
};

type MetricReaderForTest = {
  forceFlushMock: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
};

type BatchSpanProcessorForTest = {
  forceFlushMock: ReturnType<typeof vi.fn>;
  shutdownMock: ReturnType<typeof vi.fn>;
};

type ShutdownableProcessorForTest = {
  shutdown(): Promise<void>;
};

const OTLP_ENV_NAMES = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
] as const;
const ORIGINAL_OTLP_ENV = new Map(
  OTLP_ENV_NAMES.map((name) => [name, process.env[name]] as const),
);

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

const enabledSessionLogExporterObservability: ObservabilityConfigForTest = {
  enabled: true,
  monitor: false,
  sessionLogExporter: true,
  usageEventsPhase: false,
};

const enabledMonitorObservability: ObservabilityConfigForTest = {
  enabled: true,
  monitor: true,
  sessionLogExporter: false,
  usageEventsPhase: false,
};

const enabledUsageEventsPhaseObservability: ObservabilityConfigForTest = {
  enabled: true,
  monitor: false,
  sessionLogExporter: false,
  usageEventsPhase: true,
};

const enabledAllObservability: ObservabilityConfigForTest = {
  enabled: true,
  monitor: true,
  sessionLogExporter: true,
  usageEventsPhase: true,
};

async function loadFoundationWithMockedSdk(): Promise<{
  initializeOtelFoundation: (
    config: ObservabilityConfigForTest,
    options?: {
      sessionLogExporter?: {
        runId: string;
        shadowLogPath: string;
        sanitizedTask: string;
        workflowName: string;
      };
      monitorJsonExporter?: {
        runId: string;
        monitorPath: string;
      };
      usageEventsExporter?: {
        runId: string;
        sessionId: string;
        phaseUsageLogPath: string;
      };
    },
  ) => Promise<{ shutdown(): Promise<void> }>;
  sdkImportCount: () => number;
  metricsImportCount: () => number;
  traceExporterImportCount: () => number;
  metricExporterImportCount: () => number;
  traceBaseImportCount: () => number;
  constructedOptions: NodeSdkOptionsForTest[];
  metricReaderOptions: Array<Record<string, unknown>>;
  metricReaders: MetricReaderForTest[];
  traceExporterConstructorArgs: unknown[][];
  metricExporterConstructorArgs: unknown[][];
  batchSpanProcessorOptions: Array<Record<string, unknown>>;
  batchSpanProcessors: BatchSpanProcessorForTest[];
  startMock: ReturnType<typeof vi.fn>;
  shutdownMock: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  let sdkImportCount = 0;
  let metricsImportCount = 0;
  let traceExporterImportCount = 0;
  let metricExporterImportCount = 0;
  let traceBaseImportCount = 0;
  const constructedOptions: NodeSdkOptionsForTest[] = [];
  const metricReaderOptions: Array<Record<string, unknown>> = [];
  const metricReaders: MetricReaderForTest[] = [];
  const traceExporterConstructorArgs: unknown[][] = [];
  const metricExporterConstructorArgs: unknown[][] = [];
  const batchSpanProcessorOptions: Array<Record<string, unknown>> = [];
  const batchSpanProcessors: BatchSpanProcessorForTest[] = [];
  const startMock = vi.fn();
  const shutdownMock = vi.fn().mockResolvedValue(undefined);
  const shutdownSpanProcessors = async (processors: unknown[] | undefined): Promise<void> => {
    if (!processors) {
      return;
    }
    await Promise.all(processors.map(async (processor) => {
      if (hasShutdown(processor)) {
        await processor.shutdown();
      }
    }));
  };

  vi.doMock('@opentelemetry/sdk-node', () => {
    sdkImportCount += 1;
    return {
      NodeSDK: class {
        constructor(private readonly options: NodeSdkOptionsForTest) {
          constructedOptions.push(options);
        }

        start(): void {
          startMock();
        }

        async shutdown(): Promise<void> {
          await shutdownMock();
          await shutdownSpanProcessors(this.options.spanProcessors);
        }
      },
      resources: {
        resourceFromAttributes: (attributes: Record<string, string>) => ({ attributes }),
      },
    };
  });

  vi.doMock('@opentelemetry/sdk-metrics', () => {
    metricsImportCount += 1;
    return {
      PeriodicExportingMetricReader: class {
        readonly forceFlushMock = vi.fn().mockResolvedValue(undefined);
        readonly options: Record<string, unknown>;

        constructor(options: Record<string, unknown>) {
          this.options = options;
          metricReaderOptions.push(options);
          metricReaders.push(this);
        }

        async forceFlush(): Promise<void> {
          await this.forceFlushMock();
        }
      },
      AggregationTemporality: {
        DELTA: 0,
        CUMULATIVE: 1,
      },
      DataPointType: {
        HISTOGRAM: 0,
        EXPONENTIAL_HISTOGRAM: 1,
        GAUGE: 2,
        SUM: 3,
      },
    };
  });

  vi.doMock('@opentelemetry/exporter-trace-otlp-http', () => {
    traceExporterImportCount += 1;
    return {
      OTLPTraceExporter: class {
        constructor(...args: unknown[]) {
          traceExporterConstructorArgs.push(args);
        }
      },
    };
  });

  vi.doMock('@opentelemetry/exporter-metrics-otlp-http', () => {
    metricExporterImportCount += 1;
    return {
      OTLPMetricExporter: class {
        constructor(...args: unknown[]) {
          metricExporterConstructorArgs.push(args);
        }
      },
    };
  });

  vi.doMock('@opentelemetry/sdk-trace-base', () => {
    traceBaseImportCount += 1;
    return {
      BatchSpanProcessor: class {
        readonly forceFlushMock = vi.fn().mockResolvedValue(undefined);
        readonly shutdownMock = vi.fn().mockResolvedValue(undefined);

        constructor(exporter: unknown) {
          batchSpanProcessorOptions.push({ exporter });
          batchSpanProcessors.push(this);
        }

        onStart(): void {}

        onEnd(): void {}

        async forceFlush(): Promise<void> {
          await this.forceFlushMock();
        }

        async shutdown(): Promise<void> {
          await this.shutdownMock();
        }
      },
    };
  });

  const module = await import('../infra/observability/otelFoundation.js') as {
    initializeOtelFoundation: (
      config: ObservabilityConfigForTest,
      options?: {
        sessionLogExporter?: {
          runId: string;
          shadowLogPath: string;
          sanitizedTask: string;
          workflowName: string;
        };
        monitorJsonExporter?: {
          runId: string;
          monitorPath: string;
        };
        usageEventsExporter?: {
          runId: string;
          sessionId: string;
          phaseUsageLogPath: string;
        };
      },
    ) => Promise<{ shutdown(): Promise<void> }>;
  };

  return {
    initializeOtelFoundation: module.initializeOtelFoundation,
    sdkImportCount: () => sdkImportCount,
    metricsImportCount: () => metricsImportCount,
    traceExporterImportCount: () => traceExporterImportCount,
    metricExporterImportCount: () => metricExporterImportCount,
    traceBaseImportCount: () => traceBaseImportCount,
    constructedOptions,
    metricReaderOptions,
    metricReaders,
    traceExporterConstructorArgs,
    metricExporterConstructorArgs,
    batchSpanProcessorOptions,
    batchSpanProcessors,
    startMock,
    shutdownMock,
  };
}

describe('otel foundation', () => {
  beforeEach(() => {
    createLoggerMock.mockClear();
    warnLogMock.mockClear();
    clearOtlpEnv();
  });

  afterEach(() => {
    vi.doUnmock('@opentelemetry/sdk-node');
    vi.doUnmock('@opentelemetry/sdk-metrics');
    vi.doUnmock('@opentelemetry/exporter-trace-otlp-http');
    vi.doUnmock('@opentelemetry/exporter-metrics-otlp-http');
    vi.doUnmock('@opentelemetry/sdk-trace-base');
    vi.resetModules();
    restoreOtlpEnv();
  });

  it('should not import or start the SDK when observability is disabled even if OTLP endpoint is configured', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const foundation = await loadFoundationWithMockedSdk();

    const handle = await foundation.initializeOtelFoundation(disabledObservability);
    await handle.shutdown();

    expect(foundation.sdkImportCount()).toBe(0);
    expect(foundation.metricsImportCount()).toBe(0);
    expect(foundation.traceExporterImportCount()).toBe(0);
    expect(foundation.metricExporterImportCount()).toBe(0);
    expect(foundation.traceBaseImportCount()).toBe(0);
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
    const usageEventsProcessor = foundation.constructedOptions[0]?.spanProcessors?.[1] as UsageEventsProcessorForTest;
    await handle.shutdown();

    expect(foundation.sdkImportCount()).toBe(1);
    expect(foundation.startMock).toHaveBeenCalledOnce();
    expect(foundation.constructedOptions).toHaveLength(1);
    expect(foundation.constructedOptions[0]?.resource?.attributes).toMatchObject({
      'service.name': 'takt',
      'service.version': packageJson.version,
    });
    expect(usageEventsProcessor.registrations?.size).toBe(0);
    expect(foundation.constructedOptions[0]?.spanProcessors).toHaveLength(2);
    expect(foundation.constructedOptions[0]?.metricReaders).toHaveLength(1);
    expect(foundation.constructedOptions[0]).not.toHaveProperty('traceExporter');
    expect(foundation.traceExporterImportCount()).toBe(0);
    expect(foundation.metricExporterImportCount()).toBe(0);
    expect(foundation.traceBaseImportCount()).toBe(0);
    expect(foundation.shutdownMock).toHaveBeenCalledOnce();
  });

  it('should add OTLP span processor and metric reader when OTLP endpoint is configured', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const foundation = await loadFoundationWithMockedSdk();

    const handle = await foundation.initializeOtelFoundation(enabledObservability);
    await handle.shutdown();

    expect(foundation.constructedOptions[0]?.spanProcessors).toHaveLength(3);
    expect(foundation.constructedOptions[0]?.metricReaders).toHaveLength(2);
    expect(foundation.traceExporterImportCount()).toBe(1);
    expect(foundation.metricExporterImportCount()).toBe(1);
    expect(foundation.traceBaseImportCount()).toBe(1);
    expect(foundation.traceExporterConstructorArgs).toEqual([[{ url: 'http://127.0.0.1:4318/v1/traces' }]]);
    expect(foundation.metricExporterConstructorArgs).toEqual([[{ url: 'http://127.0.0.1:4318/v1/metrics' }]]);
    expect(foundation.batchSpanProcessorOptions).toHaveLength(1);
    expect(foundation.metricReaderOptions[1]?.exporter).toBeDefined();
  });

  it('should keep the local-only processor and reader set when OTLP endpoint is blank', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '   ';
    const foundation = await loadFoundationWithMockedSdk();

    const handle = await foundation.initializeOtelFoundation(enabledObservability);
    await handle.shutdown();

    expect(foundation.constructedOptions[0]?.spanProcessors).toHaveLength(2);
    expect(foundation.constructedOptions[0]?.metricReaders).toHaveLength(1);
    expect(foundation.traceExporterImportCount()).toBe(0);
    expect(foundation.metricExporterImportCount()).toBe(0);
    expect(foundation.traceBaseImportCount()).toBe(0);
  });

  it('should keep the local-only processor and reader set when only signal-specific OTLP endpoints are configured', async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://127.0.0.1:4318/v1/metrics';
    const foundation = await loadFoundationWithMockedSdk();

    const handle = await foundation.initializeOtelFoundation(enabledObservability);
    await handle.shutdown();

    expect(foundation.constructedOptions[0]?.spanProcessors).toHaveLength(2);
    expect(foundation.constructedOptions[0]?.metricReaders).toHaveLength(1);
    expect(foundation.traceExporterImportCount()).toBe(0);
    expect(foundation.metricExporterImportCount()).toBe(0);
    expect(foundation.traceBaseImportCount()).toBe(0);
  });

  it('should continue SDK shutdown when an OTLP metric reader force flush fails', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const foundation = await loadFoundationWithMockedSdk();

    const handle = await foundation.initializeOtelFoundation(enabledObservability);
    expect(foundation.metricReaders).toHaveLength(2);
    foundation.metricReaders[1]?.forceFlushMock.mockRejectedValueOnce(new Error('collector unavailable'));

    await expect(handle.shutdown()).resolves.toBeUndefined();

    expect(foundation.metricReaders[0]?.forceFlushMock).toHaveBeenCalledOnce();
    expect(foundation.metricReaders[1]?.forceFlushMock).toHaveBeenCalledOnce();
    expect(warnLogMock).toHaveBeenCalledWith(
      'Non-blocking OpenTelemetry metric reader forceFlush failed; continuing shutdown',
      { errorType: 'Error' },
    );
    expect(foundation.shutdownMock).toHaveBeenCalledOnce();
  });

  it('should continue SDK shutdown when an OTLP trace processor shutdown fails', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const foundation = await loadFoundationWithMockedSdk();

    const handle = await foundation.initializeOtelFoundation(enabledObservability);
    expect(foundation.batchSpanProcessors).toHaveLength(1);
    foundation.batchSpanProcessors[0]?.shutdownMock.mockRejectedValueOnce(new Error('collector unavailable'));

    await expect(handle.shutdown()).resolves.toBeUndefined();

    expect(foundation.batchSpanProcessors[0]?.shutdownMock).toHaveBeenCalledOnce();
    expect(warnLogMock).toHaveBeenCalledWith(
      'Non-blocking OpenTelemetry span processor shutdown failed; continuing shutdown',
      { errorType: 'Error' },
    );
    expect(foundation.shutdownMock).toHaveBeenCalledOnce();
  });

  it('should attach the shadow session log span processor only when the exporter is enabled', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-otel-foundation-'));
    const shadowLogPath = join(tempDir, 'session-otel-session-shadow.jsonl');

    try {
      const handle = await foundation.initializeOtelFoundation(
        enabledSessionLogExporterObservability,
        {
          sessionLogExporter: {
            runId: 'run-1',
            shadowLogPath,
            sanitizedTask: 'secret task',
            workflowName: 'default',
          },
        },
      );
      await handle.shutdown();

      expect(foundation.constructedOptions[0]?.spanProcessors).toHaveLength(2);
      const records = readFileSync(shadowLogPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toEqual([
        expect.objectContaining({
          type: 'workflow_start',
          task: 'secret task',
          workflowName: 'default',
        }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should attach the monitor JSON metric reader only when monitor is enabled', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-otel-monitor-'));
    const monitorPath = join(tempDir, 'monitor.json');

    try {
      const handle = await foundation.initializeOtelFoundation(
        enabledMonitorObservability,
        {
          monitorJsonExporter: {
            runId: 'run-1',
            monitorPath,
          },
        },
      );
      await handle.shutdown();

      expect(foundation.metricsImportCount()).toBe(1);
      expect(foundation.metricReaderOptions).toHaveLength(1);
      expect(foundation.metricReaderOptions[0]?.exportIntervalMillis).toBe(1000);
      expect(foundation.metricReaderOptions[0]?.exporter).toBeDefined();
      expect(foundation.constructedOptions[0]?.metricReaders).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should attach the phase usage events span processor when usage events phase is enabled', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-otel-usage-events-'));
    const phaseUsageLogPath = join(tempDir, 'session-usage-events.phase.jsonl');

    try {
      const handle = await foundation.initializeOtelFoundation(
        enabledUsageEventsPhaseObservability,
        {
          usageEventsExporter: {
            runId: 'run-1',
            sessionId: 'session-1',
            phaseUsageLogPath,
          },
        },
      );

      const processor = foundation.constructedOptions[0]?.spanProcessors?.[1] as UsageEventsProcessorForTest;
      expect(processor.registrations?.size).toBe(1);
      processor.onEnd(makePhaseSpan('run-1'));
      await handle.shutdown();

      const records = readFileSync(phaseUsageLogPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toEqual([
        expect.objectContaining({
          run_id: 'run-1',
          session_id: 'session-1',
          phase: 'phase1_execute',
        }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should reject mismatched run-scoped exporter ids before starting the SDK', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-otel-registration-failure-'));
    const shadowLogPath = join(tempDir, 'session-otel-session-shadow.jsonl');
    const phaseUsageLogPath = join(tempDir, 'session-usage-events.phase.jsonl');
    const monitorPath = join(tempDir, 'monitor.json');

    try {
      await expect(foundation.initializeOtelFoundation(
        enabledAllObservability,
        {
          sessionLogExporter: {
            runId: 'run-2',
            shadowLogPath,
            sanitizedTask: 'task',
            workflowName: 'default',
          },
          usageEventsExporter: {
            runId: 'run-1',
            sessionId: 'session-1',
            phaseUsageLogPath,
          },
          monitorJsonExporter: {
            runId: 'run-2',
            monitorPath,
          },
        },
      )).rejects.toThrow('Run-scoped OpenTelemetry exporters must share the same runId');

      expect(foundation.startMock).not.toHaveBeenCalled();
      expect(foundation.constructedOptions).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should route run-local session logs and monitor files through the shared SDK', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-otel-run-routing-'));
    const firstShadowLogPath = join(tempDir, 'first-otel-session-shadow.jsonl');
    const secondShadowLogPath = join(tempDir, 'second-otel-session-shadow.jsonl');
    const firstMonitorPath = join(tempDir, 'first-monitor.json');
    const secondMonitorPath = join(tempDir, 'second-monitor.json');
    let first: { shutdown(): Promise<void> } | undefined;
    let second: { shutdown(): Promise<void> } | undefined;

    try {
      first = await foundation.initializeOtelFoundation(
        enabledAllObservability,
        {
          sessionLogExporter: {
            runId: 'run-1',
            shadowLogPath: firstShadowLogPath,
            sanitizedTask: 'first task',
            workflowName: 'default',
          },
          monitorJsonExporter: {
            runId: 'run-1',
            monitorPath: firstMonitorPath,
          },
        },
      );
      second = await foundation.initializeOtelFoundation(
        enabledAllObservability,
        {
          sessionLogExporter: {
            runId: 'run-2',
            shadowLogPath: secondShadowLogPath,
            sanitizedTask: 'second task',
            workflowName: 'default',
          },
          monitorJsonExporter: {
            runId: 'run-2',
            monitorPath: secondMonitorPath,
          },
        },
      );

      const processor = foundation.constructedOptions[0]?.spanProcessors?.[0] as {
        onEnd(span: unknown): void;
      };
      processor.onEnd({
        name: 'workflow.default',
        attributes: {
          'takt.run.id': 'run-2',
          'takt.workflow.status': 'completed',
          'takt.workflow.iterations': 1,
        },
      });
      processor.onEnd({
        name: 'workflow.default',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.workflow.status': 'aborted',
          'takt.workflow.iterations': 2,
        },
      });

      const exporter = foundation.metricReaderOptions[0]?.exporter as {
        export(metrics: unknown, callback: (result: { code: number; error?: Error }) => void): void;
      };
      let exportResult: { code: number; error?: Error } | undefined;
      exporter.export({
        resource: {
          attributes: {
            'service.name': 'takt',
          },
        },
        scopeMetrics: [
          {
            scope: { name: 'takt.workflow' },
            metrics: [
              {
                descriptor: {
                  name: 'takt.workflow.runs',
                  description: 'Workflow executions by status',
                  unit: '',
                  valueType: 1,
                },
                dataPointType: 3,
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [
                  {
                    startTime: [1_778_777_200, 0],
                    endTime: [1_778_777_205, 0],
                    attributes: {
                      'takt.run.id': 'run-1',
                      'takt.workflow.status': 'aborted',
                    },
                    value: 1,
                  },
                  {
                    startTime: [1_778_777_200, 0],
                    endTime: [1_778_777_205, 0],
                    attributes: {
                      'takt.run.id': 'run-2',
                      'takt.workflow.status': 'completed',
                    },
                    value: 1,
                  },
                ],
              },
            ],
          },
        ],
      }, (result) => {
        exportResult = result;
      });

      expect(exportResult).toEqual({ code: 0 });
      expect(readFileSync(firstShadowLogPath, 'utf-8')).toContain('first task');
      expect(readFileSync(firstShadowLogPath, 'utf-8')).toContain('workflow_abort');
      expect(readFileSync(firstShadowLogPath, 'utf-8')).not.toContain('second task');
      expect(readFileSync(secondShadowLogPath, 'utf-8')).toContain('second task');
      expect(readFileSync(secondShadowLogPath, 'utf-8')).toContain('workflow_complete');
      expect(readFileSync(secondShadowLogPath, 'utf-8')).not.toContain('first task');
      expect(readFileSync(firstMonitorPath, 'utf-8')).toContain('"takt.run.id": "run-1"');
      expect(readFileSync(firstMonitorPath, 'utf-8')).not.toContain('"takt.run.id": "run-2"');
      expect(readFileSync(secondMonitorPath, 'utf-8')).toContain('"takt.run.id": "run-2"');
      expect(readFileSync(secondMonitorPath, 'utf-8')).not.toContain('"takt.run.id": "run-1"');

      await first?.shutdown();
      await second?.shutdown();

      expect(foundation.constructedOptions).toHaveLength(1);
      expect(foundation.shutdownMock).toHaveBeenCalledOnce();
    } finally {
      await first?.shutdown();
      await second?.shutdown();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should retain exporter capability when the first shared SDK user has no run exporters', async () => {
    const foundation = await loadFoundationWithMockedSdk();
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-otel-late-run-routing-'));
    const shadowLogPath = join(tempDir, 'late-otel-session-shadow.jsonl');
    const monitorPath = join(tempDir, 'late-monitor.json');
    let first: { shutdown(): Promise<void> } | undefined;
    let second: { shutdown(): Promise<void> } | undefined;

    try {
      first = await foundation.initializeOtelFoundation(enabledObservability);
      second = await foundation.initializeOtelFoundation(
        enabledAllObservability,
        {
          sessionLogExporter: {
            runId: 'run-late',
            shadowLogPath,
            sanitizedTask: 'late task',
            workflowName: 'default',
          },
          monitorJsonExporter: {
            runId: 'run-late',
            monitorPath,
          },
        },
      );

      const processor = foundation.constructedOptions[0]?.spanProcessors?.[0] as {
        onEnd(span: unknown): void;
      } | undefined;
      expect(processor).toBeDefined();
      processor?.onEnd({
        name: 'workflow.default',
        attributes: {
          'takt.run.id': 'run-late',
          'takt.workflow.status': 'completed',
          'takt.workflow.iterations': 1,
        },
      });

      const exporter = foundation.metricReaderOptions[0]?.exporter as {
        export(metrics: unknown, callback: (result: { code: number; error?: Error }) => void): void;
      } | undefined;
      expect(exporter).toBeDefined();
      let exportResult: { code: number; error?: Error } | undefined;
      exporter?.export({
        resource: {
          attributes: {
            'service.name': 'takt',
          },
        },
        scopeMetrics: [
          {
            scope: { name: 'takt.workflow' },
            metrics: [
              {
                descriptor: {
                  name: 'takt.workflow.runs',
                  description: 'Workflow executions by status',
                  unit: '',
                  valueType: 1,
                },
                dataPointType: 3,
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [
                  {
                    startTime: [1_778_777_200, 0],
                    endTime: [1_778_777_205, 0],
                    attributes: {
                      'takt.run.id': 'run-late',
                      'takt.workflow.status': 'completed',
                    },
                    value: 1,
                  },
                ],
              },
            ],
          },
        ],
      }, (result) => {
        exportResult = result;
      });

      expect(exportResult).toEqual({ code: 0 });
      expect(readFileSync(shadowLogPath, 'utf-8')).toContain('late task');
      expect(readFileSync(shadowLogPath, 'utf-8')).toContain('workflow_complete');
      expect(readFileSync(monitorPath, 'utf-8')).toContain('"takt.run.id": "run-late"');
    } finally {
      await second?.shutdown();
      await first?.shutdown();
      rmSync(tempDir, { recursive: true, force: true });
    }
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
    await new Promise((resolve) => setImmediate(resolve));

    expect(foundation.shutdownMock).toHaveBeenCalledOnce();

    const secondPromise = foundation.initializeOtelFoundation(enabledObservability);
    await new Promise((resolve) => setImmediate(resolve));

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

function makePhaseSpan(runId: string): Record<string, unknown> {
  return {
    name: 'phase.implement.execute',
    endTime: [1_778_777_205, 0],
    attributes: {
      'takt.run.id': runId,
      'takt.provider.name': 'mock',
      'takt.model.name': 'mock-model',
      'takt.step.name': 'implement',
      'takt.step.type': 'agent',
      'takt.phase.number': 1,
      'takt.phase.name': 'execute',
      'takt.phase.status': 'done',
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.total_tokens': 5,
    },
  };
}

function hasShutdown(processor: unknown): processor is ShutdownableProcessorForTest {
  return typeof processor === 'object'
    && processor !== null
    && 'shutdown' in processor
    && typeof processor.shutdown === 'function';
}

function clearOtlpEnv(): void {
  for (const name of OTLP_ENV_NAMES) {
    delete process.env[name];
  }
}

function restoreOtlpEnv(): void {
  for (const name of OTLP_ENV_NAMES) {
    const originalValue = ORIGINAL_OTLP_ENV.get(name);
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
}
