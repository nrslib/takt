import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Config command (takt config)', () => {
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

  it('should switch to default mode with explicit argument', () => {
    // Given: a local repo with isolated env

    // When: running takt config default
    const result = runTakt({
      args: ['config', 'default'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: exits successfully and outputs switched message
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toMatch(/Switched to: default/);
  });

  it('should switch to sacrifice-my-pc mode with explicit argument', () => {
    // Given: a local repo with isolated env

    // When: running takt config sacrifice-my-pc
    const result = runTakt({
      args: ['config', 'sacrifice-my-pc'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: exits successfully and outputs switched message
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toMatch(/Switched to: sacrifice-my-pc/);
  });

  it('should persist permission mode to project config', () => {
    // Given: a local repo with isolated env

    // When: running takt config sacrifice-my-pc
    runTakt({
      args: ['config', 'sacrifice-my-pc'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: .takt/config.yaml contains permissionMode: sacrifice-my-pc
    const configPath = join(repo.path, '.takt', 'config.yaml');
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/permissionMode:\s*sacrifice-my-pc/);
  });

  it('should report error for invalid mode name', () => {
    // Given: a local repo with isolated env

    // When: running takt config with an invalid mode
    const result = runTakt({
      args: ['config', 'invalid-mode'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains invalid mode message
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Invalid mode/);
  });
});
