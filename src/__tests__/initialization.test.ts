/**
 * Tests for initialization module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the home directory to use a temp directory
const testHomeDir = join(tmpdir(), `takt-test-${Date.now()}`);
const testTaktDir = join(testHomeDir, '.takt');

const mockedResources = vi.hoisted(() => ({
  resourcesRoot: '',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testHomeDir,
  };
});

// Mock the prompt to avoid interactive input
vi.mock('../shared/prompt/index.js', () => ({
  selectOptionWithDefault: vi.fn().mockResolvedValue('ja'),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/paths.js')>();
  return {
    ...actual,
    getGlobalConfigDir: () => testTaktDir,
    getGlobalConfigPath: () => join(testTaktDir, 'config.yaml'),
    getGlobalConfigSamplePath: () => join(testTaktDir, 'config.sample.yaml'),
  };
});

vi.mock('../infra/resources/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/resources/index.js')>();
  return {
    ...actual,
    getLanguageResourcesDir: (lang: 'en' | 'ja') => {
      if (mockedResources.resourcesRoot !== '') {
        return join(mockedResources.resourcesRoot, lang);
      }
      return actual.getLanguageResourcesDir(lang);
    },
  };
});

// Import after mocks are set up
const { needsLanguageSetup, promptProviderSelection, initGlobalDirs } = await import('../infra/config/global/initialization.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { getGlobalConfigPath, getGlobalConfigSamplePath } = await import('../infra/config/paths.js');
const { copyProjectResourcesToDir, getLanguageResourcesDir, getProjectResourcesDir } = await import('../infra/resources/index.js');
const { selectOptionWithDefault } = await import('../shared/prompt/index.js');

const originalStdinIsTTY = process.stdin.isTTY;
const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
  });
}

function restoreStdinIsTTY(): void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalStdinIsTTY,
    configurable: true,
  });
}

function restoreTaktConfigDir(): void {
  if (originalTaktConfigDir === undefined) {
    delete process.env.TAKT_CONFIG_DIR;
    return;
  }
  process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
}

describe('initialization', () => {
  beforeEach(() => {
    invalidateGlobalConfigCache();
    mockedResources.resourcesRoot = '';
    process.env.TAKT_CONFIG_DIR = testTaktDir;
    // Create test home directory
    mkdirSync(testHomeDir, { recursive: true });
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    // Clean up test directory
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true });
    }
    restoreStdinIsTTY();
    restoreTaktConfigDir();
  });

  describe('needsLanguageSetup', () => {
    it('should return true when config.yaml does not exist', () => {
      expect(needsLanguageSetup()).toBe(true);
    });

    it('should return false when config.yaml exists', () => {
      mkdirSync(testTaktDir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), 'language: en\n', 'utf-8');
      expect(needsLanguageSetup()).toBe(false);
    });
  });

  describe('promptProviderSelection', () => {
    it('should include supported CLI provider choices and return the selected provider', async () => {
      vi.mocked(selectOptionWithDefault).mockResolvedValueOnce('kiro');

      const result = await promptProviderSelection();

      expect(result).toBe('kiro');
      expect(selectOptionWithDefault).toHaveBeenCalledWith(
        'Select provider / プロバイダーを選択してください:',
        expect.arrayContaining([
          { label: 'Claude Code terminal (experimental)', value: 'claude-terminal' },
          { label: 'Kiro CLI', value: 'kiro' },
        ]),
        'claude',
      );
    });
  });

  describe('initGlobalDirs', () => {
    it('should create config and commented sample during interactive initial setup', async () => {
      vi.mocked(selectOptionWithDefault)
        .mockResolvedValueOnce('ja')
        .mockResolvedValueOnce('codex');
      setStdinIsTTY(true);

      await initGlobalDirs();

      expect(existsSync(getGlobalConfigPath())).toBe(true);
      expect(existsSync(getGlobalConfigSamplePath())).toBe(true);

      const config = readFileSync(getGlobalConfigPath(), 'utf-8');
      expect(config).toContain('language: ja');
      expect(config).toContain('provider: codex');

      const sample = readFileSync(getGlobalConfigSamplePath(), 'utf-8');
      expect(sample).toContain('#');
      expect(sample).toContain('provider');
      expect(sample).toContain('branch_name_strategy');
    });

    it('should fail before creating config when the initial sample template is missing', async () => {
      const resourcesRoot = join(testHomeDir, 'resources');
      const jaResourcesDir = join(resourcesRoot, 'ja');
      mkdirSync(jaResourcesDir, { recursive: true });
      writeFileSync(join(jaResourcesDir, 'config.yaml'), 'language: ja\n', 'utf-8');
      mockedResources.resourcesRoot = resourcesRoot;
      vi.mocked(selectOptionWithDefault)
        .mockResolvedValueOnce('ja')
        .mockResolvedValueOnce('codex');
      setStdinIsTTY(true);

      await expect(initGlobalDirs()).rejects.toThrow(/Builtin config template not found: .*config\.sample\.yaml/);

      expect(existsSync(getGlobalConfigPath())).toBe(false);
      expect(existsSync(getGlobalConfigSamplePath())).toBe(false);
    });

    it('should not overwrite an existing sample during interactive initial setup', async () => {
      const existingSample = '# user-owned sample\n# provider: custom\n';
      mkdirSync(testTaktDir, { recursive: true });
      writeFileSync(getGlobalConfigSamplePath(), existingSample, 'utf-8');
      vi.mocked(selectOptionWithDefault)
        .mockResolvedValueOnce('en')
        .mockResolvedValueOnce('claude');
      setStdinIsTTY(true);

      await initGlobalDirs();

      expect(readFileSync(getGlobalConfigSamplePath(), 'utf-8')).toBe(existingSample);
    });
  });

});

describe('copyProjectResourcesToDir', () => {
  const testProjectDir = join(tmpdir(), `takt-project-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testProjectDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true });
    }
  });

  it('should rename dotgitignore to .gitignore during copy', () => {
    const resourcesDir = getProjectResourcesDir();
    if (!existsSync(join(resourcesDir, 'dotgitignore'))) {
      return; // Skip if resource file doesn't exist
    }

    copyProjectResourcesToDir(testProjectDir);

    expect(existsSync(join(testProjectDir, '.gitignore'))).toBe(true);
    expect(existsSync(join(testProjectDir, 'dotgitignore'))).toBe(false);
  });
});

describe('getLanguageResourcesDir', () => {
  it('should return correct path for English', () => {
    const path = getLanguageResourcesDir('en');
    expect(path).toContain('builtins/en');
  });

  it('should return correct path for Japanese', () => {
    const path = getLanguageResourcesDir('ja');
    expect(path).toContain('builtins/ja');
  });
});
