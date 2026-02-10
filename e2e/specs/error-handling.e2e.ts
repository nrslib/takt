import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-error-'));
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
describe('E2E: Error handling edge cases (mock)', () => {
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

  it('should error when --piece points to a nonexistent file path', () => {
    // Given: a nonexistent piece file path

    // When: running with a bad piece path
    const result = runTakt({
      args: [
        '--task', 'test',
        '--piece', '/nonexistent/path/to/piece.yaml',
        '--create-worktree', 'no',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: exits with error
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|does not exist|ENOENT/i);
  }, 240_000);

  it('should report error when --piece specifies a nonexistent piece name', () => {
    // Given: a nonexistent piece name

    // When: running with a bad piece name
    const result = runTakt({
      args: [
        '--task', 'test',
        '--piece', 'nonexistent-piece-name-xyz',
        '--create-worktree', 'no',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: output contains error about piece not found
    // Note: takt reports the error but currently exits with code 0
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found/i);
  }, 240_000);

  it('should error when --pipeline is used without --task or --issue', () => {
    // Given: pipeline mode with no task or issue
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

    // When: running in pipeline mode without a task
    const result = runTakt({
      args: [
        '--pipeline',
        '--piece', piecePath,
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

  it('should error when --create-worktree receives an invalid value', () => {
    // Given: invalid worktree value
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

    // When: running with invalid worktree option
    const result = runTakt({
      args: [
        '--task', 'test',
        '--piece', piecePath,
        '--create-worktree', 'invalid-value',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: exits with error or warning about invalid value
    const combined = result.stdout + result.stderr;
    const hasError = result.exitCode !== 0 || combined.match(/invalid|error|must be/i);
    expect(hasError).toBeTruthy();
  }, 240_000);

  it('should error when piece file contains invalid YAML', () => {
    // Given: a broken YAML piece file
    const brokenPiecePath = resolve(__dirname, '../fixtures/pieces/broken.yaml');

    // When: running with the broken piece
    const result = runTakt({
      args: [
        '--task', 'test',
        '--piece', brokenPiecePath,
        '--create-worktree', 'no',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Then: exits with error about parsing
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/parse|invalid|error|validation/i);
  }, 240_000);
});
