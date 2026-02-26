import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readFirstTask(repoPath: string): Record<string, unknown> {
  const tasksPath = join(repoPath, '.takt', 'tasks.yaml');
  const raw = readFileSync(tasksPath, 'utf-8');
  const parsed = parseYaml(raw) as { tasks?: Array<Record<string, unknown>> } | null;
  const first = parsed?.tasks?.[0];
  if (!first) {
    throw new Error(`No task record found in ${tasksPath}`);
  }
  return first;
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Config priority (piece / autoPr)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();
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

  it('should use configured piece in pipeline when --piece is omitted', () => {
    const configuredPiecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
    const projectConfigDir = join(testRepo.path, '.takt');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'config.yaml'),
      `piece: ${JSON.stringify(configuredPiecePath)}\n`,
      'utf-8',
    );

    const result = runTakt({
      args: [
        '--pipeline',
        '--task', 'Pipeline run should resolve piece from config',
        '--skip-git',
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
    expect(result.stdout).toContain(`Running piece: ${configuredPiecePath}`);
    expect(result.stdout).toContain(`Piece '${configuredPiecePath}' completed`);
  }, 240_000);

  it('should default auto_pr to true when unset in config/env', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    runTakt({
      args: [
        '--task', 'Auto PR default behavior',
        '--piece', piecePath,
        '--create-worktree', 'yes',
        '--provider', 'mock',
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    const task = readFirstTask(testRepo.path);
    expect(task['auto_pr']).toBe(true);
  }, 240_000);

  it('should use auto_pr from config when set', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
    updateIsolatedConfig(isolatedEnv.taktDir, { auto_pr: false });

    const result = runTakt({
      args: [
        '--task', 'Auto PR from config',
        '--piece', piecePath,
        '--create-worktree', 'yes',
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
    const task = readFirstTask(testRepo.path);
    expect(task['auto_pr']).toBe(false);
  }, 240_000);

  it('should prioritize env auto_pr over config', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
    updateIsolatedConfig(isolatedEnv.taktDir, { auto_pr: false });

    runTakt({
      args: [
        '--task', 'Auto PR from env override',
        '--piece', piecePath,
        '--create-worktree', 'yes',
        '--provider', 'mock',
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_AUTO_PR: 'true',
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    const task = readFirstTask(testRepo.path);
    expect(task['auto_pr']).toBe(true);
  }, 240_000);
});
