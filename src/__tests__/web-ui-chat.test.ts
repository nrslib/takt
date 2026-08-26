import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamCallback } from '../shared/types/provider.js';

const {
  mockCreateAssistantConversationPlan,
  mockCreateConversationSession,
  mockGetWorkflowDescription,
  mockResolveFormalSpecModeWithoutPrompt,
} = vi.hoisted(() => ({
  mockCreateAssistantConversationPlan: vi.fn(),
  mockCreateConversationSession: vi.fn(),
  mockGetWorkflowDescription: vi.fn(),
  mockResolveFormalSpecModeWithoutPrompt: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
}));

vi.mock('../features/interactive/conversationPlan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/conversationPlan.js')>()),
  createAssistantConversationPlan: (...args: unknown[]) =>
    mockCreateAssistantConversationPlan(...args),
}));

vi.mock('../features/interactive/conversationSession.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/conversationSession.js')>()),
  createConversationSession: (...args: unknown[]) => mockCreateConversationSession(...args),
}));

vi.mock('../features/interactive/taskInstructionFormat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/taskInstructionFormat.js')>()),
  resolveFormalSpecModeWithoutPrompt: (...args: unknown[]) =>
    mockResolveFormalSpecModeWithoutPrompt(...args),
}));

import {
  createWebChatService,
  parseCreateWebChatRequest,
  parseWebChatMessage,
  WebChatInputError,
} from '../features/web-ui/chat.js';

function createPlan(workflow: string, model: string | null = `model-${workflow}`) {
  return {
    ctx: {
      providerType: 'mock',
      ...(model === null ? {} : { model }),
      lang: 'ja',
    },
    strategy: {
      introMessage: `${workflow} intro`,
      systemPrompt: `${workflow} system`,
      allowedTools: [],
      formalSpec: false,
      transformPrompt: (message: string) => message,
    },
  };
}

function createSessionDouble(history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> = []) {
  return {
    snapshotHistory: vi.fn(() => history),
    handleUserMessage: vi.fn(async (_input: { text: string; onStream?: StreamCallback }) => ({
      kind: 'assistant_response' as const,
      content: 'response',
    })),
    createTaskInstruction: vi.fn(),
    getLatestAssistantMessage: vi.fn(() => null),
    recordRejectedDraft: vi.fn(),
    setSessionId: vi.fn(),
    setPromptConfiguration: vi.fn(),
    setEffort: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWorkflowDescription.mockImplementation((workflow: string) => ({
    name: workflow,
    description: `${workflow} workflow`,
    workflowStructure: '1. discuss',
    stepPreviews: [],
  }));
  mockResolveFormalSpecModeWithoutPrompt.mockReturnValue(false);
  mockCreateAssistantConversationPlan.mockImplementation((
    _cwd: string,
    options: { workflowContext: { name: string } },
  ) => createPlan(options.workflowContext.name));
});

describe('Web UI chat input', () => {
  it('accepts the interactive modes supported by Web UI', () => {
    expect(parseCreateWebChatRequest({ workflow: ' default ', mode: 'assistant' })).toEqual({
      workflow: 'default',
      mode: 'assistant',
    });
    expect(parseCreateWebChatRequest({ workflow: 'review', mode: 'grill-me' }).mode).toBe('grill-me');
    expect(parseCreateWebChatRequest({ workflow: 'review', mode: 'persona' }).mode).toBe('persona');
  });

  it('rejects non-conversational modes and empty messages', () => {
    expect(() => parseCreateWebChatRequest({ workflow: 'default', mode: 'quiet' }))
      .toThrow(WebChatInputError);
    expect(() => parseWebChatMessage({ text: '  ' })).toThrow('text is required');
  });

  it('normalizes a chat message', () => {
    expect(parseWebChatMessage({ text: '  相談したい  ' })).toBe('相談したい');
  });
});

describe('Web UI chat session settings', () => {
  it('rebuilds with TUI-compatible handoff history and keeps the session id', () => {
    const history = [
      { role: 'user' as const, content: '認証を追加したい' },
      { role: 'assistant' as const, content: '方式を確認します。' },
    ];
    const initialSession = createSessionDouble(history);
    const switchedSession = createSessionDouble(history);
    const restartedSession = createSessionDouble();
    mockCreateConversationSession
      .mockReturnValueOnce(initialSession)
      .mockReturnValueOnce(switchedSession)
      .mockReturnValueOnce(restartedSession);
    const service = createWebChatService();

    const created = service.create('/repo', { workflow: 'default', mode: 'assistant' });
    expect(mockCreateConversationSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      persistSession: false,
    }));
    const switched = service.reconfigure(created.id, {
      workflow: 'review',
      mode: 'grill-me',
    });

    expect(switched).toMatchObject({
      id: created.id,
      workflow: 'review',
      mode: 'grill-me',
      model: 'model-review',
    });
    expect(initialSession.snapshotHistory).toHaveBeenCalledTimes(1);
    expect(mockCreateConversationSession.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      handoffHistory: history,
      persistSession: false,
    }));

    mockCreateAssistantConversationPlan.mockReset();
    mockCreateAssistantConversationPlan.mockReturnValue(createPlan('review', null));
    const restarted = service.restart(created.id);
    expect(mockCreateConversationSession).toHaveBeenCalledTimes(3);
    expect(restarted.id).toBe(created.id);
    expect(restarted).not.toHaveProperty('model');
    const restartedSessionOptions = mockCreateConversationSession.mock.calls[2];
    if (restartedSessionOptions === undefined) throw new Error('restart session was not created');
    expect(restartedSessionOptions[0]).not.toHaveProperty('handoffHistory');
    expect(restartedSessionOptions[0]).toHaveProperty('persistSession', false);
    expect(switchedSession.snapshotHistory).not.toHaveBeenCalled();
  });

  it('keeps the old conversation when rebuilding the selected settings fails', async () => {
    const initialSession = createSessionDouble();
    mockCreateConversationSession.mockReturnValue(initialSession);
    mockCreateAssistantConversationPlan
      .mockImplementationOnce((
        _cwd: string,
        options: { workflowContext: { name: string } },
      ) => createPlan(options.workflowContext.name))
      .mockImplementationOnce(() => {
        throw new Error('rebuild failed');
      });
    const service = createWebChatService();
    const created = service.create('/repo', { workflow: 'default', mode: 'assistant' });

    expect(() => service.reconfigure(created.id, { workflow: 'review', mode: 'assistant' }))
      .toThrow('rebuild failed');
    await expect(service.send(created.id, '続ける')).resolves.toEqual({
      kind: 'assistant_response',
      content: 'response',
    });
    expect(initialSession.handleUserMessage).toHaveBeenCalledWith({ text: '続ける' });
  });

  it('forwards only provider thinking events to the Web UI stream', async () => {
    const session = createSessionDouble();
    session.handleUserMessage.mockImplementationOnce(async (input) => {
      input.onStream?.({ type: 'thinking', data: { thinking: '調査中' } });
      input.onStream?.({ type: 'text', data: { text: '回答の断片' } });
      input.onStream?.({ type: 'thinking', data: { thinking: 'です。' } });
      return { kind: 'assistant_response', content: 'response' };
    });
    mockCreateConversationSession.mockReturnValue(session);
    const service = createWebChatService();
    const created = service.create('/repo', { workflow: 'default', mode: 'assistant' });
    const thinking: string[] = [];

    await expect(service.send(created.id, '相談', (content) => thinking.push(content)))
      .resolves.toEqual({ kind: 'assistant_response', content: 'response' });
    expect(thinking).toEqual(['調査中', 'です。']);
  });
});
