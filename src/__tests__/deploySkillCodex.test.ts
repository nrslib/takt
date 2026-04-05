/**
 * Tests for deploySkillCodex (export-codex) command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testHomeDir = mkdtempSync(join(tmpdir(), 'takt-deploy-codex-test-'));

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testHomeDir,
  };
});

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  getLanguage: vi.fn().mockReturnValue('en'),
}));

let fakeResourcesDir: string;

vi.mock('../infra/resources/index.js', async () => {
  const actual = await vi.importActual('../infra/resources/index.js');
  return {
    ...actual,
    getResourcesDir: () => fakeResourcesDir,
    getLanguageResourcesDir: (lang: string) => join(fakeResourcesDir, lang),
  };
});

const configFeatures = await import('../features/config/index.js');
const deploySkillCodex = (configFeatures as Record<string, unknown>).deploySkillCodex as () => Promise<void>;
const { warn, info } = await import('../shared/ui/index.js');
const { confirm } = await import('../shared/prompt/index.js');

describe('deploySkillCodex', () => {
  let skillDir: string;

  beforeEach(() => {
    fakeResourcesDir = mkdtempSync(join(tmpdir(), 'takt-resources-codex-'));

    const skillResourcesDir = join(fakeResourcesDir, 'skill-codex');
    mkdirSync(skillResourcesDir, { recursive: true });
    writeFileSync(join(skillResourcesDir, 'SKILL.md'), '# SKILL Codex');

    const refsDir = join(skillResourcesDir, 'references');
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, 'engine.md'), '# Engine');
    writeFileSync(join(refsDir, 'yaml-schema.md'), '# Schema');

    const agentsDir = join(skillResourcesDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'openai.yaml'), 'interface:\n  display_name: TAKT');

    const langDir = join(fakeResourcesDir, 'en');
    mkdirSync(join(langDir, 'workflows'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'personas'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'policies'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'instructions'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'knowledge'), { recursive: true });
    mkdirSync(join(langDir, 'facets', 'output-contracts'), { recursive: true });
    mkdirSync(join(langDir, 'templates'), { recursive: true });

    writeFileSync(join(langDir, 'workflows', 'default.yaml'), 'name: default');
    writeFileSync(join(langDir, 'facets', 'personas', 'coder.md'), '# Coder');
    writeFileSync(join(langDir, 'facets', 'policies', 'coding.md'), '# Coding');
    writeFileSync(join(langDir, 'facets', 'instructions', 'init.md'), '# Init');
    writeFileSync(join(langDir, 'facets', 'knowledge', 'patterns.md'), '# Patterns');
    writeFileSync(join(langDir, 'facets', 'output-contracts', 'summary.md'), '# Summary');
    writeFileSync(join(langDir, 'templates', 'task.md'), '# legacy template');

    skillDir = join(testHomeDir, '.agents', 'skills', 'takt');
    mkdirSync(skillDir, { recursive: true });

    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
    if (existsSync(fakeResourcesDir)) {
      rmSync(fakeResourcesDir, { recursive: true, force: true });
    }
    mkdirSync(testHomeDir, { recursive: true });
  });

  describe('when codex skill resources exist', () => {
    it('should copy SKILL.md to codex skill directory', async () => {
      await deploySkillCodex();

      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe('# SKILL Codex');
    });

    it('should copy references directory', async () => {
      await deploySkillCodex();

      const refsDir = join(skillDir, 'references');
      expect(existsSync(refsDir)).toBe(true);
      expect(existsSync(join(refsDir, 'engine.md'))).toBe(true);
      expect(existsSync(join(refsDir, 'yaml-schema.md'))).toBe(true);
    });

    it('should copy agents/openai.yaml', async () => {
      await deploySkillCodex();

      expect(existsSync(join(skillDir, 'agents', 'openai.yaml'))).toBe(true);
    });

    it('should copy facets and workflows from language resources', async () => {
      await deploySkillCodex();

      expect(existsSync(join(skillDir, 'workflows', 'default.yaml'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'personas', 'coder.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'policies', 'coding.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'instructions', 'init.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'knowledge', 'patterns.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'facets', 'output-contracts', 'summary.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'templates'))).toBe(false);
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('テンプレート'));
    });

    // Regression #565 / 565-TESTS-DEPLOY-SKILL-CODEX-WORKFLOWS
    it('should not create a pieces directory for workflow YAMLs', async () => {
      await deploySkillCodex();
      expect(existsSync(join(skillDir, 'workflows', 'default.yaml'))).toBe(true);
      expect(existsSync(join(skillDir, 'pieces'))).toBe(false);
    });
  });

  describe('cleanDir behavior', () => {
    it('should remove stale files from previous deployments', async () => {
      const workflowsDir = join(skillDir, 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, 'stale.yaml'), 'name: stale');

      await deploySkillCodex();

      expect(existsSync(join(workflowsDir, 'stale.yaml'))).toBe(false);
      expect(existsSync(join(workflowsDir, 'default.yaml'))).toBe(true);
    });

    it('should clean agents directory before copy', async () => {
      const agentsDir = join(skillDir, 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'legacy.yaml'), 'legacy');

      await deploySkillCodex();

      expect(existsSync(join(agentsDir, 'legacy.yaml'))).toBe(false);
      expect(existsSync(join(agentsDir, 'openai.yaml'))).toBe(true);
    });

    it('should remove stale templates directory from previous deployments', async () => {
      writeFileSync(join(skillDir, 'SKILL.md'), '# Old Skill');
      const templatesDir = join(skillDir, 'templates');
      mkdirSync(templatesDir, { recursive: true });
      writeFileSync(join(templatesDir, 'task.md'), '# stale template');

      await deploySkillCodex();

      expect(existsSync(templatesDir)).toBe(false);
    });

    it('should remove stale templates directory even without existing SKILL.md', async () => {
      const templatesDir = join(skillDir, 'templates');
      mkdirSync(templatesDir, { recursive: true });
      writeFileSync(join(templatesDir, 'task.md'), '# stale template');

      await deploySkillCodex();

      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(existsSync(templatesDir)).toBe(false);
    });
  });

  describe('when codex skill resources do not exist', () => {
    it('should warn and return early', async () => {
      rmSync(join(fakeResourcesDir, 'skill-codex'), { recursive: true });

      await deploySkillCodex();

      expect(warn).toHaveBeenCalledWith('Skill resources not found. Ensure takt is installed correctly.');
    });
  });

  describe('when skill already exists', () => {
    it('should ask for confirmation before overwriting', async () => {
      writeFileSync(join(skillDir, 'SKILL.md'), '# Old Skill');

      await deploySkillCodex();

      expect(confirm).toHaveBeenCalledWith(
        '既存のスキルファイルをすべて削除し、最新版に置き換えます。続行しますか？',
        false,
      );
    });

    it('should cancel when user declines confirmation', async () => {
      vi.mocked(confirm).mockResolvedValueOnce(false);
      writeFileSync(join(skillDir, 'SKILL.md'), '# Old Skill');

      await deploySkillCodex();

      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe('# Old Skill');
    });
  });

  describe('when language resources directory is empty', () => {
    it('should handle missing resource subdirectories gracefully', async () => {
      const langDir = join(fakeResourcesDir, 'en');
      rmSync(langDir, { recursive: true });
      mkdirSync(langDir, { recursive: true });

      await expect(deploySkillCodex()).resolves.not.toThrow();
    });
  });
});
