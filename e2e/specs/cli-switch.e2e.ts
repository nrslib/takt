import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Switch piece command (takt switch)', () => {
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

  it('should switch piece when a valid piece name is given', () => {
    // Given: a local repo with isolated env

    // When: running takt switch default
    const result = runTakt({
      args: ['switch', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: exits successfully
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toLowerCase();
    expect(output).toMatch(/default|switched|piece/);
  });

  it('should error when a nonexistent piece name is given', () => {
    // Given: a local repo with isolated env

    // When: running takt switch with a nonexistent piece name
    const result = runTakt({
      args: ['switch', 'nonexistent-piece-xyz'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: error output
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|error|does not exist/i);
  });
});
