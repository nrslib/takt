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
  });
  return { conversation, turns };
}

describe('exec conversation on the TUI', () => {
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

  it('should leave the run untouched when an interrupted turn answers anyway', async () => {
    mockAskExecAssistant.mockResolvedValue({ content: 'too late', sessionId: 'session-late' });
    const { conversation, turns } = createConversation();
    const controller = new AbortController();
    controller.abort();

    // The provider ignored the abort and answered; the view drops such a turn,
    // so it never commits it and the run's transcript stays as it was.
    await conversation.submit({
      text: 'build a cli',
      abortSignal: controller.signal,
      onAssistantChunk: vi.fn(),
    });

    expect(turns).toEqual([]);
  });
});
