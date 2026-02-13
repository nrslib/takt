import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getProviderMock,
  loadProjectConfigMock,
  loadGlobalConfigMock,
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
    loadProjectConfigMock: vi.fn(),
    loadGlobalConfigMock: vi.fn(),
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
  loadProjectConfig: loadProjectConfigMock,
  loadGlobalConfig: loadGlobalConfigMock,
  loadCustomAgents: loadCustomAgentsMock,
  loadAgentPrompt: loadAgentPromptMock,
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: loadTemplateMock,
}));

import { runAgent } from '../agents/runner.js';

describe('option resolution order', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    providerCallMock.mockResolvedValue({ content: 'ok' });
    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({});
    loadCustomAgentsMock.mockReturnValue(new Map());
    loadAgentPromptMock.mockReturnValue('prompt');
    loadTemplateMock.mockReturnValue('template');
  });

  it('should resolve provider in order: CLI > Local > Piece(step) > Global', async () => {
    // Given
    loadProjectConfigMock.mockReturnValue({ provider: 'opencode' });
    loadGlobalConfigMock.mockReturnValue({ provider: 'mock' });

    // When: CLI provider が指定される
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'codex',
      stepProvider: 'claude',
    });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('codex');

    // When: CLI 指定なし（Local が有効）
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'claude',
    });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('opencode');

    // When: Local なし（Piece が有効）
    loadProjectConfigMock.mockReturnValue({});
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'claude',
    });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('claude');

    // When: Piece なし（Global が有効）
    await runAgent(undefined, 'task', { cwd: '/repo' });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('mock');
  });

  it('should resolve model in order: CLI > Piece(step) > Global(matching provider)', async () => {
    // Given
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });
    loadGlobalConfigMock.mockReturnValue({ provider: 'claude', model: 'global-model' });

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

  it('should ignore global model when global provider does not match resolved provider', async () => {
    // Given
    loadProjectConfigMock.mockReturnValue({ provider: 'codex' });
    loadGlobalConfigMock.mockReturnValue({ provider: 'claude', model: 'global-model' });

    // When
    await runAgent(undefined, 'task', { cwd: '/repo' });

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

    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      provider_options: {
        claude: { sandbox: { allow_unsandboxed_commands: true } },
      },
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'claude',
      providerOptions: {
        claude: { sandbox: { allowUnsandboxedCommands: true } },
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

  it('should use custom agent provider/model when higher-priority values are absent', async () => {
    // Given
    const customAgents = new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt', provider: 'opencode', model: 'agent-model' }],
    ]);
    loadCustomAgentsMock.mockReturnValue(customAgents);

    // When
    await runAgent('custom', 'task', { cwd: '/repo' });

    // Then
    expect(getProviderMock).toHaveBeenLastCalledWith('opencode');
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'agent-model' }),
    );
    expect(providerSetupMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ systemPrompt: 'prompt' }),
    );
  });
});
