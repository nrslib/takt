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

    // Then: catalog command succeeds
    expect(result.exitCode).toBe(0);
  });

  it('should list facets for a specific type', () => {
    // Given: a local repo with isolated env

    // When: running takt catalog personas
    const result = runTakt({
      args: ['catalog', 'personas'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: catalog command succeeds
    expect(result.exitCode).toBe(0);
  });

});
