/**
 * Tests for initialization module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the home directory to use a temp directory
const testHomeDir = join(tmpdir(), `takt-test-${Date.now()}`);
const testTaktDir = join(testHomeDir, '.takt');

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

// Import after mocks are set up
const { needsLanguageSetup, promptProviderSelection } = await import('../infra/config/global/initialization.js');
const { getGlobalConfigPath } = await import('../infra/config/paths.js');
const { copyProjectResourcesToDir, getLanguageResourcesDir, getProjectResourcesDir } = await import('../infra/resources/index.js');
const { selectOptionWithDefault } = await import('../shared/prompt/index.js');

describe('initialization', () => {
  beforeEach(() => {
    // Create test home directory
    mkdirSync(testHomeDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true });
    }
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
    it('should include claude-terminal in provider choices and return the selected provider', async () => {
      vi.mocked(selectOptionWithDefault).mockResolvedValueOnce('claude-terminal');

      const result = await promptProviderSelection();

      expect(result).toBe('claude-terminal');
      expect(selectOptionWithDefault).toHaveBeenCalledWith(
        'Select provider / プロバイダーを選択してください:',
        expect.arrayContaining([
          { label: 'Claude Code terminal (experimental)', value: 'claude-terminal' },
        ]),
        'claude',
      );
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
