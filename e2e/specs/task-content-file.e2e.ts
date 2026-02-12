import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Task content_file reference (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

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

  it('should execute task using content_file reference', () => {
    // Given: a task with content_file pointing to an existing file
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
    const now = new Date().toISOString();

    mkdirSync(join(repo.path, '.takt'), { recursive: true });

    // Create the content file
    writeFileSync(
      join(repo.path, 'task-content.txt'),
      'Create a noop file for E2E testing.',
      'utf-8',
    );

    writeFileSync(
      join(repo.path, '.takt', 'tasks.yaml'),
      [
        'tasks:',
        '  - name: content-file-task',
        '    status: pending',
        '    content_file: "./task-content.txt"',
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

    // Then: task executes successfully
    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('content-file-task');
  }, 240_000);

  it('should fail when content_file references a nonexistent file', () => {
    // Given: a task with content_file pointing to a nonexistent file
    const now = new Date().toISOString();

    mkdirSync(join(repo.path, '.takt'), { recursive: true });

    writeFileSync(
      join(repo.path, '.takt', 'tasks.yaml'),
      [
        'tasks:',
        '  - name: bad-content-file-task',
        '    status: pending',
        '    content_file: "./nonexistent-content.txt"',
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
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: task fails with a meaningful error
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|ENOENT|missing|error/i);
  }, 240_000);
});
