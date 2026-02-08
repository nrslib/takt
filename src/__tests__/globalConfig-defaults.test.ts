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

  it('should load auto_pr config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nauto_pr: true\n',
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.autoPr).toBe(true);
  });

  it('should save and reload auto_pr config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    // Create minimal config first
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.autoPr = true;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.autoPr).toBe(true);
  });

  it('should save auto_pr: false when explicitly set', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.autoPr = false;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.autoPr).toBe(false);
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

  it('should load prevent_sleep config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nprevent_sleep: true\n',
      'utf-8',
    );

    const config = loadGlobalConfig();

    expect(config.preventSleep).toBe(true);
  });

  it('should save and reload prevent_sleep config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.preventSleep = true;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.preventSleep).toBe(true);
  });

  it('should save prevent_sleep: false when explicitly set', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.preventSleep = false;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.preventSleep).toBe(false);
  });

  it('should have undefined preventSleep by default', () => {
    const config = loadGlobalConfig();
    expect(config.preventSleep).toBeUndefined();
  });

  it('should load notification_sound config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\nnotification_sound: false\n',
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.notificationSound).toBe(false);
  });

  it('should save and reload notification_sound config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.notificationSound = true;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.notificationSound).toBe(true);
  });

  it('should save notification_sound: false when explicitly set', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.notificationSound = false;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.notificationSound).toBe(false);
  });

  it('should have undefined notificationSound by default', () => {
    const config = loadGlobalConfig();
    expect(config.notificationSound).toBeUndefined();
  });

  it('should load interactive_preview_movements config from config.yaml', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\ninteractive_preview_movements: 5\n',
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.interactivePreviewMovements).toBe(5);
  });

  it('should save and reload interactive_preview_movements config', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    config.interactivePreviewMovements = 7;
    saveGlobalConfig(config);
    invalidateGlobalConfigCache();

    const reloaded = loadGlobalConfig();
    expect(reloaded.interactivePreviewMovements).toBe(7);
  });

  it('should default interactive_preview_movements to 3', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');

    const config = loadGlobalConfig();
    expect(config.interactivePreviewMovements).toBe(3);
  });

  it('should accept interactive_preview_movements: 0 to disable', () => {
    const taktDir = join(testHomeDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      'language: en\ninteractive_preview_movements: 0\n',
      'utf-8',
    );

    const config = loadGlobalConfig();
    expect(config.interactivePreviewMovements).toBe(0);
  });

  describe('provider/model compatibility validation', () => {
    it('should throw when provider is codex but model is a Claude alias (opus)', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: opus\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'opus' is a Claude model alias but provider is 'codex'/);
    });

    it('should throw when provider is codex but model is sonnet', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: sonnet\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'sonnet' is a Claude model alias but provider is 'codex'/);
    });

    it('should throw when provider is codex but model is haiku', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: haiku\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).toThrow(/model 'haiku' is a Claude model alias but provider is 'codex'/);
    });

    it('should not throw when provider is codex with a compatible model', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\nmodel: gpt-4o\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).not.toThrow();
    });

    it('should not throw when provider is claude with Claude models', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: claude\nmodel: opus\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).not.toThrow();
    });

    it('should not throw when provider is codex without a model', () => {
      const taktDir = join(testHomeDir, '.takt');
      mkdirSync(taktDir, { recursive: true });
      writeFileSync(
        getGlobalConfigPath(),
        'provider: codex\n',
        'utf-8',
      );

      expect(() => loadGlobalConfig()).not.toThrow();
    });
  });
});
