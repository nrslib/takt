import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Help command (takt --help)', () => {
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

  it('should display subcommand list with --help', () => {
    // Given: a local repo with isolated env

    // When: running takt --help
    const result = runTakt({
      args: ['--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output lists subcommands
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/run/);
    expect(result.stdout).toMatch(/add/);
    expect(result.stdout).toMatch(/list/);
    expect(result.stdout).toMatch(/eject/);
  });

  it('should display run subcommand help with takt run --help', () => {
    // Given: a local repo with isolated env

    // When: running takt run --help
    const result = runTakt({
      args: ['run', '--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains run command description
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toLowerCase();
    expect(output).toMatch(/run|task|pending/);
  });

  it('should show prompt argument help without current-piece wording', () => {
    // Given: a local repo with isolated env

    // When: running takt prompt --help
    const result = runTakt({
      args: ['prompt', '--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: prompt help uses explicit default piece wording
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/defaults to ["']default["']/i);
    expect(result.stdout).not.toMatch(/defaults to current/i);
  });

  it('should fail with unknown command for removed switch subcommand', () => {
    // Given: a local repo with isolated env

    // When: running removed takt switch command
    const result = runTakt({
      args: ['switch'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: command exits non-zero and reports unknown command
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).not.toBe(0);
    expect(combined).toMatch(/unknown command/i);
  });
});
