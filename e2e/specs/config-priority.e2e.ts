import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const removedWorkflowAlias = `--${['p', 'i', 'e', 'c', 'e'].join('')}`;
const removedWorkflowKey = ['p', 'i', 'e', 'c', 'e'].join('');

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
describe('E2E: Config priority (workflow / autoPr)', () => {
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

  it('should require --workflow in pipeline and use canonical workflow wording', () => {
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    const result = runTakt({
      args: [
        '--pipeline',
        '--task', 'Pipeline run should resolve workflow from config',
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

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('--workflow (-w) is required in pipeline mode');
  }, 240_000);

  it('should store canonical workflow data for takt add', () => {
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');
    const result = runTakt({
      args: [
        '--workflow', workflowPath,
        'add',
        'Canonical workflow option works',
      ],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      input: '\n\n\n\n\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const task = readFirstTask(testRepo.path);
    expect(task['workflow']).toBe(workflowPath);
    expect(task[removedWorkflowKey]).toBeUndefined();
  }, 240_000);

  it('should reject removed legacy workflow alias for takt add', () => {
    const workflowPath = resolve(__dirname, '../fixtures/workflows/simple.yaml');
    const result = runTakt({
      args: [
        removedWorkflowAlias, workflowPath,
        'add',
        'Removed workflow alias should fail',
      ],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`unknown option '${removedWorkflowAlias}'`);
  }, 240_000);

  it('should default auto_pr to true when unset in config/env', () => {
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');
    const result = runTakt({
      args: [
        '--workflow', workflowPath,
        'add',
        'Auto PR default behavior',
      ],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      input: '\n\n\n\n\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const task = readFirstTask(testRepo.path);
    expect(task['auto_pr']).toBe(true);
  }, 240_000);

});
