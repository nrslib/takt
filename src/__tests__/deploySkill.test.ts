/**
 * Tests for deploySkill (export-cc) command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock home directory to use temp directory
const testHomeDir = mkdtempSync(join(tmpdir(), 'takt-deploy-test-'));

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testHomeDir,
  };
});

// Mock confirm to always accept
vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

// Mock UI functions to suppress output
vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  blankLine: vi.fn(),
}));

// Mock getLanguage
vi.mock('../infra/config/index.js', () => ({
  getLanguage: vi.fn().mockReturnValue('en'),
}));

// Create fake resources directories
let fakeResourcesDir: string;

vi.mock('../infra/resources/index.js', async () => {
  const actual = await vi.importActual('../infra/resources/index.js');
  return {
    ...actual,
    getResourcesDir: () => fakeResourcesDir,
    getLanguageResourcesDir: (lang: string) => join(fakeResourcesDir, lang),
  };
});

// Import after mocks are set up
const { deploySkill } = await import('../features/config/deploySkill.js');
const { warn, info } = await import('../shared/ui/index.js');
const { confirm } = await import('../shared/prompt/index.js');

describe('deploySkill', () => {
  let skillDir: string;

  beforeEach(() => {
    // Create fake resources directory with skill files
    fakeResourcesDir = mkdtempSync(join(tmpdir(), 'takt-resources-'));

    // Create skill/ directory with required files
    const skillResourcesDir = join(fakeResourcesDir, 'skill');
    mkdirSync(skillResourcesDir, { recursive: true });
    writeFileSync(join(skillResourcesDir, 'SKILL.md'), '# SKILL');
    // Create skill/references/ directory
    const refsDir = join(skillResourcesDir, 'references');
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, 'engine.md'), '# Engine');
    writeFileSync(join(refsDir, 'yaml-schema.md'), '# Schema');

    // Create language-specific directories (en/)
    const langDir = join(fakeResourcesDir, 'en');
    mkdirSync(join(langDir, 'workflows'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'personas'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'policies'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'instructions'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'knowledge'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'output-contracts'), { recursive: true });
    mkdirSync(join(langDir, 'templates'), { recursive: true });

    // Add sample files
    writeFileSync(join(langDir, 'workflows', 'default.yaml'), 'name: default');
    writeFileSync(join(langDir, 'facets', 'personas', 'coder.md'), '# Coder');
    writeFileSync(join(langDir, 'facets', 'policies', 'coding.md'), '# Coding');
    writeFileSync(join(langDir, 'facets', 'instructions', 'init.md'), '# Init');
    writeFileSync(join(langDir, 'facets', 'knowledge', 'patterns.md'), '# Patterns');
    writeFileSync(join(langDir, 'facets', 'output-contracts', 'summary.md'), '# Summary');
    writeFileSync(join(langDir, 'templates', 'task.md'), '# legacy template');

    // Create target directories
    skillDir = join(testHomeDir, '.claude', 'skills', 'takt');
    mkdirSync(skillDir, { recursive: true });

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
    if (existsSync(fakeResourcesDir)) {
      rmSync(fakeResourcesDir, { recursive: true, force: true });
    }
    // Recreate test home for next test
    mkdirSync(testHomeDir, { recursive: true });
  });

  describe('when skill resources exist', () => {
    it('should copy SKILL.md to skill directory', async () => {
      await deploySkill();

      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe('# SKILL');
    });

    it('should copy references directory', async () => {
      await deploySkill();

      const refsDir = join(skillDir, 'references');
      expect(existsSync(refsDir)).toBe(true);
      expect(existsSync(join(refsDir, 'engine.md'))).toBe(true);
      expect(existsSync(join(refsDir, 'yaml-schema.md'))).toBe(true);
    });

    it('should copy facets and workflows from language resources', async () => {
      await deploySkill();

      // Verify each resource directory is copied
      expect(existsSync(join(skillDir, 'workflows', 'default.yaml'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'personas', 'coder.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'policies', 'coding.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'instructions', 'init.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'knowledge', 'patterns.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'output-contracts', 'summary.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'templates'))).toBe(false);
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('テンプレート'));
    });

    // Regression #565 / 565-TESTS-DEPLOY-SKILL-WORKFLOWS: workflow YAMLs deploy under workflows/, not pieces/
    it('should not create a pieces directory for workflow YAMLs', async () => {
      await deploySkill();
      expect(existsSync(join(skillDir, 'workflows', 'default.yaml'))).toBe(true);
      expect(existsSync(join(skillDir, 'pieces'))).toBe(false);
    });
  });

  describe('cleanDir behavior', () => {
    it('should remove stale files from previous deployments', async () => {
      // Create a stale file in skill directory
      const workflowsDir = join(skillDir, 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, 'stale.yaml'), 'name: stale');

      await deploySkill();

      // Stale file should be removed, new file should exist
      expect(existsSync(join(workflowsDir, 'stale.yaml'))).toBe(false);
      expect(existsSync(join(workflowsDir, 'default.yaml'))).toBe(true);
    });

    it('should clean references directory before copy', async () => {
      // Create a stale file in references
      const refsDir = join(skillDir, 'references');
      mkdirSync(refsDir, { recursive: true });
      writeFileSync(join(refsDir, 'old-reference.md'), '# Old');

      await deploySkill();

      expect(existsSync(join(refsDir, 'old-reference.md'))).toBe(false);
      expect(existsSync(join(refsDir, 'engine.md'))).toBe(true);
    });

    it('should remove stale templates directory from previous deployments', async () => {
      writeFileSync(join(skillDir, 'SKILL.md'), '# Old Skill');
      const templatesDir = join(skillDir, 'templates');
      mkdirSync(templatesDir, { recursive: true });
      writeFileSync(join(templatesDir, 'task.md'), '# stale template');

      await deploySkill();

      expect(existsSync(templatesDir)).toBe(false);
    });

    it('should remove stale templates directory even without existing SKILL.md', async () => {
      const templatesDir = join(skillDir, 'templates');
      mkdirSync(templatesDir, { recursive: true });
      writeFileSync(join(templatesDir, 'task.md'), '# stale template');

      await deploySkill();

      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(existsSync(templatesDir)).toBe(false);
    });
  });

  describe('when skill resources do not exist', () => {
    it('should warn and return early', async () => {
      // Remove skill resources directory
      rmSync(join(fakeResourcesDir, 'skill'), { recursive: true });

      await deploySkill();

      expect(warn).toHaveBeenCalledWith('Skill resources not found. Ensure takt is installed correctly.');
    });
  });

  describe('when skill already exists', () => {
    it('should ask for confirmation before overwriting', async () => {
      // Create existing SKILL.md
      writeFileSync(join(skillDir, 'SKILL.md'), '# Old Skill');

      await deploySkill();

      expect(confirm).toHaveBeenCalledWith(
        '既存のスキルファイルをすべて削除し、最新版に置き換えます。続行しますか？',
        false,
      );
    });

    it('should cancel when user declines confirmation', async () => {
      // Mock confirm to return false
      vi.mocked(confirm).mockResolvedValueOnce(false);

      // Create existing SKILL.md
      writeFileSync(join(skillDir, 'SKILL.md'), '# Old Skill');

      await deploySkill();

      // File should remain unchanged
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe('# Old Skill');
    });
  });

  describe('when language resources directory is empty', () => {
    it('should handle missing resource subdirectories gracefully', async () => {
      // Remove all resource subdirectories from language dir
      const langDir = join(fakeResourcesDir, 'en');
      rmSync(langDir, { recursive: true });
      mkdirSync(langDir, { recursive: true });

      // Should not throw
      await expect(deploySkill()).resolves.not.toThrow();
    });
  });
});
