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
import { createConversationSession, type ConversationSessionStrategy } from '../features/interactive/conversationSession.js';
import { makeProvider, makeSessionContext } from './test-helpers.js';
import { expectUndeliveredPrompt } from './helpers/undelivered.js';
import type { ConversationSessionOptions } from '../features/interactive/conversationSession.js';

const mockUpdatePersonaSession = vi.mocked(updatePersonaSession);

interface SessionOptions {
  sessionId?: string;
  effort?: string;
  disableSessionRetry?: boolean;
  model?: string;
  formalSpec?: boolean;
  persistSession?: boolean;
  resolveCurrentPromptConfiguration?: ConversationSessionStrategy['resolveCurrentPromptConfiguration'];
  handoffHistory?: ConversationSessionOptions['handoffHistory'];
  resolveImageAttachments?: ConversationSessionOptions['resolveImageAttachments'];
}

function createSession({
  sessionId,
  effort,
  disableSessionRetry,
  model,
  formalSpec = false,
  persistSession,
  resolveCurrentPromptConfiguration,
  handoffHistory,
  resolveImageAttachments,
}: SessionOptions = {}) {
  return createConversationSession({
    cwd: '/repo',
    outputMode: 'silent',
    formalSpec,
    modelCheckTimeoutSeconds: 300,
    handoffHistory,
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
      modelCheckTimeoutSeconds: 300,
      allowedTools: [],
      transformPrompt: (message: string) => message,
      resolveCurrentPromptConfiguration,
    },
    resolveImageAttachments: resolveImageAttachments ?? ((prompt: string) => prompt.includes('[Image #1]') ? [
      { placeholder: '[Image #1]', path: '/tmp/shot.png' },
    ] : []),
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

  it.each(['message', 'go'] as const)('invalidates the previous turn while %s refreshes its prompt', async (kind) => {
    const interrupted = createPendingCall();
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const configuration = { systemPrompt: 'current prompt', formalSpec: false };
    const resolveCurrentPromptConfiguration = vi.fn()
      .mockReturnValueOnce(configuration)
      .mockImplementationOnce(async () => {
        await refreshGate;
        return configuration;
      });
    mockCall.mockImplementationOnce(() => interrupted.promise);
    const session = createSession({ resolveCurrentPromptConfiguration });
    const abandoned = session.handleUserMessage({ text: 'first question' });
    await vi.waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1));

    mockCall.mockResolvedValueOnce({
      persona: 'interactive', status: 'done', content: 'current answer', timestamp: new Date(),
    });
    const replacement = kind === 'message'
      ? session.handleUserMessage({ text: 'second question' })
      : session.createTaskInstruction({ userNote: 'ship it' });
    interrupted.settle({
      persona: 'interactive', status: 'done', content: 'stale answer',
      sessionId: 'stale-session', timestamp: new Date(),
    });
    await abandoned;

    try {
      expect(session.snapshotHistory()).toEqual([
        { role: 'user', content: 'first question' },
        ...(kind === 'message' ? [{ role: 'user', content: 'second question' }] : []),
      ]);
      expect(mockUpdatePersonaSession).not.toHaveBeenCalled();
    } finally {
      releaseRefresh();
      await replacement;
    }
  });

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
    await vi.waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1));
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
    await vi.waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1));
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

    mockCall.mockResolvedValueOnce({
      persona: 'interactive', status: 'done', content: 'next answer', timestamp: new Date(),
    });
    await session.handleUserMessage({ text: 'next question' });
    expectUndeliveredPrompt(String(mockCall.mock.calls[2]?.[0]), ['first question'], 'next question');
    expect(session.snapshotHistory().filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'user', content: 'next question' },
    ]);
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
    const session = createSession({ sessionId: 'session-existing' });

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

