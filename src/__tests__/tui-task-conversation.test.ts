/**
 * The retry and instruct conversations on the TUI: the mode's own action
 * selector is what decides, and `/retry` / `/replay` are gated exactly as the
 * readline loop gates them.
 */

import { describe, expect, it, vi } from 'vitest';
import { SlashCommand } from '../shared/constants.js';

const { mockRunTuiConversation, mockCreateTuiConversation, sessionStoreCalls } = vi.hoisted(() => ({
  mockRunTuiConversation: vi.fn(),
  mockCreateTuiConversation: vi.fn(),
  sessionStoreCalls: [] as unknown[][],
}));

vi.mock('../features/tui/conversationRunner.js', () => ({
  runTuiConversation: (...args: unknown[]) => mockRunTuiConversation(...args),
}));

vi.mock('../features/tui/tuiConversation.js', () => ({
  createTuiConversation: (...args: unknown[]) => mockCreateTuiConversation(...args),
}));

vi.mock('../features/interactive/imageAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/interactive/imageAttachments.js')>();
  return {
    ...actual,
    createSessionImageAttachmentStore: (...args: unknown[]) => {
      sessionStoreCalls.push(args);
      return {
        saveImage: vi.fn(),
        listAttachments: () => [],
        cleanup: vi.fn(),
        seal: vi.fn(),
      };
    },
  };
});

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
      chooseAction: (
      task: string,
      source?: string,
    ) => Promise<{ action: string; task: string } | null>;
      submitMode: string;
      autoSubmit: boolean;
    }) => {
      expect(options.initialEntries).toEqual([
        { role: 'system', content: 'Retry mode - describe additional instructions.' },
      ]);
      expect(options.submitMode).toBe('chat');
      expect(options.autoSubmit).toBe(false);
      // The mode's own selector decides, not the workflow one.
      expect(await options.chooseAction('proposed task'))
        .toEqual({ action: 'save_task', task: 'proposed task' });
      return { action: 'save_task', task: 'proposed task' };
    });

    const result = await runTuiTaskConversation({
      cwd: '/repo',
      plan: createPlan({ selectAction }),
    });

    expect(result).toMatchObject({ action: 'save_task', task: 'proposed task' });
    expect(selectAction).toHaveBeenCalledWith('proposed task', 'en');
  });

  it('should revise the order with the mode selector when the task came from /go', async () => {
    const selectGoAction = vi.fn().mockResolvedValue('execute');
    const selectRetryAction = vi.fn().mockResolvedValue('execute');
    const selectAction = vi.fn().mockResolvedValue('save_task');
    const normalizeSummaryTask = vi.fn((task: string) => ({
      task: `${task}\n\n## Attachments`,
      attachments: [],
    }));
    mockRunTuiConversation.mockImplementation(async (options: {
      chooseAction: (
        task: string,
        source?: string,
      ) => Promise<{ action: string; task: string } | null>;
    }) => {
      // A `/go` draft is confirmed with the approve/reject selector, and what it
      // shows is the draft with its attachment list already appended.
      expect(await options.chooseAction('revised order', 'go')).toEqual({
        action: 'execute',
        task: 'revised order\n\n## Attachments',
      });
      expect(selectGoAction).toHaveBeenCalledWith('revised order\n\n## Attachments', 'en');
      expect(selectAction).not.toHaveBeenCalled();

      // `/retry` resubmits the order the mode already has, unnormalized.
      expect(await options.chooseAction('previous order', 'retry'))
        .toEqual({ action: 'execute', task: 'previous order' });
      expect(selectRetryAction).toHaveBeenCalledWith('previous order', 'en');
      expect(normalizeSummaryTask).toHaveBeenCalledTimes(1);

      // Anything else keeps the mode's plain selector.
      expect(await options.chooseAction('some task'))
        .toEqual({ action: 'save_task', task: 'some task' });
      return { action: 'cancel', task: '' };
    });

    await runTuiTaskConversation({
      cwd: '/repo',
      plan: createPlan({
        selectAction,
        selectGoAction,
        selectRetryAction,
        normalizeSummaryTask,
      }),
    });
  });

  it('should number pasted images past the ones the canonical order already has', async () => {
    sessionStoreCalls.length = 0;
    mockRunTuiConversation.mockResolvedValue({ action: 'cancel', task: '' });

    await runTuiTaskConversation({
      cwd: '/repo',
      plan: createPlan({ initialImageAttachmentIndex: 3 }),
    });

    expect(sessionStoreCalls.at(-1)).toEqual(['/repo', undefined, 3]);
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
