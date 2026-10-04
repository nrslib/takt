import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const runRoots = allRunRoots(repoPath);
  const runRoot = runRoots[0];
  if (!runRoot) {
    throw new Error('Run directory not found');
  }
  return runRoot;
}

function allRunRoots(repoPath: string): string[] {
  const runsDir = join(repoPath, '.takt', 'runs');
  return readdirSync(runsDir).sort().map((runDir) => join(runsDir, runDir));
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

function hasLogFile(runRoot: string, suffix: string): boolean {
  const logsDir = join(runRoot, 'logs');
  if (!existsSync(logsDir)) {
    return false;
  }
  return readdirSync(logsDir).some((entry) => entry.endsWith(suffix));
}

function hasObservabilityArtifacts(runRoot: string): boolean {
  return (
    hasLogFile(runRoot, '-usage-events.phase.jsonl') &&
    hasLogFile(runRoot, '-otel-session-shadow.jsonl') &&
    existsSync(join(runRoot, 'monitor.json'))
  );
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

  it('should propagate observability file outputs to a nested takt process launched by a command gate', () => {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      workflow_command_gates: {
        custom_scripts: true,
      },
    });

    mkdirSync(join(testRepo.path, '.takt', 'quality-gates'), { recursive: true });
    const childConfigDir = join(testRepo.path, '.takt', 'nested-config');
    mkdirSync(childConfigDir, { recursive: true });
    writeFileSync(
      join(childConfigDir, 'config.yaml'),
      [
        'provider: mock',
        'model: mock-model',
      ].join('\n'),
      'utf-8',
    );
    const binPath = resolve(__dirname, '../../bin/takt');
    const childWorkflowPath = join(testRepo.path, 'nested-observability-child.yaml');
    writeFileSync(
      childWorkflowPath,
      [
        'name: nested-observability-child',
        'description: Nested child workflow for observability propagation',
        'personas:',
        '  test-coder: |',
        '    You are the E2E test coder.',
        'max_steps: 3',
        'initial_step: execute',
        'steps:',
        '  - name: execute',
        '    edit: false',
        '    persona: test-coder',
        '    instruction: |',
        '      {task}',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(testRepo.path, 'nested-observability-parent.yaml'),
      [
        'name: nested-observability-parent',
        'description: Parent workflow that launches a nested TAKT run',
        'personas:',
        '  test-coder: |',
        '    You are the E2E test coder.',
        'max_steps: 3',
        'initial_step: execute',
        'steps:',
        '  - name: execute',
        '    edit: true',
        '    persona: test-coder',
        '    instruction: |',
        '      {task}',
        '    quality_gates:',
        '      - type: command',
        '        name: nested-takt-observability',
        '        command: "node ./.takt/quality-gates/run-nested-observability.cjs"',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(testRepo.path, '.takt', 'quality-gates', 'run-nested-observability.cjs'),
      [
        'const { spawnSync } = require("node:child_process");',
        `const result = spawnSync(process.execPath, [${JSON.stringify(binPath)}, "--task", "nested child task", "--workflow", ${JSON.stringify(childWorkflowPath)}, "--provider", "mock"], {`,
        '  cwd: process.cwd(),',
        `  env: { ...process.env, TAKT_CONFIG_DIR: ${JSON.stringify(childConfigDir)} },`,
        '  encoding: "utf-8",',
        '});',
        'if (result.status !== 0) {',
        '  process.stdout.write(result.stdout || "");',
        '  process.stderr.write(result.stderr || "");',
        '  process.exit(result.status || 1);',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = runTakt({
      args: [
        '--task', 'Run the parent workflow and finish',
        '--workflow', join(testRepo.path, 'nested-observability-parent.yaml'),
        '--provider', 'mock',
      ],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    const artifactRunRoots = allRunRoots(testRepo.path).filter(hasObservabilityArtifacts);
    expect(artifactRunRoots.length).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
