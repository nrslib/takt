import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Reset config command (takt reset config)', () => {
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

  it('should backup current config and replace with builtin template', () => {
    const configPath = join(isolatedEnv.taktDir, 'config.yaml');
    writeFileSync(configPath, ['language: ja', 'provider: mock'].join('\n'), 'utf-8');

    const result = runTakt({
      args: ['reset', 'config'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toMatch(/reset/i);
    expect(output).toMatch(/backup:/i);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain('language: ja');
    expect(config).toContain('branch_name_strategy: ai');
    expect(config).toContain('concurrency: 2');

    const backups = readdirSync(isolatedEnv.taktDir).filter((name) =>
      /^config\.yaml\.\d{8}-\d{6}\.old(\.\d+)?$/.test(name),
    );
    expect(backups.length).toBe(1);
  });
});
