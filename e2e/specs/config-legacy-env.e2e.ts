import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Legacy config env rejection', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    repo.cleanup();
    isolatedEnv.cleanup();
  });

  it('should fail fast when a removed legacy workflow env is set', () => {
    const result = runTakt({
      args: ['list'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS: 'true',
      },
    });

    expect(result.exitCode).toBe(1);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toMatch(/piece_runtime_prepare/i);
    expect(combined).toMatch(/removed/i);
  });

  it('should report removed legacy workflow env even when the value is invalid JSON', () => {
    const result = runTakt({
      args: ['list'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_PIECE_RUNTIME_PREPARE: '{',
      },
    });

    expect(result.exitCode).toBe(1);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toMatch(/piece_runtime_prepare/i);
    expect(combined).toMatch(/removed/i);
    expect(combined).not.toMatch(/valid JSON/i);
  });
});
