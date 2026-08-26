import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamCallback } from '../shared/types/provider.js';

const {
  mockCreateAssistantConversationPlan,
  mockCreateConversationSession,
  mockCreateInstructConversationPlan,
  mockCreateRetryConversationPlan,
  mockGetWorkflowDescription,
  mockResolveFormalSpecModeWithoutPrompt,
} = vi.hoisted(() => ({
  mockCreateAssistantConversationPlan: vi.fn(),
  mockCreateConversationSession: vi.fn(),
  mockCreateInstructConversationPlan: vi.fn(),
  mockCreateRetryConversationPlan: vi.fn(),
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

vi.mock('../features/interactive/taskActionConversationPlan.js', () => ({
  createInstructConversationPlan: (...args: unknown[]) => mockCreateInstructConversationPlan(...args),
  createRetryConversationPlan: (...args: unknown[]) => mockCreateRetryConversationPlan(...args),
}));

import {
  createWebChatService,
  parseCreateWebChatRequest,
  parseWebChatMessage,
  parseWebChatMessageRequest,
  WebChatInputError,
  type WebTaskActionContext,
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
  mockCreateRetryConversationPlan.mockReturnValue(createPlan('retry'));
  mockCreateInstructConversationPlan.mockReturnValue(createPlan('instruct'));
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
    expect(parseWebChatMessageRequest({
      text: '  /go  ',
      taskActionOptionId: 'restart:plan',
    })).toEqual({ text: '/go', taskActionOptionId: 'restart:plan' });
    expect(() => parseWebChatMessageRequest({ text: '/go', taskActionOptionId: '' }))
      .toThrow('taskActionOptionId is invalid');
  });

  it('binds task-action options to a process-local single-use claim', async () => {
    const service = createWebChatService();
    const context: WebTaskActionContext = {
      taskId: 'task-1',
      action: 'retry',
      projectId: 'project-1',
      stateId: 'state-1',
      projectDirectory: '/repo',
      task: 'fix it',
      workflow: 'default',
      status: 'failed',
      attempt: 1,
      runIds: ['run-1'],
      generation: 2,
      runId: 'run-1',
      sourceRunId: 'run-1',
      retryStartOptions: {
        defaultId: 'restart:plan',
        options: [{ id: 'restart:plan', label: 'plan', selectable: true }],
      },
      retryStartSelections: [{
        id: 'restart:plan',
        selection: {
          kind: 'restart',
          restartPoint: {
            stack: [{ workflow: 'default', workflow_ref: 'default', step: 'plan', kind: 'agent' }],
          },
        },
      }],
    };
    const created = service.createTaskAction?.('/repo', context);
    if (
      created === undefined
      || service.claimTaskAction === undefined
      || service.commitTaskAction === undefined
      || service.releaseTaskAction === undefined
    ) {
      throw new Error('task-action chat support is unavailable');
    }
    const firstClaim = service.claimTaskAction(created.id, 'restart:plan');
    expect(firstClaim).toMatchObject({
      context: { taskId: 'task-1', projectId: 'project-1', stateId: 'state-1', generation: 2 },
      retrySelection: { kind: 'restart' },
    });
    expect(firstClaim.reservationToken).toEqual(expect.any(String));
    await expect(service.send(created.id, 'もう一度')).rejects.toThrow('already been finalized');
    expect(() => service.claimTaskAction!(created.id, 'restart:plan'))
      .toThrow('already been finalized');
    expect(() => service.releaseTaskAction!(created.id, 'wrong-reservation'))
      .toThrow('not owned');
    service.releaseTaskAction(created.id, firstClaim.reservationToken);
    const reclaimed = service.claimTaskAction(created.id, 'restart:plan');
    expect(reclaimed.reservationToken).not.toBe(firstClaim.reservationToken);
    service.commitTaskAction(created.id, reclaimed.reservationToken);
    await expect(service.send(created.id, 'もう一度')).rejects.toThrow('already been finalized');
    expect(() => service.restart!(created.id)).toThrow('already been finalized');
    expect(() => service.releaseTaskAction!(created.id, reclaimed.reservationToken))
      .toThrow('not owned');
    expect(() => service.commitTaskAction!(created.id, reclaimed.reservationToken))
      .toThrow('already been finalized');
    expect(() => service.claimTaskAction!('unknown-session', 'restart:plan'))
      .toThrow('Chat session not found');
    const instruct = service.createTaskAction?.('/repo', {
      ...context,
      taskId: 'task-instruct',
      action: 'instruct',
      status: 'completed',
    });
    if (instruct === undefined) throw new Error('instruct task-action chat was not created');
    expect(() => service.claimTaskAction!(instruct.id, 'restart:plan'))
      .toThrow('does not accept a retry start option');

    // The oldest process-local session is evicted once the bounded map is full.
    for (let index = 0; index < 20; index += 1) {
      service.createTaskAction?.('/repo', { ...context, taskId: `task-${index + 2}` });
    }
    expect(() => service.claimTaskAction!(created.id, 'restart:plan'))
      .toThrow('Chat session not found');
  });

  it('protects a reserved task-action session from bounded-session eviction', () => {
    const service = createWebChatService();
    if (service.createTaskAction === undefined || service.claimTaskAction === undefined) {
      throw new Error('task-action chat support is unavailable');
    }
    const context: WebTaskActionContext = {
      taskId: 'reserved-task',
      action: 'retry',
      projectDirectory: '/repo',
      task: 'fix it',
      workflow: 'default',
      status: 'failed',
      attempt: 1,
      runIds: ['run-1'],
      retryStartSelections: [{
        id: 'restart:plan',
        selection: {
          kind: 'restart',
          restartPoint: {
            stack: [{ workflow: 'default', workflow_ref: 'default', step: 'plan', kind: 'agent' }],
          },
        },
      }],
    };
    const reserved = service.createTaskAction('/repo', context);
    const claim = service.claimTaskAction(reserved.id, 'restart:plan');

    for (let index = 0; index < 20; index += 1) {
      service.create('/repo', { workflow: 'default', mode: 'assistant' });
    }

    expect(service.getTaskActionContext?.(reserved.id)).toMatchObject({ taskId: 'reserved-task' });
    service.releaseTaskAction(reserved.id, claim.reservationToken);
  });

  it('protects a busy conversation from bounded-session eviction', async () => {
    let resolveMessage!: () => void;
    const session = createSessionDouble();
    session.handleUserMessage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMessage = () => resolve({ kind: 'assistant_response', content: 'response' });
    }));
    mockCreateConversationSession.mockReturnValue(session);
    const service = createWebChatService();
    const created = service.create('/repo', { workflow: 'default', mode: 'assistant' });
    const pending = service.send(created.id, '待機');
    await Promise.resolve();

    for (let index = 0; index < 20; index += 1) {
      service.create('/repo', { workflow: 'default', mode: 'assistant' });
    }

    await expect(service.send(created.id, '再送')).rejects.toThrow('busy');
    resolveMessage();
    await expect(pending).resolves.toEqual({ kind: 'assistant_response', content: 'response' });
  });

  it('rejects creation when every existing session is protected', () => {
    const service = createWebChatService();
    if (service.createTaskAction === undefined || service.claimTaskAction === undefined) {
      throw new Error('task-action chat support is unavailable');
    }
    const sessions = Array.from({ length: 20 }, (_, index) => service.createTaskAction!('/repo', {
      taskId: `protected-${index}`,
      action: 'retry',
      projectDirectory: '/repo',
      task: 'fix it',
      workflow: 'default',
      status: 'failed',
      attempt: 1,
      runIds: [`run-${index}`],
      retryStartSelections: [{
        id: 'restart:plan',
        selection: {
          kind: 'restart',
          restartPoint: {
            stack: [{ workflow: 'default', workflow_ref: 'default', step: 'plan', kind: 'agent' }],
          },
        },
      }],
    }));
    for (const session of sessions) {
      service.claimTaskAction(session.id, 'restart:plan');
    }

    try {
      service.create('/repo', { workflow: 'default', mode: 'assistant' });
      throw new Error('expected session capacity rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WebChatInputError);
      expect((error as WebChatInputError).status).toBe(503);
    }
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
    await expect(service.send(created.id, '通常会話', undefined, 'restart:plan'))
      .rejects.toThrow('only valid for task action conversations');
  });
});
