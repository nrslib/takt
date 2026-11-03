import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import { getProjectTracedSchema } from '../infra/config/traced/tracedConfigSchema.js';
import { loadTraceEntriesViaRuntime } from '../infra/config/traced/tracedConfigRuntimeBridge.js';
import { resolveCacciaSettings } from '../features/caccia/index.js';

const testId = randomUUID();
const rootDir = join(tmpdir(), `takt-it-config-project-priority-${testId}`);
const projectDir = join(rootDir, 'project');

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    loadGlobalConfig: () => ({
      language: 'en',
      provider: 'claude',
      autoFetch: false,
      pipeline: { defaultBranchPrefix: 'global/' },
      personaProviders: { coder: { provider: 'claude', model: 'claude-3-5-sonnet-latest' } },
      branchNameStrategy: 'ai',
      minimalOutput: false,
      concurrency: 2,
      taskPollIntervalMs: 2000,
      interactivePreviewSteps: 4,
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
      caccia: {
        enabled: true,
        waitTimeoutMs: 900_000,
        maxIterations: 6,
        workflow: 'global-caccia',
      },
    }),
    invalidateGlobalConfigCache: () => undefined,
  };
});

const {
  resolveConfigValues,
  resolveConfigValueWithSource,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} = await import('../infra/config/index.js');

