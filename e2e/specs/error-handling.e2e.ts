import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Error handling edge cases (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should error when --workflow points to a nonexistent file path', () => {
    // Given: a nonexistent workflow file path

    // When: running with a bad workflow path
    const result = runTakt({
      args: [
        '--task', 'test',
        '--workflow', '/nonexistent/path/to/workflow.yaml',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: exits with error
    expect(result.exitCode).not.toBe(0);
  }, 240_000);

  it('should error when --pipeline is used without --task or --issue', () => {
    // Given: pipeline mode with no task or issue
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');

    // When: running in pipeline mode without a task
    const result = runTakt({
      args: [
        '--pipeline',
        '--workflow', workflowPath,
        '--skip-git',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: exits with error (should not hang in interactive mode due to TAKT_NO_TTY=1)
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/task|issue|required/i);
  }, 240_000);

  it('should error when workflow file contains invalid YAML', () => {
    // Given: a broken YAML workflow file
    const brokenWorkflowPath = resolve(__dirname, '../fixtures/workflows/broken.yaml');

    // When: running with the broken workflow
    const result = runTakt({
      args: [
        '--task', 'test',
        '--workflow', brokenWorkflowPath,
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: exits with an error
    expect(result.exitCode).not.toBe(0);
  }, 240_000);
});
