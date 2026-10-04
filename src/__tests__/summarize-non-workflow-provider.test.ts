import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

const providerMocks = vi.hoisted(() => ({
  call: vi.fn(),
  setup: vi.fn(),
  getProvider: vi.fn(),
  getRuntimeInstructions: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: providerMocks.getProvider,
}));

import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { summarizeTaskName } from '../infra/task/summarize.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';
import type { RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';

describe('summarizeTaskName non-workflow provider integration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-summary-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-summary-global-'));
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'provider: claude',
      'model: global-model',
    ].join('\n'), 'utf-8');
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'provider: mock',
      'model: mock-summary-model',
      'branch_name_strategy: ai',
      'auto_routing:',
      '  strategy: balanced',
      '  router:',
      '    provider: codex',
      '    model: codex/router-model',
      '  candidates:',
      '    - name: coding',
      '      description: Workflow execution',
      '      provider: opencode',
      '      model: opencode/workflow-candidate-model',
      '      routing_tier: medium',
      '  default_pool: general',
      '  candidate_pools:',
      '    general:',
      '      candidates: [coding]',
      '      fallback: coding',
    ].join('\n'), 'utf-8');
    providerMocks.getRuntimeInstructions.mockReturnValue(null);
    providerMocks.call.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'resolved-summary-slug',
      timestamp: new Date(),
    });
    providerMocks.setup.mockReturnValue({ call: providerMocks.call });
    providerMocks.getProvider.mockReturnValue({
      getRuntimeInstructions: providerMocks.getRuntimeInstructions,
      setup: providerMocks.setup,
    });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  function configureRuntimeProvider(runtime: RuntimeProviderFile): void {
    writeFileSync(join(globalConfigDir, 'config.yaml'), 'language: en\n', 'utf-8');
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'branch_name_strategy: ai\n', 'utf-8');
    writeFileSync(
      join(projectDir, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml(runtime),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  }

  it('should pass the top-level model through real config loading to the summarizer', async () => {
    const result = await summarizeTaskName('Create a routed workflow task', { cwd: projectDir });

    expect(result).toBe('resolved-summary-slug');
    expect(providerMocks.getProvider).toHaveBeenCalledWith('mock');
    expect(providerMocks.call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: projectDir,
        model: 'mock-summary-model',
        permissionMode: 'readonly',
      }),
    );
    const callOptions = providerMocks.call.mock.calls[0]?.[1];
    expect(callOptions?.model).not.toBe('codex/router-model');
    expect(callOptions?.model).not.toBe('opencode/workflow-candidate-model');
  });

  it('should generate an AI branch name with runtime defaults.profile', async () => {
    configureRuntimeProvider({
      version: 1,
      provider: {
        defaults: { profile: 'summary' },
        profiles: {
          summary: { provider: 'mock', model: 'runtime-profile-model' },
          router: { provider: 'mock', model: 'router-model' },
          fallback: { provider: 'mock', model: 'pool-fallback-model' },
        },
        auto_routing: {
          router_profile: 'router',
          pools: {
            summary: {
              candidates: [{ profile: 'fallback', tier: 'low' }],
              fallback_profile: 'fallback',
            },
          },
        },
      },
    });

    await expect(summarizeTaskName('Create a runtime branch', { cwd: projectDir }))
      .resolves.toBe('resolved-summary-slug');
    expect(providerMocks.getProvider).toHaveBeenCalledWith('mock');
    expect(providerMocks.call.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      model: 'runtime-profile-model',
    }));
    expect(providerMocks.call.mock.calls[0]?.[1]?.model).not.toBe('pool-fallback-model');
  });

  it('should generate an AI branch name with the first profile in runtime defaults.ladder', async () => {
    configureRuntimeProvider({
      version: 1,
      provider: {
        defaults: { ladder: ['summary', 'strong-summary'] },
        profiles: {
          summary: { provider: 'mock', model: 'runtime-ladder-model' },
          'strong-summary': { provider: 'mock', model: 'runtime-strong-model' },
          router: { provider: 'mock', model: 'router-model' },
          fallback: { provider: 'mock', model: 'pool-fallback-model' },
        },
        auto_routing: {
          router_profile: 'router',
          pools: {
            summary: {
              candidates: [{ profile: 'fallback', tier: 'low' }],
              fallback_profile: 'fallback',
            },
          },
        },
      },
    });

    await expect(summarizeTaskName('Create a ladder branch', { cwd: projectDir }))
      .resolves.toBe('resolved-summary-slug');
    expect(providerMocks.getProvider).toHaveBeenCalledWith('mock');
    expect(providerMocks.call.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      model: 'runtime-ladder-model',
    }));
    expect(providerMocks.call.mock.calls[0]?.[1]?.model).not.toBe('pool-fallback-model');
  });
});
