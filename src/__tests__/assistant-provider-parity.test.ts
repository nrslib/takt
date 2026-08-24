/**
 * The TUI and the readline conversation must resolve the same assistant.
 *
 * Both build their session through `createAssistantConversationPlan`, which is
 * the only place the assistant ladder is read. This pins that: the ladder is
 * consulted once, with the same inputs, whichever front-end asks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveAssistant, mockResolveNonWorkflow } = vi.hoisted(() => ({
  mockResolveAssistant: vi.fn(),
  mockResolveNonWorkflow: vi.fn(),
}));

vi.mock('../features/interactive/assistantConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/assistantConfig.js')>()),
  resolveAssistantProviderModel: (...args: unknown[]) => mockResolveAssistant(...args),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  resolveNonWorkflowProviderModel: (...args: unknown[]) => mockResolveNonWorkflow(...args),
  resolveNonWorkflowProviderOptions: vi.fn(() => undefined),
  resolveConfigValues: vi.fn(() => ({ language: 'en' })),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ setup: vi.fn(), getRuntimeInstructions: vi.fn(() => null) })),
}));

import {
  createAssistantConversationPlan,
  createPersonaConversationPlan,
} from '../features/interactive/conversationPlan.js';

// The resolver doubles are asserted on by call count, so every test starts from
// a clean slate rather than from whatever ran before it.
beforeEach(() => {
  vi.clearAllMocks();
});

describe('assistant provider resolution', () => {
  it('should read the assistant ladder for every assistant conversation', () => {
    mockResolveAssistant.mockReturnValue({
      runtimeManaged: true,
      provider: 'codex',
      model: 'gpt-5.6-luna',
    });

    for (const assistantMode of ['assistant', 'grill-me'] as const) {
      // Each mode is its own case; the counts below are per iteration.
      mockResolveAssistant.mockClear();
      const plan = createAssistantConversationPlan('/repo', { assistantMode });

      expect(plan.ctx.providerType).toBe('codex');
      expect(plan.ctx.model).toBe('gpt-5.6-luna');
      // The ladder is asked, not the plain non-workflow default.
      expect(mockResolveAssistant).toHaveBeenCalledTimes(1);
      expect(mockResolveNonWorkflow).not.toHaveBeenCalled();
    }
  });

  it('should pass a CLI override into the ladder rather than applying it later', () => {
    mockResolveAssistant.mockReturnValue({ runtimeManaged: false, provider: 'claude-sdk', model: 'opus' });

    createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      provider: 'claude-sdk',
      model: 'opus',
    });

    expect(mockResolveAssistant).toHaveBeenCalledWith('/repo', { provider: 'claude-sdk', model: 'opus' });
  });

  it('should ask the ladder for the plain configuration when no override was given', () => {
    mockResolveAssistant.mockReturnValue({ runtimeManaged: false, provider: 'codex' });

    createAssistantConversationPlan('/repo', { assistantMode: 'assistant' });

    // No overrides to fold in, so the ladder resolves the configuration as it stands.
    expect(mockResolveAssistant).toHaveBeenCalledWith('/repo', undefined);
  });

  it('should resolve a persona conversation as a non-workflow agent', () => {
    mockResolveNonWorkflow.mockReturnValue({ runtimeManaged: true, provider: 'codex', model: 'gpt-5.6-luna' });

    const plan = createPersonaConversationPlan('/repo', {
      personaContent: 'persona',
      personaDisplayName: 'reviewer',
      allowedTools: [],
    });

    expect(plan.ctx.providerType).toBe('codex');
    expect(mockResolveNonWorkflow).toHaveBeenCalledWith('/repo');
    expect(mockResolveAssistant).not.toHaveBeenCalled();
  });

  it('should apply interactive provider and model overrides to a persona conversation', () => {
    mockResolveAssistant.mockReturnValue({
      runtimeManaged: false,
      provider: 'claude',
      model: 'custom-model',
    });

    const plan = createPersonaConversationPlan('/repo', {
      personaContent: 'persona',
      personaDisplayName: 'reviewer',
      allowedTools: [],
    }, {
      provider: 'claude',
      model: 'custom-model',
    });

    expect(plan.ctx.providerType).toBe('claude');
    expect(plan.ctx.model).toBe('custom-model');
    expect(mockResolveAssistant).toHaveBeenCalledWith('/repo', {
      provider: 'claude',
      model: 'custom-model',
    });
    expect(mockResolveNonWorkflow).not.toHaveBeenCalled();
  });
});
