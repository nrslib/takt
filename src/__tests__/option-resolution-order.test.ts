import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getProviderMock,
  loadCustomAgentsMock,
  loadAgentPromptMock,
  loadProjectConfigMock,
  loadGlobalConfigMock,
  loadTemplateMock,
  providerSetupMock,
  providerCallMock,
} = vi.hoisted(() => {
  const providerCall = vi.fn();
  const providerSetup = vi.fn(() => ({ call: providerCall }));

  return {
    getProviderMock: vi.fn(() => ({ setup: providerSetup })),
    loadCustomAgentsMock: vi.fn(),
    loadAgentPromptMock: vi.fn(),
    loadProjectConfigMock: vi.fn(),
    loadGlobalConfigMock: vi.fn(),
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
    loadGlobalConfigMock.mockReturnValue({
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    loadCustomAgentsMock.mockReturnValue(new Map());
    loadAgentPromptMock.mockReturnValue('prompt');
    loadTemplateMock.mockReturnValue('template');
  });

  it('should resolve provider in order: CLI > stepProvider > local config > global config', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'opencode' });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'codex',
      stepProvider: 'claude',
    });
    expect(getProviderMock).toHaveBeenLastCalledWith('codex');

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'claude',
    });
    expect(getProviderMock).toHaveBeenLastCalledWith('claude');

    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'claude',
    });
    expect(getProviderMock).toHaveBeenLastCalledWith('claude');

    await runAgent(undefined, 'task', { cwd: '/repo' });
    expect(getProviderMock).toHaveBeenLastCalledWith('mock');
  });

  it('should apply persona provider override before local/global config', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'opencode' });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      personaProviders: {
        coder: { provider: 'claude' },
      },
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent('coder', 'task', {
      cwd: '/repo',
    });

    expect(getProviderMock).toHaveBeenLastCalledWith('claude');
  });

  it('should resolve model in order: CLI > persona > step > local > global', async () => {
    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'local-model',
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'global-model',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
      personaProviders: {
        coder: { model: 'persona-model' },
      },
    });

    await runAgent('coder', 'task', {
      cwd: '/repo',
      model: 'cli-model',
      stepModel: 'step-model',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'cli-model' }),
    );

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepModel: 'step-model',
      stepProvider: 'claude',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'step-model' }),
    );

    await runAgent('coder', 'task', {
      cwd: '/repo',
      stepProvider: 'claude',
    });
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'persona-model' }),
    );

    loadGlobalConfigMock.mockReturnValue({
      provider: 'codex',
      model: 'global-model',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'codex',
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'codex',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'global-model' }),
    );
  });

  it('should ignore local/global model if resolved provider is not matching', async () => {
    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'local-model',
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      model: 'global-model',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      stepProvider: 'opencode',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: undefined }),
    );
  });

  it('should use providerOptions from piece/step only', async () => {
    const stepProviderOptions = {
      claude: {
        sandbox: {
          allowUnsandboxedCommands: false,
        },
      },
    };

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'claude',
      providerOptions: stepProviderOptions,
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ providerOptions: stepProviderOptions }),
    );
  });

  it('should ignore custom agent provider/model overrides', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude', model: 'project-model' });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt' }],
    ]));

    await runAgent('custom', 'task', { cwd: '/repo' });

    expect(getProviderMock).toHaveBeenLastCalledWith('claude');
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'project-model' }),
    );
  });
});
