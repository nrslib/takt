import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

describe('E2E: Config commands', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  const resetCommands = [
    { label: 'config reset', args: ['config', 'reset'] },
    { label: 'reset config', args: ['reset', 'config'] },
  ];

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it.each(resetCommands)('should backup current config and sample then reset both from builtin templates via takt $label', ({ args }) => {
    const configPath = join(isolatedEnv.taktDir, 'config.yaml');
    const sampleConfigPath = join(isolatedEnv.taktDir, 'config.sample.yaml');
    writeFileSync(configPath, ['language: ja', 'provider: mock'].join('\n'), 'utf-8');
    writeFileSync(sampleConfigPath, '# custom sample\n# provider: custom\n', 'utf-8');

    const result = runTakt({
      args,
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toMatch(/reset/i);
    expect(output).toMatch(/backup:/i);
    expect(output).toMatch(/sample config:/i);
    expect(output).toMatch(/sample backup:/i);

    const config = readFileSync(configPath, 'utf-8');
    const activeLines = config.split('\n').filter((line) => !line.startsWith('#') && line.trim() !== '');
    expect(activeLines).toEqual(['language: ja']);

    const sampleConfig = readFileSync(sampleConfigPath, 'utf-8');
    expect(sampleConfig).toContain('#');
    expect(sampleConfig).toContain('provider');
    expect(sampleConfig).toContain('branch_name_strategy');
    expect(sampleConfig).toContain('concurrency');
    expect(sampleConfig).not.toContain('provider: custom');

    const backups = readdirSync(isolatedEnv.taktDir).filter((name) =>
      /^config\.yaml\.\d{8}-\d{6}\.old(\.\d+)?$/.test(name),
    );
    expect(backups.length).toBe(1);

    const sampleBackups = readdirSync(isolatedEnv.taktDir).filter((name) =>
      /^config\.sample\.yaml\.\d{8}-\d{6}\.old(\.\d+)?$/.test(name),
    );
    expect(sampleBackups.length).toBe(1);
  });
});
