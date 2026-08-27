import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateConversationSession,
  mockResolveFormalSpecConfigurationWithoutPrompt,
} = vi.hoisted(() => ({
  mockCreateConversationSession: vi.fn(),
  mockResolveFormalSpecConfigurationWithoutPrompt: vi.fn(),
}));

vi.mock('../features/interactive/taskInstructionFormat.js', () => ({
  resolveFormalSpecConfigurationWithoutPrompt: (cwd: string) => mockResolveFormalSpecConfigurationWithoutPrompt(cwd),
}));

vi.mock('../features/interactive/conversationSession.js', () => ({
  createConversationSession: (options: unknown) => mockCreateConversationSession(options),
}));

vi.mock('../features/interactive/sessionInitialization.js', () => ({
  initializeSession: vi.fn(() => ({
    provider: {},
    providerType: 'mock',
    model: undefined,
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
  })),
}));

vi.mock('../features/interactive/assistantInitFiles.js', () => ({
  loadAssistantInitContext: vi.fn(() => 'assistant context'),
}));

import { createDefaultConversationSession } from '../app/acp/conversationFactory.js';

const conversationSession = {
  handleUserMessage: vi.fn(),
  createTaskInstruction: vi.fn(),
};

describe('ACP conversation factory formal specification mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateConversationSession.mockReturnValue(conversationSession);
  });

  it.each([false, true])(
    'resolves formal specification mode=%s without a prompt and passes it to the ACP session',
    (formalSpec) => {
      mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({ mode: formalSpec, comments: true });

      const result = createDefaultConversationSession({ cwd: '/repo', outputMode: 'silent' });

      expect(result).toBe(conversationSession);
      expect(mockResolveFormalSpecConfigurationWithoutPrompt).toHaveBeenCalledOnce();
      expect(mockResolveFormalSpecConfigurationWithoutPrompt).toHaveBeenCalledWith('/repo');
      expect(mockCreateConversationSession).toHaveBeenCalledWith(expect.objectContaining({
        cwd: '/repo',
        outputMode: 'silent',
        formalSpec,
      }));

      const options = mockCreateConversationSession.mock.calls[0]?.[0] as {
        strategy: { systemPrompt: string };
      };
      expect(options.strategy.systemPrompt).toMatch(/Gherkin/);
      if (formalSpec) {
        expect(options.strategy.systemPrompt).toMatch(/\bQuint\b/);
        expect(options.strategy.systemPrompt).toMatch(/\bAlloy\b/);
      } else {
        expect(options.strategy.systemPrompt).not.toMatch(/\bQuint\b/);
        expect(options.strategy.systemPrompt).not.toMatch(/\bAlloy\b/);
      }
    },
  );
});
