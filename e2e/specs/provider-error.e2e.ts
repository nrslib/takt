import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-provider-'));
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
describe('E2E: Provider error handling (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: { path: string; cleanup: () => void };

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should override config provider with --provider flag', () => {
    // Given: config.yaml has provider: claude, but CLI flag specifies mock
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'claude',
    });

    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // When: running with --provider mock
    const result = runTakt({
      args: [
        '--task', 'Test provider override',
        '--piece', piecePath,
        '--create-worktree', 'no',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: executes successfully with mock provider
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
  }, 240_000);

  it('should use default mock response when scenario entries are exhausted', () => {
    // Given: a two-step piece with only 1 scenario entry
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-two-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/one-entry-only.json');

    // When: executing the piece (step-2 will have no scenario entry)
    const result = runTakt({
      args: [
        '--task', 'Test scenario exhaustion',
        '--piece', piecePath,
        '--create-worktree', 'no',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: does not crash; either completes or aborts gracefully
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('UnhandledPromiseRejection');
    expect(combined).not.toContain('SIGTERM');
  }, 240_000);

  it('should error when scenario file does not exist', () => {
    // Given: TAKT_MOCK_SCENARIO pointing to a non-existent file
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

    // When: executing with a bad scenario path
    const result = runTakt({
      args: [
        '--task', 'Test bad scenario',
        '--piece', piecePath,
        '--create-worktree', 'no',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: '/nonexistent/path/scenario.json',
      },
      timeout: 240_000,
    });

    // Then: exits with error and clear message
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/[Ss]cenario file not found|ENOENT/);
  }, 240_000);
});
