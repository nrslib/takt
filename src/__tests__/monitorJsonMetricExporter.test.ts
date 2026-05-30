import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AggregationTemporality, DataPointType, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { hasCardinalityOverflow, MonitorJsonMetricExporter } from '../infra/observability/monitorJsonMetricExporter.js';

const tempDirs = new Set<string>();

function createTempMonitorPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-monitor-json-exporter-'));
  tempDirs.add(dir);
  return join(dir, 'monitor.json');
}

function makeResourceMetrics(runIds: string[] = ['run-1']): ResourceMetrics {
  return {
    resource: {
      attributes: {
        'service.name': 'takt',
        'service.version': '0.42.0',
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
            dataPointType: DataPointType.SUM,
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            isMonotonic: true,
            dataPoints: runIds.map((runId, index) => ({
              startTime: [1_778_777_200, 0],
              endTime: [1_778_777_205, 0],
              attributes: {
                'takt.run.id': runId,
                'takt.workflow.name': 'default',
                'takt.workflow.status': index === 0 ? 'completed' : 'aborted',
              },
              value: 1,
            })),
          },
        ],
      },
    ],
  } as ResourceMetrics;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeOverflowMetrics(): ResourceMetrics {
  return {
    resource: { attributes: { 'service.name': 'takt' } },
    scopeMetrics: [
      {
        scope: { name: 'takt.workflow' },
        metrics: [
          {
            descriptor: { name: 'takt.workflow.runs', description: '', unit: '', valueType: 1 },
            dataPointType: DataPointType.SUM,
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            isMonotonic: true,
            dataPoints: [
              {
                startTime: [1_778_777_200, 0],
                endTime: [1_778_777_205, 0],
                attributes: { 'otel.metric.overflow': true },
                value: 9,
              },
            ],
          },
        ],
      },
    ],
  } as unknown as ResourceMetrics;
}

describe('hasCardinalityOverflow', () => {
  it('is false for normal run-scoped metrics', () => {
    expect(hasCardinalityOverflow(makeResourceMetrics(['run-1', 'run-2']))).toBe(false);
  });

  it('is true when a data point carries the otel.metric.overflow marker', () => {
    expect(hasCardinalityOverflow(makeOverflowMetrics())).toBe(true);
  });
});

