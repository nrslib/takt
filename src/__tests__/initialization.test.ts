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
vi.mock('../prompt/index.js', () => ({
  selectOptionWithDefault: vi.fn().mockResolvedValue('ja'),
}));

// Import after mocks are set up
const { needsLanguageSetup } = await import('../config/initialization.js');
const { getGlobalAgentsDir, getGlobalWorkflowsDir } = await import('../config/paths.js');
const { copyLanguageResourcesToDir, getLanguageResourcesDir } = await import('../resources/index.js');

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
    it('should return true when neither agents nor workflows exist', () => {
      expect(needsLanguageSetup()).toBe(true);
    });

    it('should return true when only agents exists', () => {
      mkdirSync(getGlobalAgentsDir(), { recursive: true });
      expect(needsLanguageSetup()).toBe(true);
    });

    it('should return true when only workflows exists', () => {
      mkdirSync(getGlobalWorkflowsDir(), { recursive: true });
      expect(needsLanguageSetup()).toBe(true);
    });

    it('should return false when both agents and workflows exist', () => {
      mkdirSync(getGlobalAgentsDir(), { recursive: true });
      mkdirSync(getGlobalWorkflowsDir(), { recursive: true });
      expect(needsLanguageSetup()).toBe(false);
    });
  });

  describe('copyLanguageResourcesToDir', () => {
    it('should throw error when language directory does not exist', () => {
      const nonExistentLang = 'xx' as 'en' | 'ja';
      expect(() => copyLanguageResourcesToDir(testTaktDir, nonExistentLang)).toThrow(
        /Language resources not found/
      );
    });

    it('should copy language resources to target directory', () => {
      // This test requires actual language resources to exist
      const langDir = getLanguageResourcesDir('ja');
      if (existsSync(langDir)) {
        mkdirSync(testTaktDir, { recursive: true });
        copyLanguageResourcesToDir(testTaktDir, 'ja');

        // Verify that agents and workflows directories were created
        expect(existsSync(join(testTaktDir, 'agents'))).toBe(true);
        expect(existsSync(join(testTaktDir, 'workflows'))).toBe(true);
      }
    });
  });
});

describe('getLanguageResourcesDir', () => {
  it('should return correct path for English', () => {
    const path = getLanguageResourcesDir('en');
    expect(path).toContain('resources/global/en');
  });

  it('should return correct path for Japanese', () => {
    const path = getLanguageResourcesDir('ja');
    expect(path).toContain('resources/global/ja');
  });
});
