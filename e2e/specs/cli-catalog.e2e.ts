import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

function createLocalRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-catalog-'));
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
describe('E2E: Catalog command (takt catalog)', () => {
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

  it('should list all facet types when no argument given', () => {
    // Given: a local repo with isolated env

    // When: running takt catalog
    const result = runTakt({
      args: ['catalog'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains facet type sections
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toLowerCase();
    expect(output).toMatch(/persona/);
  });

  it('should list facets for a specific type', () => {
    // Given: a local repo with isolated env

    // When: running takt catalog personas
    const result = runTakt({
      args: ['catalog', 'personas'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains persona names
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/coder/i);
  });

  it('should error for an invalid facet type', () => {
    // Given: a local repo with isolated env

    // When: running takt catalog with an invalid type
    const result = runTakt({
      args: ['catalog', 'invalidtype'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains an error or lists valid types
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/invalid|not found|valid types|unknown/i);
  });
});
