import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
}));

vi.mock('../features/interactive/interactiveApplication.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildConversationSummaryPrompt: (...args: unknown[]) => mockBuildSummaryPrompt(...args),
}));

import { createConversationSession } from '../features/interactive/conversationSession.js';

function createSession(cwd = '/repo') {
  return createConversationSession({
    cwd,
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
      true,
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

  it.each([
    ['unset', undefined, true],
    ['enabled', true, true],
    ['disabled', false, false],
  ] as const)('should pass %s project Gherkin mode to ACP task instruction generation', async (_label, configured, expected) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-gherkin-acp-'));
    if (configured !== undefined) {
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(
        join(projectDir, '.takt', 'config.yaml'),
        ['assistant:', `  gherkin: ${configured}`].join('\n'),
        'utf-8',
      );
    }
    const session = createSession(projectDir);

    try {
      await session.createTaskInstruction({ userNote: 'implement ACP support' });

      expect(mockBuildSummaryPrompt.mock.calls[0]?.[4]).toBe(expected);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['unset', undefined, true],
    ['project false', false, false],
  ] as const)('should apply %s to the actual ACP summary prompt', async (_label, configured, expectedEnabled) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-gherkin-acp-prompt-'));
    if (configured !== undefined) {
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(
        join(projectDir, '.takt', 'config.yaml'),
        ['assistant:', `  gherkin: ${configured}`].join('\n'),
        'utf-8',
      );
    }
    const actualInteractiveApplication = await vi.importActual<typeof import('../features/interactive/interactiveApplication.js')>(
      '../features/interactive/interactiveApplication.js',
    );
    mockBuildSummaryPrompt.mockImplementation(actualInteractiveApplication.buildConversationSummaryPrompt);

    try {
      const session = createSession(projectDir);
      await session.createTaskInstruction({ userNote: 'implement ACP support' });

      const prompt = mockCallAIWithRetry.mock.calls[0]?.[0];
      if (expectedEnabled) {
        expect(prompt).toContain('## Markdown + Gherkin Output Format');
      } else {
        expect(prompt).not.toContain('## Markdown + Gherkin Output Format');
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should create a task instruction through the semantic API without a slash command', async () => {
    const session = createSession();
    await session.handleUserMessage({ text: 'implement ACP support' });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'Implement ACP support with enqueue-first ACP.',
        sessionId: 'provider-session-2',
        success: true,
      },
      sessionId: 'provider-session-2',
    });
    const abortController = new AbortController();

    const result = await session.createTaskInstruction({
      userNote: 'worktree で実行できるように積んで',
      abortSignal: abortController.signal,
    });

    expect(mockBuildSummaryPrompt).toHaveBeenCalledWith(
      [{ role: 'user', content: 'implement ACP support' }, { role: 'assistant', content: 'Assistant answer' }],
      'worktree で実行できるように積んで',
      'en',
      'summary context',
      true,
    );
    expect(mockCallAIWithRetry).toHaveBeenCalledWith(
      'summary prompt',
      'summary prompt',
      ['Read'],
      '/repo',
      expect.objectContaining({
        sessionId: undefined,
      }),
      expect.objectContaining({
        abortSignal: abortController.signal,
        persistSession: false,
      }),
    );
    expect(result).toEqual({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support with enqueue-first ACP.',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support with enqueue-first ACP.',
      },
      sessionId: 'provider-session-2',
    });
  });

  it('should include a workflow identifier from the task instruction note', async () => {
    const session = createSession();
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'Implement ACP support.',
        sessionId: 'provider-session-2',
        success: true,
      },
      sessionId: 'provider-session-2',
    });

    const result = await session.createTaskInstruction({
      userNote: 'この内容をタスクに積んで。workflow: review',
    });

    expect(result).toEqual({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support.',
      workflowIdentifier: 'review',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support.',
      },
      sessionId: 'provider-session-2',
    });
  });

  it('should include a workflow identifier from user conversation history', async () => {
    const session = createSession();
    await session.handleUserMessage({ text: 'workflow: review で ACP enqueue の実装方針を相談したい' });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'Implement ACP support.',
        sessionId: 'provider-session-2',
        success: true,
      },
      sessionId: 'provider-session-2',
    });

    const result = await session.createTaskInstruction({
      userNote: 'この内容をタスクに積んで',
    });

    expect(result).toEqual({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support.',
      workflowIdentifier: 'review',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support.',
      },
      sessionId: 'provider-session-2',
    });
  });

  it('should not infer a workflow identifier from generated task text', async () => {
    const session = createSession();
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'Implement workflow review support.',
        sessionId: 'provider-session-2',
        success: true,
      },
      sessionId: 'provider-session-2',
    });

    const result = await session.createTaskInstruction({
      userNote: 'この内容をタスクに積んで',
    });

    expect(result).toEqual({
      kind: 'workflow_execution_requested',
      task: 'Implement workflow review support.',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement workflow review support.',
      },
      sessionId: 'provider-session-2',
    });
  });

  it('should reject an empty /go summary instead of requesting workflow execution', async () => {
    const session = createSession();
    await session.handleUserMessage({ text: 'implement ACP support' });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: '   ',
        success: true,
      },
      sessionId: undefined,
    });

    const result = await session.handleUserMessage({ text: '/go include progress updates' });

    expect(result).toEqual({
      kind: 'error',
      message: 'Task text is required',
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
      true,
    );
  });
});
