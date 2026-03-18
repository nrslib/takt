import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveConfigValues, mockGetProvider } = vi.hoisted(() => ({
  mockResolveConfigValues: vi.fn(),
  mockGetProvider: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
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

import { initializeSession } from '../features/interactive/conversationLoop.js';

describe('initializeSession assistant provider resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProvider.mockReturnValue({ setup: vi.fn() });
  });

  it('should prefer takt_providers.assistant provider/model over top-level provider/model', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'ja',
      provider: 'codex',
      model: 'gpt-5.4',
      taktProviders: {
        assistant: {
          provider: 'claude',
          model: 'haiku',
        },
      },
    });

    const ctx = initializeSession('/project', 'interactive', {
      provider: 'opencode',
      model: 'cli-model',
    });

    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    expect(ctx.providerType).toBe('claude');
    expect(ctx.model).toBe('haiku');
    expect(ctx.lang).toBe('ja');
  });

  it('should fallback to CLI override when takt_providers.assistant is missing', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
      provider: 'codex',
      model: 'gpt-5.4',
    });

    const ctx = initializeSession('/project', 'interactive', {
      provider: 'opencode',
      model: 'cli-model',
    });

    expect(mockGetProvider).toHaveBeenCalledWith('opencode');
    expect(ctx.providerType).toBe('opencode');
    expect(ctx.model).toBe('cli-model');
  });

  it('should fallback to top-level provider/model when assistant and CLI overrides are missing', () => {
    mockResolveConfigValues.mockReturnValue({
      language: 'en',
      provider: 'codex',
      model: 'gpt-5.4',
    });

    const ctx = initializeSession('/project', 'interactive');

    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(ctx.providerType).toBe('codex');
    expect(ctx.model).toBe('gpt-5.4');
  });
});
