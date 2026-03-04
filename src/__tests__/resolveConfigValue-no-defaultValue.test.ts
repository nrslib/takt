/**
 * Tests for RESOLUTION_REGISTRY defaultValue removal.
 *
 * Verifies that piece, verbose, and autoFetch no longer rely on
 * RESOLUTION_REGISTRY defaultValue but instead use schema defaults
 * or other guaranteed sources.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testId = randomUUID();
const testDir = join(tmpdir(), `takt-rcv-test-${testId}`);
const globalTaktDir = join(testDir, 'global-takt');
const globalConfigPath = join(globalTaktDir, 'config.yaml');

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

const {
  resolveConfigValue,
  resolveConfigValueWithSource,
  invalidateAllResolvedConfigCache,
} = await import('../infra/config/resolveConfigValue.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');
const { MIGRATED_PROJECT_LOCAL_CONFIG_KEYS } = await import('../infra/config/migratedProjectLocalKeys.js');
const { MIGRATED_PROJECT_LOCAL_DEFAULTS } = await import('../infra/config/migratedProjectLocalDefaults.js');
type ConfigParameterKey = import('../infra/config/resolveConfigValue.js').ConfigParameterKey;

describe('RESOLUTION_REGISTRY defaultValue removal', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(testDir, `project-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('verbose', () => {
    it('should resolve verbose to false via resolver default when not set anywhere', () => {
      const value = resolveConfigValue(projectDir, 'verbose');
      expect(value).toBe(false);
    });

    it('should report source as default when verbose comes from resolver default', () => {
      const result = resolveConfigValueWithSource(projectDir, 'verbose');
      expect(result.value).toBe(false);
      expect(result.source).toBe('default');
    });

    it('should resolve verbose default when project does not set it', () => {
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      expect(resolveConfigValueWithSource(projectDir, 'verbose')).toEqual({
        value: false,
        source: 'default',
      });
    });

    it('should resolve verbose from project config when project sets it', () => {
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'verbose: true\n');

      const value = resolveConfigValue(projectDir, 'verbose');
      expect(value).toBe(true);
    });
  });

  describe('project-local priority for migrated keys', () => {
    it.each([
      {
        key: 'logLevel',
        projectYaml: 'log_level: debug\n',
        expected: 'debug',
      },
      {
        key: 'minimalOutput',
        projectYaml: 'minimal_output: true\n',
        expected: true,
      },
      {
        key: 'branchNameStrategy',
        projectYaml: 'branch_name_strategy: ai\n',
        expected: 'ai',
      },
      {
        key: 'taskPollIntervalMs',
        projectYaml: 'task_poll_interval_ms: 1200\n',
        expected: 1200,
      },
      {
        key: 'interactivePreviewMovements',
        projectYaml: 'interactive_preview_movements: 1\n',
        expected: 1,
      },
      {
        key: 'concurrency',
        projectYaml: 'concurrency: 3\n',
        expected: 3,
      },
      {
        key: 'verbose',
        projectYaml: 'verbose: true\n',
        expected: true,
      },
    ])('should resolve $key from project config', ({ key, projectYaml, expected }) => {
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), projectYaml, 'utf-8');

      const result = resolveConfigValueWithSource(projectDir, key as ConfigParameterKey);
      expect(result.value).toBe(expected);
      expect(result.source).toBe('project');
    });

    it('should resolve personaProviders from project config', () => {
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.yaml'),
        [
          'persona_providers:',
          '  coder:',
          '    provider: opencode',
          '    model: project-model',
        ].join('\n'),
        'utf-8',
      );

      const result = resolveConfigValueWithSource(projectDir, 'personaProviders' as ConfigParameterKey);
      expect(result.source).toBe('project');
      expect(result.value).toEqual({
        coder: {
          provider: 'opencode',
          model: 'project-model',
        },
      });
    });

    it('should resolve pipeline from project config', () => {
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.yaml'),
        [
          'pipeline:',
          '  default_branch_prefix: "project/"',
          '  commit_message_template: "feat: {title} (#{issue})"',
        ].join('\n'),
        'utf-8',
      );

      const result = resolveConfigValueWithSource(projectDir, 'pipeline' as ConfigParameterKey);
      expect(result.source).toBe('project');
      expect(result.value).toEqual({
        defaultBranchPrefix: 'project/',
        commitMessageTemplate: 'feat: {title} (#{issue})',
      });
    });

    it('should resolve migrated non-default keys as undefined when project keys are unset', () => {
      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), 'provider: claude\n', 'utf-8');
      writeFileSync(
        globalConfigPath,
        ['language: en'].join('\n'),
        'utf-8',
      );
      invalidateGlobalConfigCache();

      const pipelineResult = resolveConfigValueWithSource(projectDir, 'pipeline' as ConfigParameterKey);
      const personaResult = resolveConfigValueWithSource(projectDir, 'personaProviders' as ConfigParameterKey);
      const branchStrategyResult = resolveConfigValueWithSource(projectDir, 'branchNameStrategy' as ConfigParameterKey);

      expect(pipelineResult).toEqual({
        value: undefined,
        source: 'default',
      });
      expect(personaResult).toEqual({
        value: undefined,
        source: 'default',
      });
      expect(branchStrategyResult).toEqual({
        value: undefined,
        source: 'default',
      });
    });

    it('should resolve default-backed migrated keys from defaults when project keys are unset', () => {
      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), 'provider: claude\n', 'utf-8');
      writeFileSync(
        globalConfigPath,
        ['language: en'].join('\n'),
        'utf-8',
      );
      invalidateGlobalConfigCache();

      expect(resolveConfigValueWithSource(projectDir, 'logLevel')).toEqual({ value: 'info', source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'minimalOutput')).toEqual({ value: false, source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'concurrency')).toEqual({ value: 1, source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'taskPollIntervalMs')).toEqual({ value: 500, source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'interactivePreviewMovements')).toEqual({ value: 3, source: 'default' });
    });

    it('should resolve migrated keys from global legacy fields when project keys are unset', () => {
      writeFileSync(
        globalConfigPath,
        [
          'language: en',
          'log_level: warn',
          'pipeline:',
          '  default_branch_prefix: "legacy/"',
          'persona_providers:',
          '  coder:',
          '    provider: codex',
          '    model: gpt-5',
          'branch_name_strategy: ai',
          'minimal_output: true',
          'verbose: true',
          'concurrency: 3',
          'task_poll_interval_ms: 1200',
          'interactive_preview_movements: 2',
        ].join('\n'),
        'utf-8',
      );
      invalidateGlobalConfigCache();

      expect(resolveConfigValueWithSource(projectDir, 'logLevel')).toEqual({ value: 'warn', source: 'global' });
      expect(resolveConfigValueWithSource(projectDir, 'pipeline')).toEqual({
        value: { defaultBranchPrefix: 'legacy/' },
        source: 'global',
      });
      expect(resolveConfigValueWithSource(projectDir, 'personaProviders')).toEqual({
        value: { coder: { provider: 'codex', model: 'gpt-5' } },
        source: 'global',
      });
      expect(resolveConfigValueWithSource(projectDir, 'branchNameStrategy')).toEqual({
        value: 'ai',
        source: 'global',
      });
      expect(resolveConfigValueWithSource(projectDir, 'minimalOutput')).toEqual({ value: true, source: 'global' });
      expect(resolveConfigValueWithSource(projectDir, 'verbose')).toEqual({ value: true, source: 'global' });
      expect(resolveConfigValueWithSource(projectDir, 'concurrency')).toEqual({ value: 3, source: 'global' });
      expect(resolveConfigValueWithSource(projectDir, 'taskPollIntervalMs')).toEqual({ value: 1200, source: 'global' });
      expect(resolveConfigValueWithSource(projectDir, 'interactivePreviewMovements')).toEqual({
        value: 2,
        source: 'global',
      });
    });

    it('should resolve migrated numeric key from default when project key is unset', () => {
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      expect(resolveConfigValueWithSource(projectDir, 'concurrency' as ConfigParameterKey)).toEqual({
        value: 1,
        source: 'default',
      });
    });

    it('should resolve migrated persona_providers key from default when project key is unset', () => {
      writeFileSync(
        globalConfigPath,
        ['language: en'].join('\n'),
        'utf-8',
      );
      invalidateGlobalConfigCache();

      expect(resolveConfigValueWithSource(projectDir, 'personaProviders' as ConfigParameterKey)).toEqual({
        value: undefined,
        source: 'default',
      });
    });

    it('should resolve all migrated keys from project or defaults when project config has no migrated keys', () => {
      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), 'provider: claude\n', 'utf-8');
      writeFileSync(
        globalConfigPath,
        ['language: en'].join('\n'),
        'utf-8',
      );
      invalidateGlobalConfigCache();

      const expectedByKey: Partial<Record<ConfigParameterKey, unknown>> = {
        logLevel: MIGRATED_PROJECT_LOCAL_DEFAULTS.logLevel,
        pipeline: undefined,
        personaProviders: undefined,
        branchNameStrategy: undefined,
        minimalOutput: MIGRATED_PROJECT_LOCAL_DEFAULTS.minimalOutput,
        concurrency: MIGRATED_PROJECT_LOCAL_DEFAULTS.concurrency,
        taskPollIntervalMs: MIGRATED_PROJECT_LOCAL_DEFAULTS.taskPollIntervalMs,
        interactivePreviewMovements: MIGRATED_PROJECT_LOCAL_DEFAULTS.interactivePreviewMovements,
        verbose: MIGRATED_PROJECT_LOCAL_DEFAULTS.verbose,
      };

      for (const key of MIGRATED_PROJECT_LOCAL_CONFIG_KEYS) {
        const resolved = resolveConfigValueWithSource(projectDir, key);
        expect(resolved.source).toBe('default');
        expect(resolved.value).toEqual(expectedByKey[key as ConfigParameterKey]);
      }
    });
  });

  describe('autoFetch', () => {
    it('should resolve autoFetch to false via schema default when not set', () => {
      const value = resolveConfigValue(projectDir, 'autoFetch');
      expect(value).toBe(false);
    });

    it('should report source as global when autoFetch comes from schema default', () => {
      const result = resolveConfigValueWithSource(projectDir, 'autoFetch');
      expect(result.value).toBe(false);
      expect(result.source).toBe('global');
    });

    it('should resolve autoFetch from global config when explicitly set', () => {
      writeFileSync(globalConfigPath, 'language: en\nauto_fetch: true\n', 'utf-8');
      invalidateGlobalConfigCache();

      const value = resolveConfigValue(projectDir, 'autoFetch');
      expect(value).toBe(true);
    });
  });
});
