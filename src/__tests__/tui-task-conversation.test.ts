/**
 * The retry and instruct conversations on the TUI: the mode's own action
 * selector is what decides, and `/retry` / `/replay` are gated exactly as the
 * readline loop gates them.
 */

import { describe, expect, it, vi } from 'vitest';
import { SlashCommand } from '../shared/constants.js';

const { mockRunTuiConversation, mockCreateTuiConversation } = vi.hoisted(() => ({
  mockRunTuiConversation: vi.fn(),
  mockCreateTuiConversation: vi.fn(),
}));

vi.mock('../features/tui/conversationRunner.js', () => ({
  runTuiConversation: (...args: unknown[]) => mockRunTuiConversation(...args),
}));

vi.mock('../features/tui/tuiConversation.js', () => ({
  createTuiConversation: (...args: unknown[]) => mockCreateTuiConversation(...args),
}));

import { runTuiTaskConversation } from '../features/tui/runTuiTask.js';

function createPlan(strategy: Record<string, unknown>) {
  return {
    ctx: {
      provider: { setup: vi.fn(), getRuntimeInstructions: vi.fn(() => null) },
      providerType: 'mock',
      model: 'mock-model',
      lang: 'en' as const,
      personaName: 'retry',
      sessionId: undefined,
    },
    strategy: {
      systemPrompt: 'system',
      allowedTools: [],
      transformPrompt: (message: string) => message,
      introMessage: 'Retry mode - describe additional instructions.',
      ...strategy,
    },
  } as never;
}

describe('runTuiTaskConversation', () => {
  it('should open with the intro and use the mode selector for a finished summary', async () => {
    const selectAction = vi.fn().mockResolvedValue('save_task');
    mockRunTuiConversation.mockImplementation(async (options: {
      initialEntries: { role: string; content: string }[];
      chooseAction: (task: string) => Promise<string | null>;
      submitMode: string;
      autoSubmit: boolean;
    }) => {
      expect(options.initialEntries).toEqual([
        { role: 'system', content: 'Retry mode - describe additional instructions.' },
      ]);
      expect(options.submitMode).toBe('chat');
      expect(options.autoSubmit).toBe(false);
      // The mode's own selector decides, not the workflow one.
      expect(await options.chooseAction('proposed task')).toBe('save_task');
      return { action: 'save_task', task: 'proposed task' };
    });

    const result = await runTuiTaskConversation({
      cwd: '/repo',
      plan: createPlan({ selectAction }),
    });

    expect(result).toMatchObject({ action: 'save_task', task: 'proposed task' });
    expect(selectAction).toHaveBeenCalledWith('proposed task', 'en');
  });

  it('should hand the model of the session to the status row', async () => {
    mockRunTuiConversation.mockImplementation(async (options: { modelLabel: () => string }) => {
      // Read per mount, so a session swapped mid-run is reflected.
      expect(options.modelLabel()).toBe('Model: mock/mock-model');
      return { action: 'cancel', task: '' };
    });

    await runTuiTaskConversation({ cwd: '/repo', plan: createPlan({}) });
  });
});

describe('retry and replay availability', () => {
  /** Builds the real conversation so its command gating can be exercised. */
  async function resolveCommand(
    strategy: Record<string, unknown>,
    text: string,
  ): Promise<unknown> {
    vi.resetModules();
    vi.doUnmock('../features/tui/tuiConversation.js');
    const { createTuiConversation } = await vi.importActual<
      typeof import('../features/tui/tuiConversation.js')
    >('../features/tui/tuiConversation.js');
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: createPlan(strategy),
      attachmentStore: {
        saveImage: vi.fn(),
        listAttachments: () => [],
        cleanup: vi.fn(),
        seal: vi.fn(),
      },
    });
    return { command: conversation.resolveLocalCommand(text), conversation };
  }

  it('should offer /retry only where the mode enabled it', async () => {
    const enabled = await resolveCommand(
      { enableRetryCommand: true, previousOrderContent: 'previous order' },
      SlashCommand.Retry,
    ) as { command: unknown; conversation: { commandAvailability: unknown } };
    // `/retry` puts the previous order through the action selector.
    expect(enabled.command).toEqual({ kind: 'choose_action', task: 'previous order' });
    expect(enabled.conversation.commandAvailability)
      .toEqual({ enableRetryCommand: true, hasPreviousOrder: true });

    const withoutOrder = await resolveCommand({ enableRetryCommand: true }, SlashCommand.Retry);
    expect(withoutOrder).toMatchObject({ command: { kind: 'notice' } });

    const disabled = await resolveCommand({ previousOrderContent: 'previous order' }, SlashCommand.Retry);
    expect(disabled).toMatchObject({ command: { kind: 'notice' } });
  });

  it('should run /replay without asking when an order exists', async () => {
    const withOrder = await resolveCommand(
      { previousOrderContent: 'previous order' },
      SlashCommand.Replay,
    );
    expect(withOrder).toMatchObject({ command: { kind: 'execute', task: 'previous order' } });

    const withoutOrder = await resolveCommand({}, SlashCommand.Replay);
    expect(withoutOrder).toMatchObject({ command: { kind: 'notice' } });
  });
});
