/**
 * Tests for initGlobalDirs non-interactive mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the home directory to use a temp directory
const testHomeDir = join(tmpdir(), `takt-init-ni-test-${Date.now()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testHomeDir,
  };
});

// Mock the prompt to track if it was called
const mockSelectOption = vi.fn().mockResolvedValue('en');
vi.mock('../shared/prompt/index.js', () => ({
  selectOptionWithDefault: mockSelectOption,
}));

// Import after mocks are set up
const { initGlobalDirs, initProjectDirs, needsLanguageSetup } = await import('../infra/config/global/initialization.js');
const { getGlobalConfigPath, getGlobalConfigDir, getProjectConfigDir } = await import('../infra/config/paths.js');

describe('initGlobalDirs with non-interactive mode', () => {
  beforeEach(() => {
    mkdirSync(testHomeDir, { recursive: true });
    mockSelectOption.mockClear();
  });

  afterEach(() => {
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true });
    }
  });

  it('should skip prompts when nonInteractive is true', async () => {
    expect(needsLanguageSetup()).toBe(true);

    await initGlobalDirs({ nonInteractive: true });

    // Prompts should NOT have been called
    expect(mockSelectOption).not.toHaveBeenCalled();
    // Config should still not exist (we use defaults via loadGlobalConfig fallback)
    expect(existsSync(getGlobalConfigPath())).toBe(false);
  });

  it('should create global config directory even in non-interactive mode', async () => {
    await initGlobalDirs({ nonInteractive: true });

    expect(existsSync(getGlobalConfigDir())).toBe(true);
  });

  it('should skip project config initialization on the default home directory path', () => {
    const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

    try {
      delete process.env.TAKT_CONFIG_DIR;

      const projectDir = testHomeDir;
      const projectConfigDir = getProjectConfigDir(projectDir);
      expect(projectConfigDir).toBe(getGlobalConfigDir());
      expect(existsSync(projectConfigDir)).toBe(false);

      initProjectDirs(projectDir);

      expect(existsSync(projectConfigDir)).toBe(false);
    } finally {
      if (originalTaktConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
      }
    }
  });

  it('should skip project config initialization when project config dir collides with global config dir', () => {
    const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

    try {
      process.env.TAKT_CONFIG_DIR = join(testHomeDir, '.takt');

      const projectDir = testHomeDir;
      const projectConfigDir = getProjectConfigDir(projectDir);
      expect(projectConfigDir).toBe(getGlobalConfigDir());
      expect(existsSync(projectConfigDir)).toBe(false);

      initProjectDirs(projectDir);

      expect(existsSync(projectConfigDir)).toBe(false);
    } finally {
      if (originalTaktConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
      }
    }
  });

  it('should skip project config initialization when TAKT_CONFIG_DIR symlinks to the project config dir', () => {
    const realGlobalDir = join(tmpdir(), `takt-init-real-${Date.now()}`);
    const symlinkGlobalDir = join(tmpdir(), `takt-init-link-${Date.now()}`);
    const projectDir = join(tmpdir(), `takt-init-project-${Date.now()}`);
    const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

    try {
      mkdirSync(realGlobalDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      symlinkSync(realGlobalDir, join(projectDir, '.takt'));
      symlinkSync(realGlobalDir, symlinkGlobalDir);
      process.env.TAKT_CONFIG_DIR = symlinkGlobalDir;

      initProjectDirs(projectDir);

      expect(existsSync(join(realGlobalDir, '.gitignore'))).toBe(false);
    } finally {
      if (originalTaktConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(symlinkGlobalDir, { force: true });
      rmSync(realGlobalDir, { recursive: true, force: true });
    }
  });
});
