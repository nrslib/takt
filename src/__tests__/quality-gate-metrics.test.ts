import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runQualityGates } from '../core/workflow/quality-gates/qualityGateRunner.js';
import type { WorkflowStep } from '../core/models/types.js';
import { collectMetricPoints, metricPoint } from './observability-metrics-test-helpers.js';

describe('quality gate metrics', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Given command quality gates, When they pass or fail, Then records pass and fail result counters', async () => {
    const projectRoot = createTempDir();
    const step = makeStep('implement');

    const passPoints = await collectMetricPoints(async () => {
      const result = await runQualityGates({
        qualityGates: [
          'manual review note',
          {
            type: 'command',
            name: 'unit-tests',
            command: 'node -e "process.exit(0)"',
          },
        ],
        projectRoot,
        step,
        observabilityEnabled: true,
        runId: 'run-1',
        workflowName: 'default',
      });

      expect(result.ok).toBe(true);
    });

    const failPoints = await collectMetricPoints(async () => {
      const result = await runQualityGates({
        qualityGates: [
          {
            type: 'command',
            name: 'lint',
            command: 'node -e "process.exit(1)"',
          },
        ],
        projectRoot,
        step,
        observabilityEnabled: true,
        runId: 'run-1',
        workflowName: 'default',
      });

      expect(result.ok).toBe(false);
    });

    expect(metricPoint(passPoints, 'takt.quality_gate.results', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'default',
      'takt.step.name': 'implement',
      'takt.quality_gate.name': 'unit-tests',
      'takt.quality_gate.result': 'pass',
    })?.value).toBe(1);
    expect(metricPoint(passPoints, 'takt.quality_gate.results', {
      'takt.quality_gate.name': 'manual review note',
    })).toBeUndefined();
    expect(metricPoint(failPoints, 'takt.quality_gate.results', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'default',
      'takt.step.name': 'implement',
      'takt.quality_gate.name': 'lint',
      'takt.quality_gate.result': 'fail',
    })?.value).toBe(1);
  });

  it('Given observability disabled, When command quality gates run, Then records no quality gate counters', async () => {
    const projectRoot = createTempDir();
    const step = makeStep('implement');

    const points = await collectMetricPoints(async () => {
      const result = await runQualityGates({
        qualityGates: [
          {
            type: 'command',
            name: 'unit-tests',
            command: 'node -e "process.exit(0)"',
          },
        ],
        projectRoot,
        step,
        observabilityEnabled: false,
        runId: 'run-1',
        workflowName: 'default',
      });

      expect(result.ok).toBe(true);
    });

    expect(points.filter((point) => point.name === 'takt.quality_gate.results')).toEqual([]);
  });

  it('Given an unnamed command quality gate, When metrics are enabled, Then records a safe gate label without command secrets', async () => {
    const projectRoot = createTempDir();
    const step = makeStep('implement');
    const command = 'node -e "process.exit(0)" -- --api-key secret-token';

    const points = await collectMetricPoints(async () => {
      const result = await runQualityGates({
        qualityGates: [
          {
            type: 'command',
            command,
          },
        ],
        projectRoot,
        step,
        observabilityEnabled: true,
        runId: 'run-1',
        workflowName: 'default',
      });

      expect(result.ok).toBe(true);
    });

    const qualityGatePoint = metricPoint(points, 'takt.quality_gate.results', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'default',
      'takt.step.name': 'implement',
      'takt.quality_gate.name': '(unnamed)',
      'takt.quality_gate.result': 'pass',
    });
    expect(qualityGatePoint?.value).toBe(1);
    expect(JSON.stringify(qualityGatePoint?.attributes)).not.toContain('--api-key');
    expect(JSON.stringify(qualityGatePoint?.attributes)).not.toContain('secret-token');
  });

  it('Given a command quality gate name contains sensitive text, When metrics are enabled, Then records a sanitized gate label', async () => {
    const projectRoot = createTempDir();
    const step = makeStep('implement');

    const points = await collectMetricPoints(async () => {
      const result = await runQualityGates({
        qualityGates: [
          {
            type: 'command',
            name: 'deploy --api-key secret-token',
            command: 'node -e "process.exit(0)"',
          },
        ],
        projectRoot,
        step,
        observabilityEnabled: true,
        runId: 'run-1',
        workflowName: 'default',
      });

      expect(result.ok).toBe(true);
    });

    const qualityGatePoint = metricPoint(points, 'takt.quality_gate.results', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'default',
      'takt.step.name': 'implement',
      'takt.quality_gate.name': 'deploy --api-key [REDACTED]',
      'takt.quality_gate.result': 'pass',
    });
    expect(qualityGatePoint?.value).toBe(1);
    expect(JSON.stringify(qualityGatePoint?.attributes)).not.toContain('secret-token');
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'takt-quality-gate-metrics-'));
    tempDirs.push(dir);
    return dir;
  }
});

function makeStep(name: string): WorkflowStep {
  return {
    name,
    persona: '../agents/coder.md',
    instruction: 'Implement',
  };
}
