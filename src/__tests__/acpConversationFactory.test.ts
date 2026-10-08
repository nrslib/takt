import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateConversationSession,
  mockResolveFormalSpecConfigurationWithoutPrompt,
  mockCallAIWithRetry,
} = vi.hoisted(() => ({
  mockCreateConversationSession: vi.fn(),
  mockResolveFormalSpecConfigurationWithoutPrompt: vi.fn(),
  mockCallAIWithRetry: vi.fn(),
}));

vi.mock('../features/interactive/taskInstructionFormat.js', () => ({
  resolveFormalSpecConfigurationWithoutPrompt: (cwd: string) => mockResolveFormalSpecConfigurationWithoutPrompt(cwd),
}));

vi.mock('../features/interactive/conversationSession.js', () => ({
  createConversationSession: (options: unknown) => mockCreateConversationSession(options),
}));

vi.mock('../features/interactive/aiCaller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/aiCaller.js')>()),
  callAIWithRetry: (...args: unknown[]) => mockCallAIWithRetry(...args),
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
      mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({
        mode: formalSpec,
        comments: true,
        modelCheckTimeoutSeconds: 17,
      });

      createDefaultConversationSession({ cwd: '/repo', outputMode: 'silent' });

      expect(mockResolveFormalSpecConfigurationWithoutPrompt).toHaveBeenCalledOnce();
      expect(mockResolveFormalSpecConfigurationWithoutPrompt).toHaveBeenCalledWith('/repo');
      expect(mockCreateConversationSession).toHaveBeenCalledWith(expect.objectContaining({
        cwd: '/repo',
        outputMode: 'silent',
        formalSpec,
        modelCheckTimeoutSeconds: 17,
      }));

      const options = mockCreateConversationSession.mock.calls[0]?.[0] as {
        modelCheckTimeoutSeconds: number;
        strategy: {
          systemPrompt: string;
          modelCheckTimeoutSeconds: number;
          enableAssistantRetryCommands: boolean;
        };
      };
      expect(options.modelCheckTimeoutSeconds).toBe(17);
      expect(options.strategy.modelCheckTimeoutSeconds).toBe(17);
      expect(options.strategy.enableAssistantRetryCommands).toBe(false);
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

  it.each(['/retry', '/requeue'])('treats %s as a regular provider message in ACP', async (text) => {
    const actual = await vi.importActual<typeof import('../features/interactive/conversationSession.js')>(
      '../features/interactive/conversationSession.js',
    );
    mockResolveFormalSpecConfigurationWithoutPrompt.mockReturnValue({
      mode: false,
      comments: true,
      modelCheckTimeoutSeconds: 17,
    });
    mockCreateConversationSession.mockImplementation((options) =>
      actual.createConversationSession(options as Parameters<typeof actual.createConversationSession>[0]),
    );
    mockCallAIWithRetry.mockResolvedValue({
      result: { content: 'regular response', success: true },
      sessionId: undefined,
    });

    const session = createDefaultConversationSession({ cwd: '/repo', outputMode: 'silent' });
    const result = await session.handleUserMessage({
      text,
      abortSignal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: 'assistant_response', content: 'regular response' });
    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
    expect(mockCallAIWithRetry.mock.calls[0]?.[0]).toContain(text);
  });
});
