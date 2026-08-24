/**
 * What the conversation reports when a turn produces no answer.
 *
 * A provider that fails says why — in its `error` field, or by throwing — and
 * that reason has to reach the front-end. Only a caller with a terminal used to
 * see it; the TUI renders what it is handed, so anything dropped here reaches
 * the user as "the assistant returned no response".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCall } = vi.hoisted(() => ({ mockCall: vi.fn() }));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  updatePersonaSession: vi.fn(),
}));

import { updatePersonaSession } from '../infra/config/index.js';
import { createConversationSession } from '../features/interactive/conversationSession.js';
import { makeProvider, makeSessionContext } from './test-helpers.js';

const mockUpdatePersonaSession = vi.mocked(updatePersonaSession);

function createSession(
  sessionId?: string,
  effort?: string,
  disableSessionRetry?: boolean,
  model?: string,
  persistSession?: boolean,
) {
  return createConversationSession({
    cwd: '/repo',
    outputMode: 'silent',
    formalSpec: false,
    ...(persistSession === false ? { persistSession: false } : {}),
    ctx: makeSessionContext({
      provider: makeProvider({ setup: () => ({ call: mockCall }) }),
      sessionId,
      effort,
      ...(model === undefined ? {} : { model }),
      ...(disableSessionRetry === true ? { disableSessionRetry: true } : {}),
    }),
    strategy: {
      systemPrompt: 'system',
      allowedTools: [],
      transformPrompt: (message: string) => message,
    },
    resolveImageAttachments: () => [
      { placeholder: '[Image #1]', path: '/tmp/shot.png' },
    ],
  });
}

// Queued one-shot responses outlive a test that does not consume them, so a
// single failure would otherwise reappear as an unrelated one further down.
beforeEach(() => {
  mockCall.mockReset();
  mockUpdatePersonaSession.mockClear();
});

describe('a turn the caller has already moved past', () => {
  /** Resolves the call by hand so two turns can be in flight at once. */
  function createPendingCall(): {
    readonly settle: (response: Record<string, unknown>) => void;
    readonly promise: Promise<unknown>;
  } {
    let settle!: (response: Record<string, unknown>) => void;
    const promise = new Promise((resolve) => {
      settle = (response) => resolve(response);
    });
    return { settle, promise };
  }

  it('should not let a late completion undo the turn that replaced it', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession();

    // The user interrupts this one and asks something else.
    const abandoned = session.handleUserMessage({ text: 'first question' });

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'second answer',
      sessionId: 'session-second',
      timestamp: new Date(),
    });
    const answered = await session.handleUserMessage({ text: 'second question' });
    expect(answered).toMatchObject({ kind: 'assistant_response', content: 'second answer' });

    // The abandoned call answers afterwards, describing a conversation that has
    // already moved on.
    interrupted.settle({
      persona: 'interactive',
      status: 'done',
      content: 'late answer',
      sessionId: 'session-abandoned',
      timestamp: new Date(),
    });
    await abandoned;

    // The next summary is built from the history, which must still be the one
    // the user saw: the second turn answered, the stale one did not rewrite it.
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Task instruction',
      timestamp: new Date(),
    });
    await session.createTaskInstruction({ userNote: '' });
    const summaryPrompt = String(mockCall.mock.calls[2]?.[0] ?? '');
    expect(summaryPrompt).toContain('second question');
    expect(summaryPrompt).toContain('second answer');
    expect(summaryPrompt).not.toContain('late answer');
  });

  it('should not let a chat turn that /go replaced write into the summary', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession();

    // The user gives up waiting for the answer and summarizes instead.
    const abandoned = session.handleUserMessage({ text: 'first question' });
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Task instruction',
      timestamp: new Date(),
    });
    const instruction = await session.createTaskInstruction({ userNote: 'ship it' });
    expect(instruction).toMatchObject({ kind: 'workflow_execution_requested' });

    interrupted.settle({
      persona: 'interactive',
      status: 'done',
      content: 'late answer',
      timestamp: new Date(),
    });
    await abandoned;

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Second instruction',
      timestamp: new Date(),
    });
    await session.createTaskInstruction({ userNote: '' });
    const summaryPrompt = String(mockCall.mock.calls[2]?.[0] ?? '');
    expect(summaryPrompt).toContain('first question');
    expect(summaryPrompt).not.toContain('late answer');
  });

  it('should not let a chat turn that /go replaced roll the history back', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession();

    const abandoned = session.handleUserMessage({ text: 'first question' });
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Task instruction',
      timestamp: new Date(),
    });
    await session.createTaskInstruction({ userNote: 'ship it' });

    // For the current turn this failure would mean a rollback; this one is past.
    interrupted.settle({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'aborted',
      timestamp: new Date(),
    });
    await abandoned;

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Second instruction',
      timestamp: new Date(),
    });
    await session.createTaskInstruction({ userNote: '' });
    const summaryPrompt = String(mockCall.mock.calls[2]?.[0] ?? '');
    expect(summaryPrompt).toContain('first question');
  });

  it('should keep an interrupted answer out of the conversation, session and all', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession();
    const controller = new AbortController();

    const abandoned = session.handleUserMessage({
      text: 'first question',
      abortSignal: controller.signal,
    });
    controller.abort();

    // The provider ignored the abort and answered anyway. Nothing of that answer
    // was ever on screen, so nothing of it may reach the conversation.
    interrupted.settle({
      persona: 'interactive',
      status: 'done',
      content: 'answer nobody saw',
      sessionId: 'session-unseen',
      timestamp: new Date(),
    });
    await abandoned;

    expect(session.getLatestAssistantMessage()).toBeNull();
    expect(mockUpdatePersonaSession.mock.calls.map((call) => call[2])).not.toContain('session-unseen');

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Task instruction',
      timestamp: new Date(),
    });
    await session.createTaskInstruction({ userNote: '' });
    const summaryPrompt = String(mockCall.mock.calls[1]?.[0] ?? '');
    // The question the user asked is on screen as their own line, so it stays.
    expect(summaryPrompt).toContain('first question');
    expect(summaryPrompt).not.toContain('answer nobody saw');
  });

  it('should keep the interrupted message when the abort surfaces as a failure', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession();
    const controller = new AbortController();

    const abandoned = session.handleUserMessage({
      text: 'first question',
      abortSignal: controller.signal,
    });
    controller.abort();

    // An aborted call usually comes back as a failure, and a failure normally
    // rolls the turn back — but the user's line is on screen and stays.
    interrupted.settle({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'aborted',
      timestamp: new Date(),
    });
    await abandoned;

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Task instruction',
      timestamp: new Date(),
    });
    await session.createTaskInstruction({ userNote: '' });
    expect(String(mockCall.mock.calls[1]?.[0] ?? '')).toContain('first question');
  });

  it('should not persist the session a superseded turn came back with', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession();

    const abandoned = session.handleUserMessage({ text: 'first question' });
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'second answer',
      sessionId: 'session-second',
      timestamp: new Date(),
    });
    await session.handleUserMessage({ text: 'second question' });

    interrupted.settle({
      persona: 'interactive',
      status: 'done',
      content: 'late answer',
      sessionId: 'session-abandoned',
      timestamp: new Date(),
    });
    await abandoned;

    // Resuming has to land on the conversation the user is actually in.
    const persisted = mockUpdatePersonaSession.mock.calls.map((call) => call[2]);
    expect(persisted).toContain('session-second');
    expect(persisted).not.toContain('session-abandoned');
  });

  it('should not persist the session a superseded turn retried into', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession('session-existing');

    const abandoned = session.handleUserMessage({ text: 'first question' });
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'second answer',
      sessionId: 'session-second',
      timestamp: new Date(),
    });
    await session.handleUserMessage({ text: 'second question' });

    // A stale session makes the call retry without one; that answer is just as
    // superseded as the first attempt was.
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'late retry answer',
      sessionId: 'session-retry',
      timestamp: new Date(),
    });
    interrupted.settle({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'session expired',
      timestamp: new Date(),
    });
    await abandoned;

    const persisted = mockUpdatePersonaSession.mock.calls.map((call) => call[2]);
    expect(persisted).not.toContain('session-retry');
  });

  it('should not let a late failure roll the history back', async () => {
    const interrupted = createPendingCall();
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession();

    const abandoned = session.handleUserMessage({ text: 'first question' });

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'second answer',
      timestamp: new Date(),
    });
    await session.handleUserMessage({ text: 'second question' });

    // The abandoned call fails, which for the current turn would mean a rollback.
    interrupted.settle({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'aborted',
      timestamp: new Date(),
    });
    await abandoned;

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'Task instruction',
      timestamp: new Date(),
    });
    await session.createTaskInstruction({ userNote: '' });
    const summaryPrompt = String(mockCall.mock.calls[2]?.[0] ?? '');
    expect(summaryPrompt).toContain('second question');
    expect(summaryPrompt).toContain('second answer');
  });
});

