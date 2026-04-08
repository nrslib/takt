import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

describe('E2E: Codex permission mode readonly/full', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let workflowPath: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    workflowPath = join(repo.path, 'permission-mode-e2e-workflow.yaml');

    writeFileSync(
      workflowPath,
      [
        'name: permission-mode-e2e',
        'description: Verify readonly/full behavior in codex sandbox',
        'max_steps: 3',
        'initial_step: write_check',
        'steps:',
        '  - name: write_check',
        '    agent: codex',
        '    provider_options:',
        '      claude:',
        '        allowed_tools:',
        '          - Bash',
        '    required_permission_mode: readonly',
        '    instruction: |',
        '      Run this exact command in repository root:',
        '      /bin/sh -lc \'printf "ok\\n" > epperm-check.txt\'',
        '      If file creation succeeds, reply exactly: COMPLETE',
        '    rules:',
        '      - condition: COMPLETE',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('readonly で失敗し full で成功する', () => {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider_profiles: {
        codex: { default_permission_mode: 'readonly' },
      },
    });

    const readonlyResult = runTakt({
      args: ['--task', 'Run write permission check', '--workflow', workflowPath],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    const readonlyOutput = `${readonlyResult.stdout}\n${readonlyResult.stderr}`;
    expect(existsSync(join(repo.path, 'epperm-check.txt'))).toBe(false);
    expect(
      [
        'EPERM',
        'permission denied',
        'Permission denied',
        'Operation not permitted',
        'read-only',
        'Read-only',
      ].some((marker) => readonlyOutput.includes(marker)),
    ).toBe(true);

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider_profiles: {
        codex: { default_permission_mode: 'full' },
      },
    });

    const fullResult = runTakt({
      args: ['--task', 'Run write permission check', '--workflow', workflowPath],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(fullResult.exitCode).toBe(0);
    expect(existsSync(join(repo.path, 'epperm-check.txt'))).toBe(true);
    expect(readFileSync(join(repo.path, 'epperm-check.txt'), 'utf-8')).toContain('ok');
  }, 300_000);
});
