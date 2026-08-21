/**
 * The exec conversation as the TUI consumes it: exec's own commands become
 * hand-offs, a plain line is one assistant turn, and the run keeps the
 * transcript it later summarizes.
 */

import { describe, expect, it, vi } from 'vitest';

const { mockAskExecAssistant } = vi.hoisted(() => ({ mockAskExecAssistant: vi.fn() }));

vi.mock('../features/exec/assistantSession.js', () => ({
  askExecAssistant: (...args: unknown[]) => mockAskExecAssistant(...args),
}));

import {
  createExecTuiConversation,
  EXEC_GO_HANDOFF,
  EXEC_SETUP_HANDOFF,
} from '../features/exec/tuiConversation.js';

function createConversation(overrides: Record<string, unknown> = {}) {
  const turns: unknown[] = [];
  const goTexts: string[] = [];
  const conversation = createExecTuiConversation({
    cwd: '/repo',
    attachmentStore: {
      saveImage: vi.fn(),
      listAttachments: () => [],
      cleanup: vi.fn(),
      seal: vi.fn(),
    },
    session: () => ({ lang: 'en', sessionId: 'session-1' }) as never,
    systemPrompt: () => 'clarify prompt',
    onTurn: (turn, sessionId) => turns.push({ turn, sessionId }),
    onGoText: (text) => goTexts.push(text),
    ...overrides,
  });
  return { conversation, turns, goTexts };
}

describe('exec conversation on the TUI', () => {
  it('should hand the terminal over for /setup', () => {
    const { conversation } = createConversation();

    expect(conversation.resolveLocalCommand('/setup'))
      .toEqual({ kind: 'handoff', id: EXEC_SETUP_HANDOFF });
  });

  it('should hand the terminal over for /go and keep the text typed with it', () => {
    const { conversation, goTexts } = createConversation();

    expect(conversation.resolveLocalCommand('/go ship it'))
      .toEqual({ kind: 'handoff', id: EXEC_GO_HANDOFF });
    expect(goTexts).toEqual(['ship it']);
  });

  it('should offer exec commands only', () => {
    const { conversation } = createConversation();

    expect(conversation.resolveLocalCommand('/cancel')).toEqual({ kind: 'cancel' });
    expect(conversation.resolveLocalCommand('/paste-image')).toEqual({ kind: 'paste_image' });
    // Not part of exec's command set, so it is ordinary text.
    expect(conversation.resolveLocalCommand('/resume')).toBeNull();
    expect(conversation.commandAvailability)
      .toEqual({ enableRetryCommand: false, hasPreviousOrder: false });
  });

  it('should treat a line that only looks like a command as text', () => {
    const { conversation } = createConversation();

    expect(conversation.isCommandLine('/setup')).toBe(true);
    expect(conversation.isCommandLine('/go ship it')).toBe(true);
    // Not part of exec's command set, and not a command at all.
    expect(conversation.isCommandLine('/resume')).toBe(false);
    expect(conversation.isCommandLine('/usr/local/bin is missing')).toBe(false);
  });

  it('should report the reason a failed call gave, not a generic sentence', async () => {
    mockAskExecAssistant.mockRejectedValue(new Error('opencode server did not start'));
    const { conversation } = createConversation();

    const submission = await conversation.submit({
      text: 'build a cli',
      abortSignal: new AbortController().signal,
      onAssistantChunk: vi.fn(),
    });

    expect(submission).toMatchObject({ kind: 'error', message: 'opencode server did not start' });
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

  it('should leave the run untouched when the view drops an answered turn', async () => {
    mockAskExecAssistant.mockResolvedValue({ content: 'too late', sessionId: 'session-late' });
    const { conversation, turns } = createConversation();

    // The provider ignored the abort and answered anyway; the view interrupted
    // this turn, so it never commits it.
    await conversation.submit({
      text: 'build a cli',
      abortSignal: new AbortController().signal,
      onAssistantChunk: vi.fn(),
    });

    expect(turns).toEqual([]);
  });

  it('should report a failed turn as a notice instead of ending the run', async () => {
    mockAskExecAssistant.mockRejectedValue(new Error('provider exploded'));
    const { conversation, turns } = createConversation();

    const submission = await conversation.submit({
      text: 'build a cli',
      abortSignal: new AbortController().signal,
      onAssistantChunk: vi.fn(),
    });

    expect(submission).toMatchObject({ kind: 'error', message: 'provider exploded' });
    expect(turns).toEqual([]);
  });
});
