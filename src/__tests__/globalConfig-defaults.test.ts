/**
 * Tests for loadGlobalConfig default values when config.yaml is missing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';

// Mock the home directory to use a temp directory
const testHomeDir = join(tmpdir(), `takt-gc-test-${Date.now()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testHomeDir,
  };
});

// Import after mocks are set up
const { loadGlobalConfig, saveGlobalConfig, invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { getGlobalConfigPath } = await import('../infra/config/paths.js');

describe('loadGlobalConfig', () => {
  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(testHomeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true });
    }
  });

  it('should return default values when config.yaml does not exist', () => {
    const config = loadGlobalConfig();

    expect(config.language).toBe('en');
    expect(config.defaultPiece).toBe('default');
    expect(config.logLevel).toBe('info');
    expect(config.provider).toBe('claude');
    expect(config.model).toBeUndefined();
    expect(config.debug).toBeUndefined();
    expect(config.pipeline).toBeUndefined();
  });

  it('should return the same cached object on subsequent calls', () => {
    const config1 = loadGlobalConfig();
    const config2 = loadGlobalConfig();

    expect(config1).toBe(config2);
  });

  it('should return a fresh object after cache invalidation', () => {
    const config1 = loadGlobalConfig();
    invalidateGlobalConfigCache();
    const config2 = loadGlobalConfig();

    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });

  it('should load from config.yaml when it exists', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: ja\nprovider: codex\nlog_level: debug\n',
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.language).toBe('ja');
    expect(config.provider).toBe('codex');
    expect(config.logLevel).toBe('debug');
  });

  it('should load pipeline config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      [
        'language: en',
        'pipeline:',
        '  default_branch_prefix: "feat/"',
        '  commit_message_template: "fix: {title} (#{issue})"',
      ].join('\n'),
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.pipeline).toBeDefined();
    expect(config.pipeline!.defaultBranchPrefix).toBe('feat/');
    expect(config.pipeline!.commitMessageTemplate).toBe('fix: {title} (#{issue})');
    expect(config.pipeline!.prBodyTemplate).toBeUndefined();
  });

  it('should save and reload pipeline config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    // Create minimal config first
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.pipeline = {
      defaultBranchPrefix: 'takt/',
      commitMessageTemplate: 'feat: {title} (#{issue})',
    };
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.pipeline).toBeDefined();
    expect(reloaded.pipeline!.defaultBranchPrefix).toBe('takt/');
    expect(reloaded.pipeline!.commitMessageTemplate).toBe('feat: {title} (#{issue})');
  });

  it('should read from cache without hitting disk on second call', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: ja\nprovider: codex\n',
      'utf-8',
    );

    const config1 = loadGlobalConfig();
    expect(config1.language).toBe('ja');

    // Overwrite file on disk - cached result should still be returned
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nprovider: claude\n',
      'utf-8',
    );

    const config2 = loadGlobalConfig();
    expect(config2.language).toBe('ja');
    expect(config2).toBe(config1);

    // After invalidation, the new file content is read
    invalidateGlobalConfigCache();
    const config3 = loadGlobalConfig();
    expect(config3.language).toBe('en');
    expect(config3).not.toBe(config1);
  });
});
