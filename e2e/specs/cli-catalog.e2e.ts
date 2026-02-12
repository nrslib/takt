import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Catalog command (takt catalog)', () => {
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