describe('a turn that produces no answer', () => {
  it('should not automatically resend a failed message when interactive effort is set', async () => {
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'unsupported effort',
      timestamp: new Date(),
    });
    const session = createSession('session-existing', 'custom-effort');

    const failed = await session.handleUserMessage({ text: 'send once' });

    expect(failed).toEqual({
      kind: 'error',
      code: 'provider_error',
      message: 'unsupported effort',
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      sessionId: 'session-existing',
      effort: 'custom-effort',
    }));

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'manual retry succeeded',
      sessionId: 'session-existing',
      timestamp: new Date(),
    });
    const retried = await session.handleUserMessage({ text: 'send once' });

    expect(retried).toMatchObject({
      kind: 'assistant_response',
      content: 'manual retry succeeded',
    });
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it('should not automatically resend a failed message when an interactive model override is active', async () => {
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'unsupported model',
      timestamp: new Date(),
    });
    const session = createSession('session-existing', undefined, true, 'custom-model');

    const failed = await session.handleUserMessage({ text: 'send once' });

    expect(failed).toEqual({
      kind: 'error',
      code: 'provider_error',
      message: 'unsupported model',
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      model: 'custom-model',
      sessionId: 'session-existing',
    }));

    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'manual retry succeeded',
      sessionId: 'session-existing',
      timestamp: new Date(),
    });
    const retried = await session.handleUserMessage({ text: 'send once' });

    expect(retried).toMatchObject({
      kind: 'assistant_response',
      content: 'manual retry succeeded',
    });
    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(mockCall.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      model: 'custom-model',
      sessionId: 'session-existing',
    }));
  });

  it('should not persist a session created with a temporary provider or model', async () => {
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'done',
      content: 'temporary answer',
      sessionId: 'temporary-session',
      timestamp: new Date(),
    });
    const session = createSession(undefined, undefined, true, 'custom-model', false);

    const result = await session.handleUserMessage({ text: 'send once' });

    expect(result).toMatchObject({
      kind: 'assistant_response',
      content: 'temporary answer',
    });
    expect(mockUpdatePersonaSession).not.toHaveBeenCalled();
  });

  it('should report the provider error text when the provider fails', async () => {
    mockCall.mockResolvedValue({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'opencode: model moonshotai/kimi-k3 is not available',
      timestamp: new Date(),
    });
    const session = createSession();

    const result = await session.handleUserMessage({ text: 'is this visible?' });

    expect(result).toEqual({
      kind: 'error',
      code: 'provider_error',
      message: 'opencode: model moonshotai/kimi-k3 is not available',
    });
  });

  it('should report the thrown reason instead of an empty answer', async () => {
    mockCall.mockRejectedValue(new Error('opencode server did not start'));
    const session = createSession();

    const result = await session.handleUserMessage({ text: 'is this visible?' });

    expect(result).toEqual({
      kind: 'error',
      code: 'provider_error',
      message: 'opencode server did not start',
    });
  });

  it('should keep the generic wording only when the provider answered with nothing', async () => {
    mockCall.mockResolvedValue({
      persona: 'interactive',
      status: 'done',
      content: '',
      timestamp: new Date(),
    });
    const session = createSession();

    const result = await session.handleUserMessage({ text: 'is this visible?' });

    // A finished call with empty content is not a failure the provider named.
    expect(result).toMatchObject({ kind: 'assistant_response', content: '' });
  });

  it('should tell the caller when the images went as paths rather than images', async () => {
    mockCall.mockResolvedValue({
      persona: 'interactive',
      status: 'done',
      content: 'an answer',
      timestamp: new Date(),
    });
    const notices: string[] = [];
    const session = createSession();

    await session.handleUserMessage({
      text: 'look at [Image #1]',
      onNotice: (message) => notices.push(message),
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('does not support native image input');
  });
});
