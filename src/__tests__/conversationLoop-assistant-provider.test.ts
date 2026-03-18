import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveConfigValues,
  mockResolveAssistantConfigLayers,
  mockGetProvider,
} = vi.hoisted(() => ({
  mockResolveConfigValues: vi.fn(),
  mockResolveAssistantConfigLayers: vi.fn(),
  mockGetProvider: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
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
  });

  it('should prioritize CLI provider/model over takt_providers.assistant and top-level provider/model', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'ja',
      provider: 'codex',
      model: 'gpt-5.4',
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
  });

  it('should fallback to takt_providers.assistant when CLI override is missing', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
      provider: 'codex',
      model: 'gpt-5.4',
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
  });

  it('should fallback to top-level provider/model when assistant and CLI overrides are missing', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
      provider: 'codex',
      model: 'gpt-5.4',
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
  });

  it('should use local config assistant when local config file exists', () => {
    mockResolveConfigValues.mockReturnValue({ language: 'en', provider: 'mock', model: 'global-top-level-model' });
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
  });

  it('should keep CLI model highest even when provider comes from assistant config', () => {
    mockResolveConfigValues.mockReturnValue({ language: 'en', provider: 'mock', model: 'global-top-level-model' });
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
  });

  it('should not reuse assistant or top-level models from another provider when only CLI provider is set', () => {
    mockResolveConfigValues.mockReturnValue({ language: 'en', provider: 'mock', model: 'global-top-level-model' });
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
  });
});
