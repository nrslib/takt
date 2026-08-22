/**
 * Tests for initGlobalDirs non-interactive mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
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
  confirm: vi.fn(),
}));

// Import after mocks are set up
const { initGlobalDirs, needsLanguageSetup } = await import('../infra/config/global/initialization.js');
const { getGlobalConfigPath, getGlobalConfigDir } = await import('../infra/config/paths.js');

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
});
