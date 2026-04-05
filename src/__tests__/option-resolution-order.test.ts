import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getProviderMock,
  loadCustomAgentsMock,
  loadAgentPromptMock,
  loadProjectConfigMock,
  loadGlobalConfigMock,
  resolveConfigValueMock,
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
    resolveConfigValueMock: vi.fn(),
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
  resolveConfigValue: resolveConfigValueMock,
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
    resolveConfigValueMock.mockImplementation((_cwd: string, key: string) => {
      if (key === 'personaProviders') {
        return loadProjectConfigMock.mock.results.at(-1)?.value?.personaProviders;
      }
      return undefined;
    });
    loadCustomAgentsMock.mockReturnValue(new Map());
    loadAgentPromptMock.mockReturnValue('prompt');
    loadTemplateMock.mockReturnValue('template');
  });

  it('should resolve provider in order: CLI > local config > global config', async () => {
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
    });
    expect(getProviderMock).toHaveBeenLastCalledWith('codex');

    await runAgent(undefined, 'task', { cwd: '/repo' });
    expect(getProviderMock).toHaveBeenLastCalledWith('opencode');

    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', { cwd: '/repo' });
    expect(getProviderMock).toHaveBeenLastCalledWith('mock');
  });

  it('should apply persona provider override before local/global config', async () => {
    loadProjectConfigMock.mockReturnValue({
      provider: 'opencode',
      personaProviders: {
        coder: { provider: 'claude' },
      },
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent('coder', 'task', {
      cwd: '/repo',
    });

    expect(getProviderMock).toHaveBeenLastCalledWith('claude');
  });

  it('should resolve model in order: CLI > persona > local > global', async () => {
    loadGlobalConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'global-model',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'local-model',
      personaProviders: {
        coder: { model: 'persona-model' },
      },
    });

    await runAgent('coder', 'task', {
      cwd: '/repo',
      model: 'cli-model',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'cli-model' }),
    );

    await runAgent('coder', 'task', {
      cwd: '/repo',
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
      provider: 'opencode',
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

  it('should use custom agent allowedTools when run options do not provide allowedTools', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt', allowedTools: ['Read', 'Grep'] }],
    ]));

    await runAgent('custom', 'task', { cwd: '/repo' });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ allowedTools: ['Read', 'Grep'] }),
    );
  });

  it('should prioritize run options allowedTools over custom agent allowedTools', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt', allowedTools: ['Read', 'Grep'] }],
    ]));

    await runAgent('custom', 'task', { cwd: '/repo', allowedTools: ['Write'] });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ allowedTools: ['Write'] }),
    );
  });

  it('should resolve permission mode after provider resolution using provider profiles', async () => {
    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      provider: 'codex',
      providerProfiles: {
        codex: { defaultPermissionMode: 'full' },
      },
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      permissionResolution: {
        movementName: 'supervise',
      },
    });

    expect(getProviderMock).toHaveBeenLastCalledWith('codex');
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ permissionMode: 'full' }),
    );
  });

  it('should preserve explicit permission mode when permissionResolution is not set', async () => {
    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      provider: 'codex',
      providerProfiles: {
        codex: { defaultPermissionMode: 'full' },
      },
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ permissionMode: 'readonly' }),
    );
  });
});
