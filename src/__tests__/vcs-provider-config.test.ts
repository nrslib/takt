/**
 * Tests for vcsProvider config wiring.
 *
 * Verifies that vcs_provider in YAML config is correctly loaded as vcsProvider
 * and saved back as vcs_provider (snake_case ↔ camelCase round-trip).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';

describe('vcsProvider project config wiring', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-test-vcs-provider-'));
    mkdirSync(join(testDir, '.takt'), { recursive: true });
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('vcs_provider: github を vcsProvider として読み込む', () => {
    // Given
    const configPath = join(testDir, '.takt', 'config.yaml');
    writeFileSync(configPath, 'vcs_provider: github\n', 'utf-8');

    // When
    const loaded = loadProjectConfig(testDir);

    // Then
    expect(loaded.vcsProvider).toBe('github');
  });

  it('vcs_provider: gitlab を vcsProvider として読み込む', () => {
    // Given
    const configPath = join(testDir, '.takt', 'config.yaml');
    writeFileSync(configPath, 'vcs_provider: gitlab\n', 'utf-8');

    // When
    const loaded = loadProjectConfig(testDir);

    // Then
    expect(loaded.vcsProvider).toBe('gitlab');
  });

  it('vcs_provider が未設定の場合 vcsProvider は undefined', () => {
    // Given
    const configPath = join(testDir, '.takt', 'config.yaml');
    writeFileSync(configPath, 'provider: claude\n', 'utf-8');

    // When
    const loaded = loadProjectConfig(testDir);

    // Then
    expect(loaded.vcsProvider).toBeUndefined();
  });

  it('vcsProvider を save → load でラウンドトリップできる', () => {
    // Given
    const configPath = join(testDir, '.takt', 'config.yaml');
    writeFileSync(configPath, '', 'utf-8');

    // When
    saveProjectConfig(testDir, { vcsProvider: 'gitlab' });
    const loaded = loadProjectConfig(testDir);

    // Then
    expect(loaded.vcsProvider).toBe('gitlab');
  });

  it('save 後の YAML ファイルに vcs_provider（snake_case）が含まれる', () => {
    // Given
    const configPath = join(testDir, '.takt', 'config.yaml');
    writeFileSync(configPath, '', 'utf-8');

    // When
    saveProjectConfig(testDir, { vcsProvider: 'gitlab' });

    // Then
    const yaml = readFileSync(configPath, 'utf-8');
    expect(yaml).toContain('vcs_provider');
    expect(yaml).not.toContain('vcsProvider');
  });
});

describe('vcsProvider global config wiring', () => {
  let testDir: string;
  let testConfigPath: string;

  // Dynamic import to avoid module-level mock conflicts
  let GlobalConfigManager: typeof import('../infra/config/global/globalConfigCore.js').GlobalConfigManager;

  beforeEach(async () => {
    vi.resetModules();
    testDir = mkdtempSync(join(tmpdir(), 'takt-test-vcs-global-'));
    mkdirSync(testDir, { recursive: true });
    testConfigPath = join(testDir, 'config.yaml');

    vi.doMock('../infra/config/paths.js', () => ({
      getGlobalConfigPath: () => testConfigPath,
      getGlobalTaktDir: () => testDir,
      getProjectTaktDir: vi.fn(),
      getProjectCwd: vi.fn(),
    }));

    const mod = await import('../infra/config/global/globalConfigCore.js');
    GlobalConfigManager = mod.GlobalConfigManager;
    GlobalConfigManager.resetInstance();
  });

  afterEach(() => {
    GlobalConfigManager.resetInstance();
    vi.doUnmock('../infra/config/paths.js');
    vi.resetModules();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('グローバル設定の vcs_provider: gitlab を読み込む', () => {
    // Given
    writeFileSync(testConfigPath, 'language: en\nvcs_provider: gitlab\n', 'utf-8');

    // When
    const manager = GlobalConfigManager.getInstance();
    const loaded = manager.load();

    // Then
    expect(loaded.vcsProvider).toBe('gitlab');
  });

  it('グローバル設定の vcs_provider が未設定の場合 undefined', () => {
    // Given
    writeFileSync(testConfigPath, 'language: en\n', 'utf-8');

    // When
    const manager = GlobalConfigManager.getInstance();
    const loaded = manager.load();

    // Then
    expect(loaded.vcsProvider).toBeUndefined();
  });
});
