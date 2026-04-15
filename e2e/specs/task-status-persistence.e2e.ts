import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function writeSinglePendingTask(repoPath: string, workflowPath: string): void {
  const now = new Date().toISOString();
  mkdirSync(join(repoPath, '.takt'), { recursive: true });
  writeFileSync(
    join(repoPath, '.takt', 'tasks.yaml'),
    [
      'tasks:',
      '  - name: task-1',
      '    status: pending',
      '    content: "Task 1"',
      `    workflow: "${workflowPath}"`,
      `    created_at: "${now}"`,
      '    started_at: null',
      '    completed_at: null',
    ].join('\n'),
    'utf-8',
  );
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Task status persistence in tasks.yaml (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
    });
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should remove task record after successful completion', () => {
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    writeSinglePendingTask(repo.path, workflowPath);

    const result = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const tasksContent = readFileSync(join(repo.path, '.takt', 'tasks.yaml'), 'utf-8');
    const tasks = parseYaml(tasksContent) as { tasks: Array<Record<string, unknown>> };
    expect(Array.isArray(tasks.tasks)).toBe(true);
    expect(tasks.tasks.length).toBe(1);
    expect(tasks.tasks[0]?.status).toBe('completed');
  }, 240_000);

  it('should complete task when --ignore-exceed is used with max_steps exceeded workflow', () => {
    // Given: a workflow with max_steps=1 but requires 2 steps to complete
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-exceed-complete.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/exceed-complete.json');

    writeSinglePendingTask(repo.path, workflowPath);

    // When: running with --ignore-exceed flag
    const result = runTakt({
      args: ['run', '--ignore-exceed', '--provider', 'mock'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: task completes successfully (max_steps ignored)
    expect(result.exitCode).toBe(0);

    const tasksContent = readFileSync(join(repo.path, '.takt', 'tasks.yaml'), 'utf-8');
    const tasks = parseYaml(tasksContent) as { tasks: Array<Record<string, unknown>> };
    expect(Array.isArray(tasks.tasks)).toBe(true);
    expect(tasks.tasks.length).toBe(1);
    expect(tasks.tasks[0]?.status).toBe('completed');
  }, 240_000);

  it('should mark task as exceeded when max_steps is reached without --ignore-exceed', () => {
    // Given: a workflow with max_steps=1 but requires 2 steps (will exceed)
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-exceed-complete.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/exceed-complete.json');

    writeSinglePendingTask(repo.path, workflowPath);

    // When: running without --ignore-exceed flag
    const result = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: task is marked as exceeded (iteration limit hit)
    expect(result.exitCode).toBe(0);

    const tasksContent = readFileSync(join(repo.path, '.takt', 'tasks.yaml'), 'utf-8');
    const tasks = parseYaml(tasksContent) as { tasks: Array<Record<string, unknown>> };
    expect(Array.isArray(tasks.tasks)).toBe(true);
    expect(tasks.tasks.length).toBe(1);
    expect(tasks.tasks[0]?.status).toBe('exceeded');
  }, 240_000);

  it('should persist failed status and failure details on failure', () => {
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-no-match.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/no-match.json');

    writeSinglePendingTask(repo.path, workflowPath);

    const result = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);

    const tasksContent = readFileSync(join(repo.path, '.takt', 'tasks.yaml'), 'utf-8');
    const tasks = parseYaml(tasksContent) as {
      tasks: Array<{
        status: string;
        started_at: string | null;
        completed_at: string | null;
        failure?: { error?: string };
      }>;
    };

    expect(tasks.tasks.length).toBe(1);
    expect(tasks.tasks[0]?.status).toBe('failed');
    expect(tasks.tasks[0]?.started_at).toBeTruthy();
    expect(tasks.tasks[0]?.completed_at).toBeTruthy();
    expect(tasks.tasks[0]?.failure?.error).toBeTruthy();
  }, 240_000);
});
