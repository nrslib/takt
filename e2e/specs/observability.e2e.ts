import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type JsonRecord = Record<string, unknown>;

function readJsonl(path: string): JsonRecord[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function monitorHasRunIdAttribute(monitor: JsonRecord): boolean {
  const scopeMetrics = monitor.scopeMetrics;
  if (!Array.isArray(scopeMetrics)) {
    return false;
  }
  return scopeMetrics.some((scopeMetric) => {
    if (!isJsonRecord(scopeMetric) || !Array.isArray(scopeMetric.metrics)) {
      return false;
    }
    return scopeMetric.metrics.some((metric) => {
      if (!isJsonRecord(metric) || !Array.isArray(metric.points)) {
        return false;
      }
      return metric.points.some((point) => {
        if (!isJsonRecord(point) || !isJsonRecord(point.attributes)) {
          return false;
        }
        return (
          Object.prototype.hasOwnProperty.call(point.attributes, 'takt.run.id') &&
          typeof point.attributes['takt.run.id'] === 'string'
        );
      });
    });
  });
}

function firstRunRoot(repoPath: string): string {
  const runsDir = join(repoPath, '.takt', 'runs');
  const runDirs = readdirSync(runsDir).sort();
  const runDir = runDirs[0];
  if (!runDir) {
    throw new Error('Run directory not found');
  }
  return join(runsDir, runDir);
}

function findLogFile(runRoot: string, suffix: string): string {
  const logsDir = join(runRoot, 'logs');
  const entries = readdirSync(logsDir);
  const file = entries.find((entry) => entry.endsWith(suffix));
  if (!file) {
    throw new Error(`Log file not found: *${suffix}; logs: ${entries.join(', ')}`);
  }
  return join(logsDir, file);
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Observability file outputs (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    updateIsolatedConfig(isolatedEnv.taktDir, {
      observability: {
        enabled: true,
        usage_events_phase: true,
        monitor: true,
        session_log_exporter: true,
      },
    });
    testRepo = createLocalRepo();
  });

  afterEach(() => {
    try {
      testRepo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should write phase usage events, shadow session log, and monitor JSON from config only', () => {
    const workflowPath = copyWorkflowFixtureToRepo(
      testRepo.path,
      resolve(__dirname, '../fixtures/workflows/report-judge.yaml'),
    );
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/report-judge.json');

    const result = runTakt({
      args: [
        '--task', 'Create a short report and finish',
        '--workflow', workflowPath,
        '--provider', 'mock',
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const runRoot = firstRunRoot(testRepo.path);
    const phaseUsagePath = findLogFile(runRoot, '-usage-events.phase.jsonl');
    const shadowLogPath = findLogFile(runRoot, '-otel-session-shadow.jsonl');
    const monitorPath = join(runRoot, 'monitor.json');

    const phaseUsageRecords = readJsonl(phaseUsagePath);
    expect(phaseUsageRecords.length).toBeGreaterThan(0);
    const phases = new Set(phaseUsageRecords.map((record) => record.phase));
    expect(phases.has('phase1_execute')).toBe(true);
    expect(phases.has('phase2_report')).toBe(true);
    expect([...phases].some((phase) => typeof phase === 'string' && phase.startsWith('phase3_'))).toBe(true);
    expect(phaseUsageRecords[0]).toEqual(expect.objectContaining({
      step: expect.any(String),
      provider: 'mock',
      provider_model: expect.any(String),
      step_type: 'agent',
      usage_missing: expect.any(Boolean),
      usage: expect.any(Object),
    }));

    const shadowRecords = readJsonl(shadowLogPath);
    expect(shadowRecords.some((record) => record.type === 'workflow_start')).toBe(true);
    expect(shadowRecords.some((record) => record.type === 'workflow_complete')).toBe(true);

    const monitor = JSON.parse(readFileSync(monitorPath, 'utf-8')) as JsonRecord;
    expect(monitor).toBeTruthy();
    expect(monitorHasRunIdAttribute(monitor)).toBe(true);
  }, 240_000);
});
