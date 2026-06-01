import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, InteractiveModeResult, WorkflowContext } from '../features/interactive/interactive.js';
import type { SessionContext } from '../features/interactive/aiCaller.js';

const mockReadInteractiveInput = vi.fn();
const mockCallAIWithRetry = vi.fn();
const mockInfo = vi.fn();
const mockError = vi.fn();
const mockBlankLine = vi.fn();
const mockSelectRecentSession = vi.fn();

vi.mock('../features/interactive/interactiveInput.js', () => ({
  readInteractiveInput: (...args: unknown[]) => mockReadInteractiveInput(...args),
}));

vi.mock('../features/interactive/aiCaller.js', () => ({
  callAIWithRetry: (...args: unknown[]) => mockCallAIWithRetry(...args),
}));

vi.mock('../features/interactive/sessionSelector.js', () => ({
  selectRecentSession: (...args: unknown[]) => mockSelectRecentSession(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockError(...args),
  blankLine: (...args: unknown[]) => mockBlankLine(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { runConversationLoop, type ConversationStrategy } from '../features/interactive/conversationLoop.js';

type ConversationGoContext = {
  history: ConversationMessage[];
  inlineText: string;
  sessionId: string | undefined;
  sourceContext: string | undefined;
  workflowContext: WorkflowContext | undefined;
  cwd: string;
  ctx: SessionContext;
};

function createSessionContext(): SessionContext {
  return {
    provider: {
      setup: vi.fn(),
    } as unknown as SessionContext['provider'],
    providerType: 'mock',
    model: undefined,
    lang: 'en',
    personaName: 'workflow-builder',
    sessionId: 'session-1',
  };
}

describe('runConversationLoop builder /go hook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('delegates /go to the strategy hook and skips the default summary AI call', async () => {
    const handleGo = vi.fn(async (context: ConversationGoContext): Promise<InteractiveModeResult> => {
      expect(context.history).toEqual([
        { role: 'user', content: 'create a review workflow' },
        { role: 'assistant', content: 'I will draft the workflow and facets.' },
      ]);
      expect(context.inlineText).toBe('');
      expect(context.sessionId).toBe('session-after-turn');
      expect(context.cwd).toBe('/project');
      expect(context.ctx.personaName).toBe('workflow-builder');
      return { action: 'execute', task: 'builder completed' };
    });
    const strategy: ConversationStrategy & {
      handleGo: (context: ConversationGoContext) => Promise<InteractiveModeResult | null>;
    } = {
      systemPrompt: 'builder system prompt',
      allowedTools: ['Read', 'Glob', 'Grep'],
      transformPrompt: (message) => message,
      introMessage: 'builder intro',
      selectAction: async () => 'execute',
      handleGo,
    };
    mockReadInteractiveInput
      .mockResolvedValueOnce('create a review workflow')
      .mockResolvedValueOnce('/go');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'I will draft the workflow and facets.',
        success: true,
        sessionId: 'session-after-turn',
      },
      sessionId: 'session-after-turn',
    }).mockResolvedValueOnce({
      result: {
        content: 'default summary should not run',
        success: true,
      },
      sessionId: undefined,
    });

    const result = await runConversationLoop('/project', createSessionContext(), strategy, undefined, undefined);

    expect(result).toEqual({ action: 'execute', task: 'builder completed' });
    expect(handleGo).toHaveBeenCalledTimes(1);
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(1);
    expect(mockCallAIWithRetry).toHaveBeenCalledWith(
      'create a review workflow',
      'builder system prompt',
      ['Read', 'Glob', 'Grep'],
      '/project',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('continues the conversation when the strategy hook returns null', async () => {
    const handleGo = vi.fn(async (): Promise<InteractiveModeResult | null> => null);
    const strategy: ConversationStrategy & {
      handleGo: (context: ConversationGoContext) => Promise<InteractiveModeResult | null>;
    } = {
      systemPrompt: 'builder system prompt',
      allowedTools: ['Read', 'Glob', 'Grep'],
      transformPrompt: (message) => message,
      introMessage: 'builder intro',
      selectAction: async () => 'continue',
      handleGo,
    };
    mockReadInteractiveInput
      .mockResolvedValueOnce('create a review workflow')
      .mockResolvedValueOnce('/go fix validation errors')
      .mockResolvedValueOnce('/cancel');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'The workflow needs one validation pass.',
        success: true,
        sessionId: 'session-after-turn',
      },
      sessionId: 'session-after-turn',
    }).mockResolvedValueOnce({
      result: {
        content: 'default summary should not run',
        success: true,
      },
      sessionId: undefined,
    });

    const result = await runConversationLoop('/project', createSessionContext(), strategy, undefined, undefined);

    expect(result).toEqual({ action: 'cancel', task: '' });
    expect(handleGo).toHaveBeenCalledWith(expect.objectContaining({
      inlineText: 'fix validation errors',
      sessionId: 'session-after-turn',
    }));
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(1);
  });

  it('does not let /accept bypass a strategy that requires /go', async () => {
    const handleGo = vi.fn(async (): Promise<InteractiveModeResult> => ({ action: 'execute', task: 'applied' }));
    const strategy: ConversationStrategy = {
      systemPrompt: 'builder system prompt',
      allowedTools: ['Read', 'Glob', 'Grep'],
      transformPrompt: (message) => message,
      introMessage: 'builder intro',
      disableDirectExecuteCommands: true,
      handleGo,
    };
    mockReadInteractiveInput
      .mockResolvedValueOnce('create a review workflow')
      .mockResolvedValueOnce('/accept')
      .mockResolvedValueOnce('/go');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: {
        content: 'I will draft the workflow and facets.',
        success: true,
        sessionId: 'session-after-turn',
      },
      sessionId: 'session-after-turn',
    });

    const result = await runConversationLoop('/project', createSessionContext(), strategy, undefined, undefined);

    expect(result).toEqual({ action: 'execute', task: 'applied' });
    expect(handleGo).toHaveBeenCalledTimes(1);
  });

  it('does not let /play bypass a strategy that requires /go', async () => {
    const handleGo = vi.fn(async (): Promise<InteractiveModeResult> => ({ action: 'execute', task: 'applied' }));
    const strategy: ConversationStrategy = {
      systemPrompt: 'builder system prompt',
      allowedTools: ['Read', 'Glob', 'Grep'],
      transformPrompt: (message) => message,
      introMessage: 'builder intro',
      disableDirectExecuteCommands: true,
      handleGo,
    };
    mockReadInteractiveInput
      .mockResolvedValueOnce('/play skip manifest')
      .mockResolvedValueOnce('/go');

    const result = await runConversationLoop('/project', createSessionContext(), strategy, undefined, undefined);

    expect(result).toEqual({ action: 'execute', task: 'applied' });
    expect(handleGo).toHaveBeenCalledTimes(1);
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('does not run session selection when resume is disabled', async () => {
    const handleGo = vi.fn(async (): Promise<InteractiveModeResult> => ({ action: 'execute', task: 'applied' }));
    const strategy: ConversationStrategy = {
      systemPrompt: 'builder system prompt',
      allowedTools: ['Read', 'Glob', 'Grep'],
      transformPrompt: (message) => message,
      introMessage: 'builder intro',
      enableResumeCommand: false,
      handleGo,
    };
    mockReadInteractiveInput
      .mockResolvedValueOnce('/resume')
      .mockResolvedValueOnce('/go');

    const result = await runConversationLoop('/project', createSessionContext(), strategy, undefined, undefined);

    expect(result).toEqual({ action: 'execute', task: 'applied' });
    expect(mockSelectRecentSession).not.toHaveBeenCalled();
  });
});