describe('IT: project-local config keys should prefer project over global', () => {
  beforeEach(() => {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, '.takt'), { recursive: true });

    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      [
        'pipeline:',
        '  default_branch_prefix: "project/"',
        'persona_providers:',
        '  coder:',
        '    provider: opencode',
        '    model: opencode/big-pickle',
        'branch_name_strategy: ai',
        'minimal_output: true',
        'concurrency: 5',
        'task_poll_interval_ms: 1300',
        'interactive_preview_steps: 1',
        'rate_limit_fallback:',
        '  switch_chain: []',
        'caccia:',
        '  enabled: false',
        '  wait_timeout_ms: 1200',
        '  max_iterations: 2',
        '  workflow: project-caccia',
      ].join('\n'),
      'utf-8',
    );

    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('should resolve keys from project config when global has conflicting values', () => {
    const resolved = resolveConfigValues(projectDir, [
      'pipeline',
      'personaProviders',
      'branchNameStrategy',
      'minimalOutput',
      'concurrency',
      'taskPollIntervalMs',
      'interactivePreviewSteps',
      'rateLimitFallback',
      'caccia',
    ]);

    expect(resolved.pipeline).toEqual({
      defaultBranchPrefix: 'project/',
    });
    expect(resolved.personaProviders).toEqual({
      coder: { provider: 'opencode', model: 'opencode/big-pickle' },
    });
    expect(resolved.branchNameStrategy).toBe('ai');
    expect(resolved.minimalOutput).toBe(true);
    expect(resolved.concurrency).toBe(5);
    expect(resolved.taskPollIntervalMs).toBe(1300);
    expect(resolved.interactivePreviewSteps).toBe(1);
    expect(resolved.rateLimitFallback).toEqual({ switchChain: [] });
    expect(resolved.caccia).toEqual({
      enabled: false,
      waitTimeoutMs: 1200,
      maxIterations: 2,
      workflow: 'project-caccia',
    });
  });

  it('should preserve Caccia settings through project config save and reload', () => {
    const caccia = {
      enabled: true,
      waitTimeoutMs: 2400,
      maxIterations: 4,
      workflow: 'custom-caccia',
    };

    saveProjectConfig(projectDir, { caccia });

    const configText = readFileSync(join(projectDir, '.takt', 'config.yaml'), 'utf-8');
    expect(configText).toContain('wait_timeout_ms: 2400');
    expect(configText).not.toContain('waitTimeoutMs');
    invalidateAllResolvedConfigCache();

    const reloaded = loadProjectConfig(projectDir);
    expect(reloaded.caccia).toEqual(caccia);
  });

  it('should apply Caccia defaults after selecting the project settings block', () => {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'caccia:\n  enabled: false\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const resolved = resolveConfigValues(projectDir, ['caccia']);

    expect(resolved.caccia).toEqual({ enabled: false });
    expect(resolveCacciaSettings(resolved.caccia)).toEqual({
      enabled: false,
      waitTimeoutMs: 1_800_000,
      maxIterations: 3,
      workflow: 'caccia',
    });
  });

  it('should resolve keys from global when project config does not set them', () => {
    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      '',
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const resolved = resolveConfigValues(projectDir, [
      'pipeline',
      'personaProviders',
      'branchNameStrategy',
      'minimalOutput',
      'concurrency',
      'taskPollIntervalMs',
      'interactivePreviewSteps',
      'rateLimitFallback',
      'caccia',
    ]);

    expect(resolved.pipeline).toEqual({ defaultBranchPrefix: 'global/' });
    expect(resolved.personaProviders).toEqual({
      coder: { provider: 'claude', model: 'claude-3-5-sonnet-latest' },
    });
    expect(resolved.branchNameStrategy).toBe('ai');
    expect(resolved.minimalOutput).toBe(false);
    expect(resolved.concurrency).toBe(2);
    expect(resolved.taskPollIntervalMs).toBe(2000);
    expect(resolved.interactivePreviewSteps).toBe(4);
    expect(resolved.rateLimitFallback).toEqual({
      switchChain: [{ provider: 'codex', model: 'gpt-5' }],
    });
    expect(resolved.caccia).toEqual({
      enabled: true,
      waitTimeoutMs: 900_000,
      maxIterations: 6,
      workflow: 'global-caccia',
    });
  });

  it('should mark key source as global when only global defines the key', () => {
    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      '',
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(resolveConfigValueWithSource(projectDir, 'pipeline')).toEqual({
      value: { defaultBranchPrefix: 'global/' },
      source: 'global',
    });
  });

  describe('manager Slack configuration', () => {
    it('loads, saves and reloads repository Slack settings alongside existing manager settings', () => {
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
        'manager:',
        '  auto_run: false',
        '  patrol_interval: 60',
        '  main_merge: approve',
        '  notifications:',
        '    completed: false',
        '  slack:',
        '    channel_id: C0123',
        '    allowed_user_ids: [U0AAA, U0BBB]',
      ].join('\n'), 'utf-8');
      const manager = {
        autoRun: false,
        patrolInterval: 60,
        mainMerge: 'approve',
        notifications: { completed: false },
        slack: { channelId: 'C0123', allowedUserIds: ['U0AAA', 'U0BBB'] },
      };

      const loaded = loadProjectConfig(projectDir);
      expect(loaded).toMatchObject({ manager });
      saveProjectConfig(projectDir, loaded);

      expect(loadProjectConfig(projectDir)).toMatchObject({ manager });
    });

    it.each([{ allowedUserIds: ['U0AAA', 'U0BBB'] }, { allowedUserIds: [] }])('saves and reloads Slack authorization without losing user IDs $allowedUserIds', ({ allowedUserIds }) => {
      const manager = {
        autoRun: false,
        patrolInterval: 60,
        notifications: { completed: false },
        slack: { channelId: 'C0123', allowedUserIds },
      };

      saveProjectConfig(projectDir, { manager });

      const raw: unknown = parseYaml(readFileSync(join(projectDir, '.takt', 'config.yaml'), 'utf-8'));
      expect(raw).toEqual({ manager: {
        auto_run: false,
        patrol_interval: 60,
        notifications: { completed: false },
        slack: { channel_id: 'C0123', allowed_user_ids: allowedUserIds },
      } });
      expect(loadProjectConfig(projectDir)).toMatchObject({ manager });
    });

    it('tracks Slack configuration and individual fields with repository provenance', () => {
      const slack = { channel_id: 'C0123', allowed_user_ids: ['U0AAA'] };

      const entries = loadTraceEntriesViaRuntime(getProjectTracedSchema(), 'local', { manager: { slack } });

      for (const [key, value] of [
        ['manager.slack', slack],
        ['manager.slack.channel_id', slack.channel_id],
        ['manager.slack.allowed_user_ids', slack.allowed_user_ids],
      ] as const) {
        expect(entries.get(key)).toMatchObject({ value, origin: 'local' });
      }
    });
  });
});
