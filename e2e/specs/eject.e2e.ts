import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

describe('E2E: Eject builtin pieces (takt eject)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try {
      repo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should launch interactive menu and eject default piece when no args given', () => {
    const result = runTakt({
      args: ['eject'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);

    const piecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    expect(existsSync(piecePath)).toBe(true);

    const content = readFileSync(piecePath, 'utf-8');
    expect(content).toContain('name: default');
  });

  it('should warn and skip when piece already exists', () => {
    runTakt({
      args: ['eject'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    const result = runTakt({
      args: ['eject'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already exists|skip/i);
  });

  it('should preserve content of builtin piece YAML as-is', () => {
    runTakt({
      args: ['eject'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    const piecePath = join(repo.path, '.takt', 'pieces', 'default.yaml');
    const content = readFileSync(piecePath, 'utf-8');

    expect(content).toContain('name: default');
    expect(content).not.toContain('~/.takt/personas/');
  });
});
