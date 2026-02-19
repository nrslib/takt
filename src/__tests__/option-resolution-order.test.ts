import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getProviderMock,
  loadConfigMock,
  loadCustomAgentsMock,
  loadAgentPromptMock,
  loadTemplateMock,
  providerSetupMock,
  providerCallMock,
} = vi.hoisted(() => {
  const providerCall = vi.fn();
  const providerSetup = vi.fn(() => ({ call: providerCall }));

  return {
    getProviderMock: vi.fn(() => ({ setup: providerSetup })),
    loadConfigMock: vi.fn(),
    loadCustomAgentsMock: vi.fn(),
    loadAgentPromptMock: vi.fn(),
    loadTemplateMock: vi.fn(),
    providerSetupMock: providerSetup,
    providerCallMock: providerCall,
  };
});

vi.mock('../infra/providers/index.js', () => ({
  getProvider: getProviderMock,
}));

vi.mock('../infra/config/index.js', () => ({
  loadConfig: loadConfigMock,
  loadCustomAgents: loadCustomAgentsMock,
  loadAgentPrompt: loadAgentPromptMock,
  resolveConfigValues: (_projectDir: string, keys: readonly string[]) => {
    const loaded = loadConfigMock() as Record<string, unknown>;
    const global = (loaded.global ?? {}) as Record<string, unknown>;
    const project = (loaded.project ?? {}) as Record<string, unknown>;
    const provider = (project.provider ?? global.provider ?? 'claude') as string;
    const config: Record<string, unknown> = { ...global, ...project, provider, piece: project.piece ?? 'default', verbose: false };
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = config[key];
    }
    return result;
  },
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: loadTemplateMock,
}));

import { runAgent } from '../agents/runner.js';

describe('option resolution order', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    providerCallMock.mockResolvedValue({ content: 'ok' });
    loadConfigMock.mockReturnValue({ global: {}, project: {} });
    loadCustomAgentsMock.mockReturnValue(new Map());
    loadAgentPromptMock.mockReturnValue('prompt');
    loadTemplateMock.mockReturnValue('template');
  });

  it('should resolve provider in order: CLI > Config(project??global) > stepProvider > default', async () => {
    // Given
    loadConfigMock.mockReturnValue({
      project: { provider: 'opencode' },
      global: { provider: 'mock' },
    });

    // When: CLI provider が指定される
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'codex',
      stepProvider: 'claude',
    });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('codex');

    // When: CLI 指定なし（project provider が有効: resolveConfigValues は project.provider ?? global.provider を返す）
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'claude',
    });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('opencode');

    // When: project なし → resolveConfigValues は global.provider を返す（フラットマージ）
    loadConfigMock.mockReturnValue({
      project: {},
      global: { provider: 'mock' },
    });
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'claude',
    });

    // Then: resolveConfigValues returns 'mock' (global fallback), so stepProvider is not reached
    expect(getProviderMock).toHaveBeenLastCalledWith('mock');

    // When: stepProvider もなし → 同様に global.provider
    await runAgent(undefined, 'task', { cwd: '/repo' });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('mock');
  });

  it('should resolve model in order: CLI > Piece(step) > Global(matching provider)', async () => {
    // Given
    loadConfigMock.mockReturnValue({
      project: { provider: 'claude' },
      global: { provider: 'claude', model: 'global-model' },
    });

    // When: CLI model あり
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      model: 'cli-model',
      stepModel: 'step-model',
    });

    // Then
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'cli-model' }),
    );

    // When: CLI model なし
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepModel: 'step-model',
    });

    // Then
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'step-model' }),
    );

    // When: stepModel なし
    await runAgent(undefined, 'task', { cwd: '/repo' });

    // Then
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'global-model' }),
    );
  });

  it('should ignore global model when resolved provider does not match config provider', async () => {
    // Given: CLI provider overrides config provider, causing mismatch with config.model
    loadConfigMock.mockReturnValue({
      project: {},
      global: { provider: 'claude', model: 'global-model' },
    });

    // When: CLI provider='codex' overrides config provider='claude'
    // resolveModel compares config.provider ('claude') with resolvedProvider ('codex') → mismatch → model ignored
    await runAgent(undefined, 'task', { cwd: '/repo', provider: 'codex' });

    // Then
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: undefined }),
    );
  });

  it('should use providerOptions from piece(step) only', async () => {
    // Given
    const stepProviderOptions = {
      claude: {
        sandbox: {
          allowUnsandboxedCommands: false,
        },
      },
    };

    loadConfigMock.mockReturnValue({
      project: {
        provider: 'claude',
      },
      global: {
        provider: 'claude',
        providerOptions: {
          claude: { sandbox: { allowUnsandboxedCommands: true } },
        },
      },
    });

    // When
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'claude',
      providerOptions: stepProviderOptions,
    });

    // Then
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ providerOptions: stepProviderOptions }),
    );
  });

  it('should use custom agent model and prompt when higher-priority values are absent', async () => {
    // Given: custom agent with provider/model, but no CLI/config override
    // Note: resolveConfigValues returns provider='claude' by default (loadConfig merges project ?? global ?? 'claude'),
    // so agentConfig.provider is not reached in resolveProvider (config.provider is always truthy).
    // However, custom agent model IS used because resolveModel checks agentConfig.model before config.
    const customAgents = new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt', provider: 'opencode', model: 'agent-model' }],
    ]);
    loadCustomAgentsMock.mockReturnValue(customAgents);

    // When
    await runAgent('custom', 'task', { cwd: '/repo' });

    // Then: provider falls back to config default ('claude'), not agentConfig.provider
    expect(getProviderMock).toHaveBeenLastCalledWith('claude');
    // Agent model is used (resolved before config.model in resolveModel)
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'agent-model' }),
    );
    // Agent prompt is still used
    expect(providerSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ systemPrompt: 'prompt' }),
    );
  });
});
