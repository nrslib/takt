import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Workflow authoring CLI', () => {
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

  it('should create a workflow scaffold and validate it by name', () => {
    const initResult = runTakt({
      args: ['workflow', 'init', 'sample-flow'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(initResult.exitCode).toBe(0);
    const workflowPath = join(repo.path, '.takt', 'workflows', 'sample-flow.yaml');
    expect(existsSync(workflowPath)).toBe(true);

    const doctorResult = runTakt({
      args: ['workflow', 'doctor', 'sample-flow'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(doctorResult.exitCode).toBe(0);
    expect(doctorResult.stdout).toContain('Workflow OK');
  });

  it('should fail doctor for a broken workflow path', () => {
    const workflowsDir = join(repo.path, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const brokenPath = join(workflowsDir, 'broken.yaml');
    writeFileSync(brokenPath, `name: broken
max_steps: 10
initial_step: step1
steps:
  - name: step1
    rules:
      - condition: done
        next: missing-step
`, 'utf-8');

    const result = runTakt({
      args: ['workflow', 'doctor', brokenPath],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('unknown next step');
  });

  it('should expose workflow authoring commands in help output', () => {
    const result = runTakt({
      args: ['workflow', '--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('doctor');
  });
});
