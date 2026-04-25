/**
 * Tests for config resolution defaults and project-local priority.
 *
 * Verifies that keys with PROJECT_LOCAL_DEFAULTS resolve correctly
 * and that project config takes priority over global config.
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
type ConfigParameterKey = import('../infra/config/resolveConfigValue.js').ConfigParameterKey;

describe('config resolution defaults and project-local priority', () => {
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

  describe('project-local priority', () => {
    it.each([
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
        key: 'interactivePreviewSteps',
        projectYaml: 'interactive_preview_steps: 1\n',
        expected: 1,
      },
      {
        key: 'concurrency',
        projectYaml: 'concurrency: 3\n',
        expected: 3,
      },
      {
        key: 'syncProjectLocalTaktOnRetry',
        projectYaml: 'sync_project_local_takt_on_retry: false\n',
        expected: false,
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

    it('should resolve non-default keys as undefined when project keys are unset', () => {
      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), 'provider: claude\n', 'utf-8');
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      const pipelineResult = resolveConfigValueWithSource(projectDir, 'pipeline' as ConfigParameterKey);
      const personaResult = resolveConfigValueWithSource(projectDir, 'personaProviders' as ConfigParameterKey);
      const branchStrategyResult = resolveConfigValueWithSource(projectDir, 'branchNameStrategy' as ConfigParameterKey);

      expect(pipelineResult).toEqual({ value: undefined, source: 'default' });
      expect(personaResult).toEqual({ value: undefined, source: 'default' });
      expect(branchStrategyResult).toEqual({ value: undefined, source: 'default' });
    });

    it('should resolve default-backed keys from defaults when unset', () => {
      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), 'provider: claude\n', 'utf-8');
      writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
      invalidateGlobalConfigCache();

      expect(resolveConfigValueWithSource(projectDir, 'minimalOutput')).toEqual({ value: false, source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'concurrency')).toEqual({ value: 1, source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'taskPollIntervalMs')).toEqual({ value: 500, source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'interactivePreviewSteps')).toEqual({ value: 3, source: 'default' });
      expect(resolveConfigValueWithSource(projectDir, 'syncProjectLocalTaktOnRetry' as ConfigParameterKey)).toEqual({
        value: true,
        source: 'default',
      });
    });

    it('should resolve keys from global config when project keys are unset', () => {
      writeFileSync(
        globalConfigPath,
        [
          'language: en',
          'pipeline:',
          '  default_branch_prefix: "global/"',
          'persona_providers:',
          '  coder:',
          '    provider: codex',
          '    model: gpt-5',
          'branch_name_strategy: ai',
          'minimal_output: true',
          'concurrency: 3',
          'task_poll_interval_ms: 1200',
          'interactive_preview_steps: 2',
          'sync_project_local_takt_on_retry: false',
        ].join('\n'),
        'utf-8',
      );
      invalidateGlobalConfigCache();

      expect(resolveConfigValueWithSource(projectDir, 'pipeline')).toEqual({
        value: { defaultBranchPrefix: 'global/' },
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
      expect(resolveConfigValueWithSource(projectDir, 'concurrency')).toEqual({ value: 3, source: 'global' });
      expect(resolveConfigValueWithSource(projectDir, 'taskPollIntervalMs')).toEqual({ value: 1200, source: 'global' });
      expect(resolveConfigValueWithSource(projectDir, 'interactivePreviewSteps')).toEqual({
        value: 2,
        source: 'global',
      });
      expect(resolveConfigValueWithSource(projectDir, 'syncProjectLocalTaktOnRetry' as ConfigParameterKey)).toEqual({
        value: false,
        source: 'global',
      });
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
