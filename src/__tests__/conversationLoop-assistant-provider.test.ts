import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveConfigValues,
  mockResolveNonWorkflowProviderModel,
  mockResolveAssistantConfigLayers,
  mockGetProvider,
} = vi.hoisted(() => ({
  mockResolveConfigValues: vi.fn(),
  mockResolveNonWorkflowProviderModel: vi.fn(),
  mockResolveAssistantConfigLayers: vi.fn(),
  mockGetProvider: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
  resolveNonWorkflowProviderModel: (...args: unknown[]) =>
    mockResolveNonWorkflowProviderModel(...args),
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (...args: unknown[]) => mockResolveAssistantConfigLayers(...args),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
}));

import { initializeSession } from '../features/interactive/sessionInitialization.js';

describe('initializeSession assistant provider resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProvider.mockReturnValue({ setup: vi.fn() });
    mockResolveAssistantConfigLayers.mockReturnValue({ local: {}, global: {} });
    mockResolveNonWorkflowProviderModel.mockReturnValue({
      provider: 'mock',
      model: 'non-workflow-model',
    });
  });

  it('should prioritize CLI provider/model over takt_providers.assistant and top-level provider/model', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'ja',
    });
    mockResolveAssistantConfigLayers.mockReturnValue({
      local: {
        provider: 'codex',
        model: 'gpt-5.4',
        taktProviders: {
          assistant: {
            provider: 'claude',
            model: 'haiku',
          },
        },
      },
      global: {},
    });

    const ctx = initializeSession('/project', 'interactive', {
      provider: 'opencode',
      model: 'cli-model',
    });

    expect(mockGetProvider).toHaveBeenCalledWith('opencode');
    expect(ctx.providerType).toBe('opencode');
    expect(ctx.model).toBe('cli-model');
    expect(ctx.lang).toBe('ja');
    expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
  });

  it('should fallback to takt_providers.assistant when CLI override is missing', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
    });
    mockResolveAssistantConfigLayers.mockReturnValue({
      local: {
        provider: 'codex',
        model: 'gpt-5.4',
        taktProviders: {
          assistant: {
            provider: 'claude',
            model: 'haiku',
          },
        },
      },
      global: {},
    });

    const ctx = initializeSession('/project', 'interactive');

    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    expect(ctx.providerType).toBe('claude');
    expect(ctx.model).toBe('haiku');
    expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
  });

  it('should fallback to top-level provider/model when assistant and CLI overrides are missing', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
    });
    mockResolveAssistantConfigLayers.mockReturnValue({
      local: {
        provider: 'codex',
        model: 'gpt-5.4',
      },
      global: {},
    });

    const ctx = initializeSession('/project', 'interactive');

    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(ctx.providerType).toBe('codex');
    expect(ctx.model).toBe('gpt-5.4');
    expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
  });

  it('should use local config assistant when local config file exists', () => {
    mockResolveConfigValues.mockReturnValue({ language: 'en' });
    mockResolveAssistantConfigLayers.mockReturnValue({
      local: {
        provider: 'opencode',
        model: 'local-top-level-model',
        taktProviders: {
          assistant: {
            provider: 'codex',
            model: 'local-assistant-model',
          },
        },
      },
      global: {
        provider: 'claude',
        model: 'global-top-level-model',
        taktProviders: {
          assistant: {
            provider: 'cursor',
            model: 'global-assistant-model',
          },
        },
      },
    });

    const ctx = initializeSession('/project', 'interactive');

    expect(mockResolveAssistantConfigLayers).toHaveBeenCalledWith('/project');
    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(ctx.providerType).toBe('codex');
    expect(ctx.model).toBe('local-assistant-model');
    expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
  });

  it('should keep CLI model highest even when provider comes from assistant config', () => {
    mockResolveConfigValues.mockReturnValue({ language: 'en' });
    mockResolveAssistantConfigLayers.mockReturnValue({
      local: {
        provider: 'opencode',
        model: 'local-top-level-model',
        taktProviders: {
          assistant: {
            provider: 'codex',
            model: 'local-assistant-model',
          },
        },
      },
      global: {},
    });

    const ctx = initializeSession('/project', 'interactive', {
      model: 'cli-model',
    });

    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(ctx.providerType).toBe('codex');
    expect(ctx.model).toBe('cli-model');
    expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
  });

  it('should not reuse assistant or top-level models from another provider when only CLI provider is set', () => {
    mockResolveConfigValues.mockReturnValue({ language: 'en' });
    mockResolveAssistantConfigLayers.mockReturnValue({
      local: {
        provider: 'claude',
        model: 'local-top-level-model',
        taktProviders: {
          assistant: {
            provider: 'claude',
            model: 'local-assistant-model',
          },
        },
      },
      global: {
        provider: 'opencode',
        model: 'global-top-level-model',
        taktProviders: {
          assistant: {
            provider: 'codex',
            model: 'global-assistant-model',
          },
        },
      },
    });

    const ctx = initializeSession('/project', 'interactive', {
      provider: 'cursor',
    });

    expect(mockGetProvider).toHaveBeenCalledWith('cursor');
    expect(ctx.providerType).toBe('cursor');
    expect(ctx.model).toBeUndefined();
    expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
  });

  it.each(['instruct', 'retry'] as const)(
    'should resolve takt_providers.assistant for %s persona when top-level provider differs',
    (personaName) => {
      mockResolveConfigValues.mockReturnValue({
        language: 'en',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'cursor',
          model: 'composer-2.5',
          taktProviders: {
            assistant: {
              provider: 'claude-sdk',
              model: 'claude-sonnet-5',
            },
          },
        },
        global: {},
      });

      const ctx = initializeSession('/project', personaName);

      expect(mockResolveAssistantConfigLayers).toHaveBeenCalledWith('/project');
      expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
      expect(mockGetProvider).toHaveBeenCalledWith('claude-sdk');
      expect(ctx.providerType).toBe('claude-sdk');
      expect(ctx.model).toBe('claude-sonnet-5');
      expect(ctx.personaName).toBe(personaName);
    },
  );

  it.each(['instruct', 'retry'] as const)(
    'should fallback to top-level provider/model for %s when assistant is unset',
    (personaName) => {
      mockResolveConfigValues.mockReturnValue({
        language: 'en',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'cursor',
          model: 'composer-2.5',
        },
        global: {},
      });

      const ctx = initializeSession('/project', personaName);

      expect(mockResolveAssistantConfigLayers).toHaveBeenCalledWith('/project');
      expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
      expect(mockGetProvider).toHaveBeenCalledWith('cursor');
      expect(ctx.providerType).toBe('cursor');
      expect(ctx.model).toBe('composer-2.5');
    },
  );

  it.each(['instruct', 'retry'] as const)(
    'should resolve takt_providers.assistant for %s when top-level provider is unset',
    (personaName) => {
      mockResolveConfigValues.mockReturnValue({
        language: 'en',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          taktProviders: {
            assistant: {
              provider: 'claude-sdk',
              model: 'claude-sonnet-5',
            },
          },
        },
        global: {},
      });

      const ctx = initializeSession('/project', personaName);

      expect(mockResolveAssistantConfigLayers).toHaveBeenCalledWith('/project');
      expect(mockResolveNonWorkflowProviderModel).not.toHaveBeenCalled();
      expect(mockGetProvider).toHaveBeenCalledWith('claude-sdk');
      expect(ctx.providerType).toBe('claude-sdk');
      expect(ctx.model).toBe('claude-sonnet-5');
      expect(ctx.personaName).toBe(personaName);
    },
  );

  it('should use the non-workflow provider resolver for persona-interactive even when assistant is set', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
    });
    mockResolveNonWorkflowProviderModel.mockReturnValue({
      provider: 'codex',
      model: 'default-non-workflow-model',
    });
    mockResolveAssistantConfigLayers.mockReturnValue({
      local: {
        provider: 'cursor',
        model: 'composer-2.5',
        taktProviders: {
          assistant: {
            provider: 'claude-sdk',
            model: 'claude-sonnet-5',
          },
        },
      },
      global: {},
    });

    const ctx = initializeSession('/project', 'persona-interactive');

    expect(mockResolveNonWorkflowProviderModel).toHaveBeenCalledWith('/project');
    expect(mockResolveAssistantConfigLayers).not.toHaveBeenCalled();
    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(mockGetProvider).not.toHaveBeenCalledWith('auto');
    expect(ctx.providerType).toBe('codex');
    expect(ctx.model).toBe('default-non-workflow-model');
    expect(ctx.personaName).toBe('persona-interactive');
  });

  it('should resolve provider: auto through the non-workflow provider resolver for persona-interactive', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
    });
    mockResolveNonWorkflowProviderModel.mockReturnValue({
      provider: 'claude-sdk',
      model: 'auto-routed-model',
    });

    const ctx = initializeSession('/project', 'persona-interactive');

    expect(mockResolveNonWorkflowProviderModel).toHaveBeenCalledWith('/project');
    expect(mockResolveAssistantConfigLayers).not.toHaveBeenCalled();
    expect(mockGetProvider).toHaveBeenCalledWith('claude-sdk');
    expect(mockGetProvider).not.toHaveBeenCalledWith('auto');
    expect(ctx.providerType).toBe('claude-sdk');
    expect(ctx.model).toBe('auto-routed-model');
  });
});
