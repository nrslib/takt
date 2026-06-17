import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockedPaths = vi.hoisted(() => ({
  configPath: '',
  sampleConfigPath: '',
  resourcesRoot: '',
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/paths.js')>();
  return {
    ...actual,
    getGlobalConfigPath: () => mockedPaths.configPath,
    getGlobalConfigSamplePath: () => mockedPaths.sampleConfigPath,
  };
});

vi.mock('../infra/resources/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/resources/index.js')>();
  return {
    ...actual,
    getLanguageResourcesDir: (lang: string) => join(mockedPaths.resourcesRoot, lang),
  };
});

import { resetGlobalConfigToTemplate } from '../infra/config/global/resetConfig.js';

describe('resetGlobalConfigToTemplate', () => {
  const originalEnv = process.env;
  let testRoot: string;
  let taktDir: string;
  let configPath: string;
  let sampleConfigPath: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'takt-reset-config-'));
    taktDir = join(testRoot, '.takt');
    mkdirSync(taktDir, { recursive: true });
    configPath = join(taktDir, 'config.yaml');
    sampleConfigPath = join(taktDir, 'config.sample.yaml');
    mockedPaths.configPath = configPath;
    mockedPaths.sampleConfigPath = sampleConfigPath;
    mockedPaths.resourcesRoot = join(process.cwd(), 'builtins');
    process.env = { ...originalEnv, TAKT_CONFIG_DIR: taktDir };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('should backup existing config and sample then replace both with language-matched templates', () => {
    writeFileSync(configPath, ['language: ja', 'provider: mock'].join('\n'), 'utf-8');
    writeFileSync(sampleConfigPath, '# custom sample\n# provider: custom\n', 'utf-8');

    const result = resetGlobalConfigToTemplate(new Date('2026-02-19T12:00:00Z'));

    expect(result.language).toBe('ja');
    expect(result.backupPath).toBeDefined();
    expect(result.sampleConfigPath).toBe(sampleConfigPath);
    expect(result.sampleBackupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(existsSync(result.sampleBackupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, 'utf-8')).toContain('provider: mock');
    expect(readFileSync(result.sampleBackupPath!, 'utf-8')).toContain('provider: custom');
    expect(result.sampleBackupPath).toContain('config.sample.yaml.');

    const newConfig = readFileSync(configPath, 'utf-8');
    const activeLines = newConfig.split('\n').filter(line => !line.startsWith('#') && line.trim() !== '');
    expect(activeLines).toEqual(['language: ja']);

    const sampleConfig = readFileSync(sampleConfigPath, 'utf-8');
    expect(sampleConfig).toContain('#');
    expect(sampleConfig).toContain('provider');
    expect(sampleConfig).toContain('branch_name_strategy');
    expect(sampleConfig).not.toContain('provider: custom');
  });

  it('should create config and sample from default language templates when config does not exist', () => {
    rmSync(configPath, { force: true });
    rmSync(sampleConfigPath, { force: true });

    const result = resetGlobalConfigToTemplate(new Date('2026-02-19T12:00:00Z'));

    expect(result.backupPath).toBeUndefined();
    expect(result.sampleBackupPath).toBeUndefined();
    expect(result.language).toBe('en');
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(sampleConfigPath)).toBe(true);
    const newConfig = readFileSync(configPath, 'utf-8');
    const activeLines = newConfig.split('\n').filter(line => !line.startsWith('#') && line.trim() !== '');
    expect(activeLines).toEqual(['language: en']);

    const sampleConfig = readFileSync(sampleConfigPath, 'utf-8');
    expect(sampleConfig).toContain('#');
    expect(sampleConfig).toContain('provider');
    expect(sampleConfig).toContain('concurrency');
  });

  it('should fail before backing up existing files when sample template is missing', () => {
    writeFileSync(configPath, 'language: en\nprovider: mock\n', 'utf-8');
    writeFileSync(sampleConfigPath, '# custom sample\n# provider: custom\n', 'utf-8');
    const resourcesRoot = join(testRoot, 'resources');
    const enResourcesDir = join(resourcesRoot, 'en');
    mkdirSync(enResourcesDir, { recursive: true });
    writeFileSync(join(enResourcesDir, 'config.yaml'), 'language: en\n', 'utf-8');
    mockedPaths.resourcesRoot = resourcesRoot;

    expect(() => resetGlobalConfigToTemplate(new Date('2026-02-19T12:00:00Z')))
      .toThrow(/Builtin config sample template not found/);

    expect(readFileSync(configPath, 'utf-8')).toBe('language: en\nprovider: mock\n');
    expect(readFileSync(sampleConfigPath, 'utf-8')).toBe('# custom sample\n# provider: custom\n');
    expect(readdirSync(taktDir).filter((name) => name.includes('.old'))).toEqual([]);
  });
});
