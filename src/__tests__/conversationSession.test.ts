import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallAIWithRetry,
  mockBuildSummaryPrompt,
} = vi.hoisted(() => ({
  mockCallAIWithRetry: vi.fn(),
  mockBuildSummaryPrompt: vi.fn(),
}));

vi.mock('../features/interactive/aiCaller.js', () => ({
  callAIWithRetry: (...args: unknown[]) => mockCallAIWithRetry(...args),
}));

vi.mock('../features/interactive/interactiveApplication.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildConversationSummaryPrompt: (...args: unknown[]) => mockBuildSummaryPrompt(...args),
}));

import { createConversationSession } from '../features/interactive/conversationSession.js';

function createSession() {
  return createConversationSession({
    cwd: '/repo',
    ctx: {
      provider: {
        setup: vi.fn(),
        getRuntimeInstructions: vi.fn(() => null),
      },
      providerType: 'mock',
      model: 'mock-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    },
    strategy: {
      systemPrompt: 'system prompt',
      allowedTools: ['Read'],
      transformPrompt: (message: string) => `transformed: ${message}`,
      summaryPromptContext: 'summary context',
    },
  });
}

describe('conversation session application API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallAIWithRetry.mockResolvedValue({
      result: {
        content: 'Assistant answer',
        sessionId: 'provider-session-1',
        success: true,
      },
      sessionId: 'provider-session-1',
    });
    mockBuildSummaryPrompt.mockReturnValue('summary prompt');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should accept user text from the adapter without reading stdin', async () => {
    const pauseSpy = vi.spyOn(process.stdin, 'pause');
    const session = createSession();

    const result = await session.handleUserMessage({ text: 'hello' });

    expect(result).toEqual({
      kind: 'assistant_response',
      content: 'Assistant answer',
      sessionId: 'provider-session-1',
    });
    expect(mockCallAIWithRetry).toHaveBeenCalledWith(
      'transformed: hello',
      'system prompt',
      ['Read'],
      '/repo',
      expect.objectContaining({
        sessionId: undefined,
        providerType: 'mock',
        model: 'mock-model',
      }),
      expect.any(Object),
    );
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('should pass the adapter abort signal to regular AI calls', async () => {
    const session = createSession();
    const abortController = new AbortController();

    await session.handleUserMessage({
      text: 'hello',
      abortSignal: abortController.signal,
    });

    expect(mockCallAIWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      '/repo',
      expect.any(Object),
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });

  it('should convert /play into a workflow execution request without calling AI', async () => {
    const session = createSession();

    const result = await session.handleUserMessage({ text: '/play implement ACP support' });

    expect(result).toEqual({
      kind: 'workflow_execution_requested',
      task: 'implement ACP support',
      interactiveMetadata: {
        confirmed: true,
        task: 'implement ACP support',
      },
    });
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('should summarize conversation on /go and return a structured execution request', async () => {
    const session = createSession();
    await session.handleUserMessage({ text: 'implement ACP support' });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'Implement ACP support with a stdio adapter.',
        sessionId: 'provider-session-2',
        success: true,
      },
      sessionId: 'provider-session-2',
    });

    const result = await session.handleUserMessage({ text: '/go include progress updates' });

    expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
      [{ role: 'user', content: 'implement ACP support' }, { role: 'assistant', content: 'Assistant answer' }],
      'include progress updates',
      'en',
      'summary context',
    );
    expect(result).toEqual({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support with a stdio adapter.',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support with a stdio adapter.',
      },
      sessionId: 'provider-session-2',
    });
  });

  it('should pass the adapter abort signal to summary AI calls', async () => {
    const session = createSession();
    await session.handleUserMessage({ text: 'implement ACP support' });
    mockCallAIWithRetry.mockClear();
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'Implement ACP support with a stdio adapter.',
        success: true,
      },
      sessionId: undefined,
    });
    const abortController = new AbortController();

    await session.handleUserMessage({
      text: '/go include progress updates',
      abortSignal: abortController.signal,
    });

    expect(mockCallAIWithRetry).toHaveBeenCalledWith(
      'summary prompt',
      'summary prompt',
      ['Read'],
      '/repo',
      expect.any(Object),
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });

  it('should return a structured error when the provider call fails', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'provider failed',
        success: false,
      },
      sessionId: undefined,
    });
    const session = createSession();

    const result = await session.handleUserMessage({ text: 'hello' });

    expect(result).toEqual({
      kind: 'error',
      message: 'provider failed',
    });
  });

  it('should restore conversation history when a provider call fails', async () => {
    mockCallAIWithRetry
      .mockResolvedValueOnce({
        result: {
          content: 'provider failed',
          success: false,
        },
        sessionId: undefined,
      })
      .mockResolvedValueOnce({
        result: {
          content: 'Assistant answer',
          success: true,
        },
        sessionId: 'provider-session-1',
      });
    const session = createSession();

    await session.handleUserMessage({ text: 'failed request' });
    await session.handleUserMessage({ text: 'successful request' });
    await session.handleUserMessage({ text: '/go summarize' });

    expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
      [{ role: 'user', content: 'successful request' }, { role: 'assistant', content: 'Assistant answer' }],
      'summarize',
      'en',
      'summary context',
    );
  });
});