describe('undelivered regular messages', () => {
  function response(content: string) {
    return { persona: 'interactive', status: 'done', content, timestamp: new Date() };
  }

  async function interrupt(session: ReturnType<typeof createSession>, text: string) {
    const controller = new AbortController();
    let settle!: (value: unknown) => void;
    mockCall.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const count = mockCall.mock.calls.length;
    const pending = session.handleUserMessage({ text, abortSignal: controller.signal });
    await vi.waitFor(() => expect(mockCall).toHaveBeenCalledTimes(count + 1));
    controller.abort();
    return { pending, settle };
  }

  it('should resend a manually entered message before the interrupted call settles', async () => {
    const session = createSession();
    const first = await interrupt(session, 'A');
    try {
      mockCall.mockResolvedValueOnce(response('answer B'));
      await session.handleUserMessage({ text: 'B' });
      expect(mockCall).toHaveBeenCalledTimes(2);
      expectUndeliveredPrompt(String(mockCall.mock.calls[1]?.[0]), ['A'], 'B');
      expect(session.snapshotHistory()).toEqual([
        { role: 'user', content: 'A' }, { role: 'user', content: 'B' },
        { role: 'assistant', content: 'answer B' },
      ]);
    } finally {
      first.settle(response('late answer A'));
      await first.pending;
    }
  });

  it.each(['late success', 'late failure'])('should preserve both messages after repeated interrupts and %s', async (outcome) => {
    const session = createSession();
    const first = await interrupt(session, 'A');
    const second = await interrupt(session, 'B');
    try {
      first.settle(outcome === 'late success' ? response('late A') : {
        ...response(''), status: 'error', error: 'aborted',
      });
      await first.pending;
      mockCall.mockResolvedValueOnce(response('answer C'));
      await session.handleUserMessage({ text: 'C' });
      expectUndeliveredPrompt(String(mockCall.mock.calls[2]?.[0]), ['A', 'B'], 'C');
      second.settle(response('late B'));
      await second.pending;
      mockCall.mockResolvedValueOnce(response('answer D'));
      await session.handleUserMessage({ text: 'D' });
      expect(mockCall.mock.calls[3]?.[0]).toBe('D');
      expect(session.snapshotHistory().filter((message) => message.role === 'user').map((message) => message.content))
        .toEqual(['A', 'B', 'C', 'D']);
      expect(session.getLatestAssistantMessage()).toBe('answer D');
    } finally {
      first.settle(response('late A'));
      second.settle(response('late B'));
      await Promise.all([first.pending, second.pending]);
    }
  });

  it('should keep identical interrupted messages as separate utterances', async () => {
    const session = createSession();
    const first = await interrupt(session, 'same');
    const second = await interrupt(session, 'same');
    try {
      mockCall.mockResolvedValueOnce(response('answer'));
      await session.handleUserMessage({ text: 'continue' });
      expectUndeliveredPrompt(String(mockCall.mock.calls[2]?.[0]), ['same', 'same'], 'continue');
    } finally {
      first.settle(response('late'));
      second.settle(response('late'));
      await Promise.all([first.pending, second.pending]);
    }
  });

  it('should send only the next message after an uninterrupted answer completes', async () => {
    mockCall.mockResolvedValue(response('answer'));
    const session = createSession();
    await session.handleUserMessage({ text: 'A' });
    await session.handleUserMessage({ text: 'B' });
    expect(mockCall.mock.calls.map((call) => call[0])).toEqual(['A', 'B']);
  });

  it.each([
    ['closed code fence', '修正対象\n```ts\nconst x = 1;\n```'],
    ['unclosed nested fences', '``````text\n```ts\nx\n~~~\ny\n~~~\n未完了'],
  ])('should quote the complete interrupted text with %s', async (_name, text) => {
    const session = createSession();
    const first = await interrupt(session, text);
    try {
      mockCall.mockResolvedValueOnce(response('answer'));
      await session.handleUserMessage({ text: '続けて' });
      expectUndeliveredPrompt(String(mockCall.mock.calls[1]?.[0]), [text], '続けて');
    } finally {
      first.settle(response('late'));
      await first.pending;
    }
  });

  it('should summarize original history on /go and retain pending messages for the next regular turn', async () => {
    const session = createSession();
    const first = await interrupt(session, 'A');
    try {
      mockCall.mockResolvedValueOnce(response('instruction'));
      const summary = await session.handleUserMessage({ text: '/go' });
      expect(summary.kind).toBe('workflow_execution_requested');
      const summaryPrompt = String(mockCall.mock.calls[1]?.[0]);
      expect(summaryPrompt).toContain('User: A');
      mockCall.mockResolvedValueOnce(response('answer C'));
      await session.handleUserMessage({ text: 'C' });
      const regularPrompt = String(mockCall.mock.calls[2]?.[0]);
      expectUndeliveredPrompt(regularPrompt, ['A'], 'C');
      const explanation = regularPrompt.slice(0, regularPrompt.indexOf('\n'));
      expect(summaryPrompt.split('\n').filter((line) => line === explanation)).toEqual([]);
      expect(mockCall).toHaveBeenCalledTimes(3);
    } finally {
      first.settle(response('late'));
      await first.pending;
    }
  });

  it('should resend command-looking text inside a message without generating an instruction', async () => {
    const text = '例を示す\n```text\n/go\n```\n説明を続ける';
    const session = createSession();
    const first = await interrupt(session, text);
    try {
      mockCall.mockResolvedValueOnce(response('answer'));
      const result = await session.handleUserMessage({ text: '続けて' });
      expect(result.kind).toBe('assistant_response');
      expect(mockCall).toHaveBeenCalledTimes(2);
      expectUndeliveredPrompt(String(mockCall.mock.calls[1]?.[0]), [text], '続けて');
    } finally {
      first.settle(response('late'));
      await first.pending;
    }
  });

  it('should retain the interrupted message while prompt configuration is still refreshing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const configuration = { systemPrompt: 'system', formalSpec: false, modelCheckTimeoutSeconds: 300 };
    const refresh = vi.fn().mockImplementationOnce(async () => { await gate; return configuration; })
      .mockReturnValue(configuration);
    const session = createSession({ resolveCurrentPromptConfiguration: refresh });
    const controller = new AbortController();
    const first = session.handleUserMessage({ text: 'A', abortSignal: controller.signal });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    controller.abort();
    try {
      mockCall.mockResolvedValue(response('answer'));
      await session.handleUserMessage({ text: 'B' });
      expectUndeliveredPrompt(String(mockCall.mock.calls[0]?.[0]), ['A'], 'B');
    } finally {
      release();
      await first;
    }
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(session.snapshotHistory().filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['A', 'B']);
  });

  it('should resolve images from the final prompt containing the interrupted message', async () => {
    const attachment = { placeholder: '[Image #1]', path: '/tmp/shot.png' };
    const resolveImageAttachments = vi.fn((prompt: string) => prompt.includes('[Image #1]') ? [attachment] : []);
    const session = createSession({ resolveImageAttachments });
    const first = await interrupt(session, 'look at [Image #1]');
    try {
      mockCall.mockResolvedValueOnce(response('answer'));
      await session.handleUserMessage({ text: 'continue' });
      expect(resolveImageAttachments.mock.calls[1]?.[0]).toContain('User: look at [Image #1]');
      expect(mockCall.mock.calls[1]?.[0]).toContain('/tmp/shot.png');
    } finally {
      first.settle(response('late'));
      await first.pending;
    }
  });

  it.each(['service unavailable', 'aborted'])('should roll back an ordinary failure named %s while retaining earlier interrupted messages', async (error) => {
    const session = createSession();
    const first = await interrupt(session, 'A');
    try {
      mockCall.mockResolvedValueOnce({ ...response(''), status: 'error', error });
      expect(await session.handleUserMessage({ text: 'B' })).toMatchObject({ kind: 'error', message: error });
      expect(session.snapshotHistory()).toEqual([{ role: 'user', content: 'A' }]);
      mockCall.mockResolvedValueOnce(response('answer'));
      await session.handleUserMessage({ text: 'C' });
      expectUndeliveredPrompt(String(mockCall.mock.calls[2]?.[0]), ['A'], 'C');
    } finally {
      first.settle(response('late'));
      await first.pending;
    }
  });

  it('should retain handoff context alongside resent instructions without duplicating original history', async () => {
    const session = createSession({ handoffHistory: [{ role: 'user', content: 'prior conversation' }] });
    const first = await interrupt(session, 'A');
    try {
      mockCall.mockResolvedValueOnce(response('answer B'));
      await session.handleUserMessage({ text: 'B' });
      const prompt = String(mockCall.mock.calls[1]?.[0]);
      expectUndeliveredPrompt(prompt, ['A'], 'B');
      expect(prompt.match(/User: prior conversation/gu)).toHaveLength(1);
      expect(session.snapshotHistory().filter((message) => message.role === 'user').map((message) => message.content))
        .toEqual(['prior conversation', 'A', 'B']);
    } finally {
      first.settle(response('late'));
      await first.pending;
    }
  });

  it('should not call the assistant again when the conversation ends after an interrupt', async () => {
    const session = createSession();
    const first = await interrupt(session, 'A');
    first.settle(response('late'));
    await first.pending;
    expect(session.snapshotHistory()).toEqual([{ role: 'user', content: 'A' }]);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });
});

describe('a turn that produces no answer', () => {
  it.each(['error', 'blocked'] as const)('should not retry formal specification generation after an existing session returns %s', async (status) => {
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status,
      content: '',
      error: `formal generation ${status}`,
      timestamp: new Date(),
    });
    const session = createSession({ sessionId: 'session-existing', formalSpec: true });

    const failed = await session.handleUserMessage({ text: '/verify' });

    expect(failed).toEqual({
      kind: 'error',
      code: 'provider_error',
      message: `formal generation ${status}`,
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      sessionId: 'session-existing',
    }));
  });

  it('should not automatically resend a failed message when interactive effort is set', async () => {
    mockCall.mockResolvedValueOnce({
      persona: 'interactive',
      status: 'error',
      content: '',
      error: 'unsupported effort',
      timestamp: new Date(),
    });
    const session = createSession({ sessionId: 'session-existing', effort: 'custom-effort' });

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
    const session = createSession({
      sessionId: 'session-existing',
      disableSessionRetry: true,
      model: 'custom-model',
    });

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
    const session = createSession({
      disableSessionRetry: true,
      model: 'custom-model',
      persistSession: false,
    });

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
    expect(notices[0]).toContain("mock");
  });
});
