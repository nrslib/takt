import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TuiConversation, TuiLocalCommand } from '../features/tui/tuiConversation.js';

const { mockMountInk } = vi.hoisted(() => ({
  mockMountInk: vi.fn(),
}));

vi.mock('../features/tui/inkMount.js', () => ({
  mountInk: (...args: unknown[]) => mockMountInk(...args),
}));

vi.mock('../features/tui/terminalColors.js', () => ({
  resolveUserMessageColors: vi.fn(async () => ({
    colors: { background: '#42454b', foreground: '#ffffff' },
  })),
}));

import { runTuiConversation } from '../features/tui/conversationRunner.js';

interface MountedConversationProps {
  readonly conversation: TuiConversation;
  readonly liveStatusReader?: () => string;
  readonly liveStatusRefreshIntervalMs?: number;
  readonly initialEntries: readonly { readonly role: string; readonly content: string }[];
  readonly onExit: (exit: unknown, carried: unknown) => void;
}

interface MountHandlers {
  readonly settle: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
}

function mountedProps(element: ReactElement): MountedConversationProps {
  const props = (element as ReactElement<MountedConversationProps>).props;
  if (props === null || typeof props !== 'object') {
    throw new Error('Conversation view props were not mounted');
  }
  return props;
}

function createConversation(): TuiConversation {
  return {
    lang: 'en',
    commandAvailability: {},
    tracksResultSource: false,
    isCommandLine: vi.fn(() => true),
    resolveLocalCommand: vi.fn((): TuiLocalCommand => ({
      kind: 'handoff',
      id: 'tell',
      text: 'skip Android support',
    })),
    submit: vi.fn(),
    createInstruction: vi.fn(),
    resumeSession: vi.fn(),
    pasteClipboardImage: vi.fn(),
    sealImages: vi.fn(),
    saveInlineImage: vi.fn(),
  };
}

describe('resident conversation handoffs', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the same conversation after /tell returns without sending', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-tell-handoff-'));
    const conversation = createConversation();
    const liveStatusReader = vi.fn(() => "run: running");
    const mounted: MountedConversationProps[] = [];
    let mountCount = 0;
    mockMountInk.mockImplementation(async (buildTree: (handlers: MountHandlers) => ReactElement) => {
      mountCount += 1;
      return new Promise<unknown>((resolve, reject) => {
        const props = mountedProps(buildTree({ settle: resolve, fail: reject }));
        mounted.push(props);
        if (mountCount === 1) {
          props.onExit(
            { kind: 'handoff', id: 'tell', text: 'skip Android support' },
            { history: ['prior question'], queue: [] },
          );
          return;
        }
        props.onExit(
          { kind: 'result', result: { action: 'cancel', task: '' } },
          { history: ['prior question'], queue: [] },
        );
      });
    });
    const onHandoff = vi.fn(async (id: string, text: string) => {
      expect(id).toBe('tell');
      expect(text).toBe('skip Android support');
      return { kind: 'continue' as const, notice: 'The instruction was not sent.' };
    });

    try {
      const result = await runTuiConversation({
        cwd,
        lang: 'en',
        conversation,
        initialEntries: [],
        submitMode: 'chat',
        autoSubmit: false,
        modelLabel: () => 'mock/mock-model',
        chooseAction: async () => ({ action: 'continue', task: '' }),
        continuePrompt: 'continue',
        onHandoff,
        liveStatusReader,
        liveStatusRefreshIntervalMs: 250,
      });

      expect(result).toEqual({ action: 'cancel', task: '' });
      expect(onHandoff).toHaveBeenCalledOnce();
      expect(mounted).toHaveLength(2);
      expect(mounted[1]?.conversation).toBe(conversation);
      for (const props of mounted) {
        expect(props.liveStatusReader).toBe(liveStatusReader);
        expect(props.liveStatusRefreshIntervalMs).toBe(250);
      }
      expect(mounted[1]?.initialEntries).toEqual([{
        role: 'system',
        content: 'The instruction was not sent.',
      }]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
