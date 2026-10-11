/**
 * The exec conversation as the TUI consumes it: exec's own commands become
 * hand-offs, a plain line is one assistant turn, and the run keeps the
 * transcript it later summarizes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectUndeliveredPrompt } from './helpers/undelivered.js';

const { mockAskExecAssistant } = vi.hoisted(() => ({ mockAskExecAssistant: vi.fn() }));

vi.mock('../features/exec/assistantSession.js', () => ({
  askExecAssistant: (...args: unknown[]) => mockAskExecAssistant(...args),
}));

import type { ConversationMessage } from '../features/interactive/interactive.js';
import type { ExecSessionContext } from '../features/exec/assistantSession.js';
import { makeSessionContext } from './test-helpers.js';
import {
  createExecTuiConversation,
  EXEC_GO_HANDOFF,
  EXEC_SETUP_HANDOFF,
} from '../features/exec/tuiConversation.js';

interface RecordedTurn {
  readonly turn: readonly ConversationMessage[];
  readonly sessionId: string | undefined;
}

function createSession(): ExecSessionContext {
  return {
    ...makeSessionContext({ sessionId: 'session-1', personaName: 'exec' }),
    facetLookupConfig: { enableBuiltinWorkflows: true, language: 'en' },
    codexSkillInheritance: { repo: false, user: false },
  };
}

function createConversation() {
  const turns: RecordedTurn[] = [];
  const interruptedMessages: string[] = [];
  const conversation = createExecTuiConversation({
    cwd: '/repo',
    attachmentStore: {
      saveImage: vi.fn(),
      listAttachments: () => [],
      cleanup: vi.fn(),
      seal: vi.fn(),
    },
    session: createSession,
    systemPrompt: () => 'clarify prompt',
    onTurn: (turn, sessionId) => turns.push({ turn, sessionId }),
    onInterruptedMessage: (content) => interruptedMessages.push(content),
  });
  return { conversation, turns, interruptedMessages };
}

describe('exec conversation on the TUI', () => {
  beforeEach(() => {
    mockAskExecAssistant.mockReset();
  });

  it('should carry interrupted messages in order until an accepted answer completes', async () => {
    const { conversation, turns, interruptedMessages } = createConversation();
    const controllers = [new AbortController(), new AbortController()];
    const pending: Promise<unknown>[] = [];
    const settle: Array<(value: { content: string; sessionId: string }) => void> = [];
    try {
      for (const [index, text] of ['A', 'B'].entries()) {
        mockAskExecAssistant.mockImplementationOnce(() => new Promise((resolve) => { settle.push(resolve); }));
        const controller = controllers[index]!;
        pending.push(conversation.submit({ text, abortSignal: controller.signal, onAssistantChunk: vi.fn() }));
        await vi.waitFor(() => expect(mockAskExecAssistant).toHaveBeenCalledTimes(index + 1));
        controller.abort();
      }
      mockAskExecAssistant.mockResolvedValueOnce({ content: 'answer C', sessionId: 'session-C' });
      const accepted = await conversation.submit({
        text: 'C', abortSignal: new AbortController().signal, onAssistantChunk: vi.fn(),
      });
      expectUndeliveredPrompt(String(mockAskExecAssistant.mock.calls[2]?.[2]), ['A', 'B'], 'C');
      expect(turns).toEqual([]);
      accepted.commit?.();
      expect(interruptedMessages).toEqual(['A', 'B']);
      expect(turns).toEqual([{
        turn: [{ role: 'user', content: 'C' }, { role: 'assistant', content: 'answer C' }],
        sessionId: 'session-C',
      }]);
      expect(turns.flatMap(({ turn }) => turn).filter((message) => message.role === 'assistant'))
        .toEqual([{ role: 'assistant', content: 'answer C' }]);
      settle.forEach((resolve) => resolve({ content: 'late answer', sessionId: 'stale-session' }));
      await Promise.all(pending);
      expect(turns.flatMap(({ turn }) => turn).filter((message) => message.role === 'user'))
        .toEqual([{ role: 'user', content: 'C' }]);
      mockAskExecAssistant.mockResolvedValueOnce({ content: 'answer D', sessionId: 'session-D' });
      await conversation.submit({ text: 'D', abortSignal: new AbortController().signal, onAssistantChunk: vi.fn() });
      expect(mockAskExecAssistant.mock.calls[3]?.[2]).toBe('D');
    } finally {
      settle.forEach((resolve) => resolve({ content: 'late answer', sessionId: 'stale-session' }));
      await Promise.all(pending);
    }
  });

  it('should hand the terminal over for /setup', () => {
    const { conversation } = createConversation();

    expect(conversation.resolveLocalCommand('/setup'))
      .toEqual({ kind: 'handoff', id: EXEC_SETUP_HANDOFF });
  });

  it('should hand the terminal over for /go and carry the text typed with it', () => {
    const { conversation } = createConversation();

    // The text travels with the hand-off rather than through a side effect: the
    // queue resolves a command once to see whether it can wait and again when it
    // runs, and the run must be told what was typed exactly once.
    expect(conversation.resolveLocalCommand('/go ship it'))
      .toEqual({ kind: 'handoff', id: EXEC_GO_HANDOFF, text: 'ship it' });
    expect(conversation.resolveLocalCommand('/go ship it'))
      .toEqual({ kind: 'handoff', id: EXEC_GO_HANDOFF, text: 'ship it' });
  });

  it('should offer exec commands only', () => {
    const { conversation } = createConversation();

    expect(conversation.resolveLocalCommand('/cancel')).toEqual({ kind: 'cancel' });
    expect(conversation.resolveLocalCommand('/paste-image')).toEqual({ kind: 'paste_image' });
    // Not part of exec's command set, so it is ordinary text.
    expect(conversation.resolveLocalCommand('/resume')).toBeNull();
    expect(conversation.resolveLocalCommand('/issue #456')).toBeNull();
    // Exec's own set, so the completion list offers `/setup` and nothing the
    // conversation would refuse to run.
    expect(conversation.commandAvailability).toEqual({
      enableSetupCommand: true,
      enabledCommands: ['/setup', '/go', '/cancel', '/paste-image'],
    });
  });

  it('should treat a line that only looks like a command as text', () => {
    const { conversation } = createConversation();

    expect(conversation.isCommandLine('/setup')).toBe(true);
    expect(conversation.isCommandLine('/go ship it')).toBe(true);
    // Not part of exec's command set, and not a command at all.
    expect(conversation.isCommandLine('/resume')).toBe(false);
    expect(conversation.isCommandLine('/issue #456')).toBe(false);
    expect(conversation.isCommandLine('/usr/local/bin is missing')).toBe(false);
  });

  it('should report the reason a failed call gave and keep the run going', async () => {
    mockAskExecAssistant.mockRejectedValue(new Error('opencode server did not start'));
    const { conversation, turns } = createConversation();

    const submission = await conversation.submit({
      text: 'build a cli',
      abortSignal: new AbortController().signal,
      onAssistantChunk: vi.fn(),
    });

    // The provider's own words, not a generic sentence, and nothing on record:
    // the conversation carries on from where it was.
    expect(submission).toMatchObject({ kind: 'error', message: 'opencode server did not start' });
    expect(turns).toEqual([]);
  });

  it('should record the turn and the session only when the view commits it', async () => {
    mockAskExecAssistant.mockResolvedValue({ content: 'an answer', sessionId: 'session-2' });
    const { conversation, turns } = createConversation();

    const controller = new AbortController();
    const submission = await conversation.submit({
      text: '  build a cli  ',
      abortSignal: controller.signal,
      onAssistantChunk: vi.fn(),
    });

    expect(submission).toMatchObject({ kind: 'assistant_response', content: 'an answer' });
    expect(mockAskExecAssistant).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ lang: 'en' }),
      'build a cli',
      'clarify prompt',
      // Ink owns the terminal, so the turn runs silent and streams into the view.
      expect.objectContaining({
        abortSignal: controller.signal,
        outputMode: 'silent',
        onStream: expect.any(Function),
        onNotice: expect.any(Function),
      }),
    );
    // Nothing is on record yet: the view decides whether this turn still counts.
    expect(turns).toEqual([]);

    submission.commit?.();

    expect(turns).toEqual([{
      turn: [
        { role: 'user', content: 'build a cli' },
        { role: 'assistant', content: 'an answer' },
      ],
      sessionId: 'session-2',
    }]);
  });

  it('should retain only the original message when an interrupted turn answers anyway', async () => {
    mockAskExecAssistant.mockResolvedValue({ content: 'too late', sessionId: 'session-late' });
    const { conversation, turns, interruptedMessages } = createConversation();
    const controller = new AbortController();
    controller.abort();

    const submission = await conversation.submit({
      text: 'build a cli',
      abortSignal: controller.signal,
      onAssistantChunk: vi.fn(),
    });

    submission.commit?.();
    expect(interruptedMessages).toEqual(['build a cli']);
    expect(turns).toEqual([]);
  });
});