describe('MonitorJsonMetricExporter', () => {
  it('ignores a duplicate runId registration and keeps the first monitor path', async () => {
    const firstPath = createTempMonitorPath();
    const secondPath = createTempMonitorPath();
    const exporter = new MonitorJsonMetricExporter();

    exporter.register({ runId: 'run-1', monitorPath: firstPath });
    // Collision: same runId, different path -> must be ignored (no-op disposer).
    const disposeDuplicate = exporter.register({ runId: 'run-1', monitorPath: secondPath });
    disposeDuplicate();

    exporter.export(makeResourceMetrics(['run-1']), () => {});
    await exporter.forceFlush();

    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(false);
  });

  it('writes the latest resource metrics as monitor.json', async () => {
    const monitorPath = createTempMonitorPath();
    const exporter = new MonitorJsonMetricExporter({ runId: 'run-1', monitorPath });
    let result: { code: number; error?: Error } | undefined;

    exporter.export(makeResourceMetrics(), (exportResult) => {
      result = exportResult;
    });
    await exporter.forceFlush();

    expect(result).toEqual({ code: 0 });
    const monitor = JSON.parse(readFileSync(monitorPath, 'utf-8')) as Record<string, unknown>;
    expect(monitor).toMatchObject({
      schemaVersion: 1,
      resource: {
        'service.name': 'takt',
      },
      scopeMetrics: [
        {
          scope: { name: 'takt.workflow' },
          metrics: [
            {
              name: 'takt.workflow.runs',
              dataPointType: 'sum',
              aggregationTemporality: 'cumulative',
              isMonotonic: true,
              points: [
                {
                  startTime: '2026-05-14T16:46:40.000Z',
                  endTime: '2026-05-14T16:46:45.000Z',
                  attributes: {
                    'takt.workflow.status': 'completed',
                  },
                  value: 1,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('rejects exports after shutdown', async () => {
    const exporter = new MonitorJsonMetricExporter({ runId: 'run-1', monitorPath: createTempMonitorPath() });
    await exporter.shutdown();
    let result: { code: number; error?: Error } | undefined;

    exporter.export(makeResourceMetrics(), (exportResult) => {
      result = exportResult;
    });

    expect(result?.code).toBe(1);
    expect(result?.error?.message).toContain('shut down');
  });

  it('routes metric exports to the matching registered run', () => {
    const firstMonitorPath = createTempMonitorPath();
    const secondMonitorPath = createTempMonitorPath();
    const exporter = new MonitorJsonMetricExporter();

    exporter.register({ runId: 'run-1', monitorPath: firstMonitorPath });
    exporter.register({ runId: 'run-2', monitorPath: secondMonitorPath });

    let result: { code: number; error?: Error } | undefined;
    exporter.export(makeResourceMetrics(['run-1', 'run-2']), (exportResult) => {
      result = exportResult;
    });

    expect(result).toEqual({ code: 0 });
    const firstMonitor = JSON.parse(readFileSync(firstMonitorPath, 'utf-8')) as {
      scopeMetrics: Array<{ metrics: Array<{ points: Array<{ attributes: Record<string, unknown> }> }> }>;
    };
    const secondMonitor = JSON.parse(readFileSync(secondMonitorPath, 'utf-8')) as {
      scopeMetrics: Array<{ metrics: Array<{ points: Array<{ attributes: Record<string, unknown> }> }> }>;
    };
    expect(firstMonitor.scopeMetrics[0]?.metrics[0]?.points).toHaveLength(1);
    expect(firstMonitor.scopeMetrics[0]?.metrics[0]?.points[0]?.attributes).toMatchObject({
      'takt.run.id': 'run-1',
      'takt.workflow.status': 'completed',
    });
    expect(secondMonitor.scopeMetrics[0]?.metrics[0]?.points).toHaveLength(1);
    expect(secondMonitor.scopeMetrics[0]?.metrics[0]?.points[0]?.attributes).toMatchObject({
      'takt.run.id': 'run-2',
      'takt.workflow.status': 'aborted',
    });
  });

  it('continues exporting later registrations when one monitor path fails', () => {
    const badMonitorPath = mkdtempSync(join(tmpdir(), 'takt-monitor-json-exporter-bad-'));
    const goodMonitorPath = createTempMonitorPath();
    tempDirs.add(badMonitorPath);
    const exporter = new MonitorJsonMetricExporter();

    exporter.register({ runId: 'run-1', monitorPath: badMonitorPath });
    exporter.register({ runId: 'run-2', monitorPath: goodMonitorPath });

    let result: { code: number; error?: Error } | undefined;
    exporter.export(makeResourceMetrics(['run-1', 'run-2']), (exportResult) => {
      result = exportResult;
    });

    expect(result).toEqual({ code: 0 });
    const monitor = JSON.parse(readFileSync(goodMonitorPath, 'utf-8')) as {
      scopeMetrics: Array<{ metrics: Array<{ points: Array<{ attributes: Record<string, unknown> }> }> }>;
    };
    expect(monitor.scopeMetrics[0]?.metrics[0]?.points[0]?.attributes).toMatchObject({
      'takt.run.id': 'run-2',
      'takt.workflow.status': 'aborted',
    });
  });

  it('does not overwrite a monitor file when an export has no points for that run', () => {
    const firstMonitorPath = createTempMonitorPath();
    const exporter = new MonitorJsonMetricExporter({ runId: 'run-1', monitorPath: firstMonitorPath });
    let firstResult: { code: number; error?: Error } | undefined;
    let secondResult: { code: number; error?: Error } | undefined;

    exporter.export(makeResourceMetrics(['run-1']), (exportResult) => {
      firstResult = exportResult;
    });
    const firstMonitor = readFileSync(firstMonitorPath, 'utf-8');

    exporter.export(makeResourceMetrics(['run-2']), (exportResult) => {
      secondResult = exportResult;
    });

    expect(firstResult).toEqual({ code: 0 });
    expect(secondResult).toEqual({ code: 0 });
    expect(readFileSync(firstMonitorPath, 'utf-8')).toBe(firstMonitor);
  });
});
