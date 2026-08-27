import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { packageVersion } from '../../src/shared/package-info';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Help command (takt --help)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  const cleanupResources = (): void => {
    const errors: unknown[] = [];

    try {
      repo.cleanup();
    } catch (error) {
      errors.push(error);
    }

    try {
      isolatedEnv.cleanup();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, 'Failed to clean up E2E help test resources');
    }
  };

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    cleanupResources();
  });

  it('should display the package version with --version', () => {
    const result = runTakt({
      args: ['--version'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
  });

  it('should advertise Workflow Maker in the root help', () => {
    const result = runTakt({
      args: ['--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\bmake\b.*Workflow Maker/i);
    expect(result.stdout).not.toContain('Workflow Builder');
  });

  it('should fail with unknown command for removed switch subcommand', () => {
    // Given: a local repo with isolated env

    // When: running removed takt switch command
    const result = runTakt({
      args: ['switch'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: the removed command is rejected
    expect(result.exitCode).not.toBe(0);
  });

  it('should reject Workflow Maker without a terminal before creating artifacts', () => {
    const result = runTakt({
      args: ['make'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/interactive terminal|TTY/i);
    expect(existsSync(join(repo.path, '.takt', 'make'))).toBe(false);
  });
});
