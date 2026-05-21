import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AggregationTemporality, DataPointType, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { MonitorJsonMetricExporter } from '../infra/observability/monitorJsonMetricExporter.js';

const tempDirs = new Set<string>();

function createTempMonitorPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-monitor-json-exporter-'));
  tempDirs.add(dir);
  return join(dir, 'monitor.json');
}

function makeResourceMetrics(): ResourceMetrics {
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
            dataPoints: [
              {
                startTime: [1_778_777_200, 0],
                endTime: [1_778_777_205, 0],
                attributes: {
                  'takt.workflow.name': 'default',
                  'takt.workflow.status': 'completed',
                },
                value: 1,
              },
            ],
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

describe('MonitorJsonMetricExporter', () => {
  it('writes the latest resource metrics as monitor.json', async () => {
    const monitorPath = createTempMonitorPath();
    const exporter = new MonitorJsonMetricExporter({ monitorPath });
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
    const exporter = new MonitorJsonMetricExporter({ monitorPath: createTempMonitorPath() });
    await exporter.shutdown();
    let result: { code: number; error?: Error } | undefined;

    exporter.export(makeResourceMetrics(), (exportResult) => {
      result = exportResult;
    });

    expect(result?.code).toBe(1);
    expect(result?.error?.message).toContain('shut down');
  });
});
