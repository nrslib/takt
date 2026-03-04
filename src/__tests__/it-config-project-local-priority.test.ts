import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const testId = randomUUID();
const rootDir = join(tmpdir(), `takt-it-config-project-priority-${testId}`);
const projectDir = join(rootDir, 'project');

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  const globalMigratedValues = {
    logLevel: 'info',
    pipeline: { defaultBranchPrefix: 'global/' },
    personaProviders: { coder: { provider: 'claude', model: 'claude-3-5-sonnet-latest' } },
    branchNameStrategy: 'ai',
    minimalOutput: false,
    concurrency: 2,
    taskPollIntervalMs: 2000,
    interactivePreviewMovements: 4,
    verbose: false,
  } as const;
  return {
    ...original,
    loadGlobalConfig: () => ({
      language: 'en',
      provider: 'claude',
      autoFetch: false,
    }),
    loadGlobalMigratedProjectLocalFallback: () => globalMigratedValues,
    invalidateGlobalConfigCache: () => undefined,
  };
});

const {
  resolveConfigValues,
  resolveConfigValueWithSource,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} = await import('../infra/config/index.js');

describe('IT: migrated config keys should prefer project over global', () => {
  beforeEach(() => {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, '.takt'), { recursive: true });

    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      [
        'log_level: debug',
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
        'interactive_preview_movements: 1',
        'verbose: true',
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

  it('should resolve migrated keys from project config when global has conflicting values', () => {
    const resolved = resolveConfigValues(projectDir, [
      'logLevel',
      'pipeline',
      'personaProviders',
      'branchNameStrategy',
      'minimalOutput',
      'concurrency',
      'taskPollIntervalMs',
      'interactivePreviewMovements',
      'verbose',
    ]);

    expect(resolved.logLevel).toBe('debug');
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
    expect(resolved.interactivePreviewMovements).toBe(1);
    expect(resolved.verbose).toBe(true);
  });

  it('should resolve migrated keys from global when project config does not set them', () => {
    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      '',
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const resolved = resolveConfigValues(projectDir, [
      'logLevel',
      'pipeline',
      'personaProviders',
      'branchNameStrategy',
      'minimalOutput',
      'concurrency',
      'taskPollIntervalMs',
      'interactivePreviewMovements',
      'verbose',
    ]);

    expect(resolved.logLevel).toBe('info');
    expect(resolved.pipeline).toEqual({ defaultBranchPrefix: 'global/' });
    expect(resolved.personaProviders).toEqual({
      coder: { provider: 'claude', model: 'claude-3-5-sonnet-latest' },
    });
    expect(resolved.branchNameStrategy).toBe('ai');
    expect(resolved.minimalOutput).toBe(false);
    expect(resolved.concurrency).toBe(2);
    expect(resolved.taskPollIntervalMs).toBe(2000);
    expect(resolved.interactivePreviewMovements).toBe(4);
    expect(resolved.verbose).toBe(false);
  });

  it('should mark migrated key source as global when only global defines the key', () => {
    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      '',
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(resolveConfigValueWithSource(projectDir, 'logLevel')).toEqual({
      value: 'info',
      source: 'global',
    });
  });
});
