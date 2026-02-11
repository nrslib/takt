import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-task-status-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  return {
    path: repoPath,
    cleanup: () => {
      try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function writeSinglePendingTask(repoPath: string, piecePath: string): void {
  const now = new Date().toISOString();
  mkdirSync(join(repoPath, '.takt'), { recursive: true });
  writeFileSync(
    join(repoPath, '.takt', 'tasks.yaml'),
    [
      'tasks:',
      '  - name: task-1',
      '    status: pending',
      '    content: "Task 1"',
      `    piece: "${piecePath}"`,
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
  let repo: { path: string; cleanup: () => void };

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
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    writeSinglePendingTask(repo.path, piecePath);

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
    expect(tasks.tasks.length).toBe(0);
  }, 240_000);

  it('should persist failed status and failure details on failure', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-no-match.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/no-match.json');

    writeSinglePendingTask(repo.path, piecePath);

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
