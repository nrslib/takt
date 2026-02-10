import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-run-multi-'));
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

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Run multiple tasks (takt run)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: { path: string; cleanup: () => void };

  const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();

    // Override config to use mock provider
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
    });
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should execute all pending tasks sequentially', () => {
    // Given: 3 pending tasks in tasks.yaml
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/run-three-tasks.json');
    const now = new Date().toISOString();

    mkdirSync(join(repo.path, '.takt'), { recursive: true });
    writeFileSync(
      join(repo.path, '.takt', 'tasks.yaml'),
      [
        'tasks:',
        '  - name: task-1',
        '    status: pending',
        '    content: "E2E task 1"',
        `    piece: "${piecePath}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '  - name: task-2',
        '    status: pending',
        '    content: "E2E task 2"',
        `    piece: "${piecePath}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '  - name: task-3',
        '    status: pending',
        '    content: "E2E task 3"',
        `    piece: "${piecePath}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
      ].join('\n'),
      'utf-8',
    );

    // When: running takt run
    const result = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: all 3 tasks complete
    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('task-1');
    expect(combined).toContain('task-2');
    expect(combined).toContain('task-3');
  }, 240_000);

  it('should continue remaining tasks when one task fails', () => {
    // Given: 3 tasks where the 2nd will fail (error status)
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/run-with-failure.json');
    const now = new Date().toISOString();

    mkdirSync(join(repo.path, '.takt'), { recursive: true });
    writeFileSync(
      join(repo.path, '.takt', 'tasks.yaml'),
      [
        'tasks:',
        '  - name: task-ok-1',
        '    status: pending',
        '    content: "Should succeed"',
        `    piece: "${piecePath}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '  - name: task-fail',
        '    status: pending',
        '    content: "Should fail"',
        `    piece: "${piecePath}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
        '  - name: task-ok-2',
        '    status: pending',
        '    content: "Should succeed after failure"',
        `    piece: "${piecePath}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
      ].join('\n'),
      'utf-8',
    );

    // When: running takt run
    const result = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: exit code is non-zero (failure occurred), but task-ok-2 was still attempted
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('task-ok-1');
    expect(combined).toContain('task-fail');
    expect(combined).toContain('task-ok-2');
  }, 240_000);

  it('should exit cleanly when no pending tasks exist', () => {
    // Given: an empty tasks.yaml
    mkdirSync(join(repo.path, '.takt'), { recursive: true });
    writeFileSync(
      join(repo.path, '.takt', 'tasks.yaml'),
      'tasks: []\n',
      'utf-8',
    );

    // When: running takt run
    const result = runTakt({
      args: ['run', '--provider', 'mock'],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: exits cleanly with code 0
    expect(result.exitCode).toBe(0);
  }, 240_000);
});
