import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationView,
  type ConversationExit,
  type ConversationUiText,
} from '../features/tui/ConversationView.js';
import type { InteractiveModeResult } from '../features/interactive/interactive.js';
import type { PastedImage } from '../features/interactive/inlineImagePaste.js';
import type { TranscriptEntry } from '../features/tui/TranscriptEntryView.js';
import type {
  TuiConversation,
  TuiLocalCommand,
  TuiSubmission,
  TuiSubmitInput,
} from '../features/tui/tuiConversation.js';
import { getLabel } from '../shared/i18n/index.js';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupImageAttachmentStore,
  createImageAttachmentStore,
} from '../features/interactive/imageAttachments.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ENTER = '\r';
const ALT_ENTER = '\x1b\r';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
/** Ink delivers Ctrl+J as a bare line feed with no key flags. */
const CTRL_J = '\n';
const BACKSPACE = '\x7f';
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_LEFT = '\x1b[D';
const ARROW_RIGHT = '\x1b[C';
const TAB = '\t';
/** Raw Ctrl+V; Ink reports it as `key.ctrl` with the input `'v'`. */
const CTRL_V = '\x16';
/** Raw Ctrl+K, the readline gesture for cutting to the end of the line. */
const CTRL_K = '\x0b';

/** The store hands `/paste-image` a placeholder in this exact shape. */
const PASTED_IMAGE_PLACEHOLDER = '[Image #1]';

/** PNG magic bytes: the paste parser infers the mime type from the data. */
const INLINE_IMAGE_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** What a terminal writes onto stdin when a screenshot is pasted. */
const INLINE_IMAGE_PASTE = `\x1b]1337;File=inline=1;name=shot.png;size=${INLINE_IMAGE_DATA.length}:${INLINE_IMAGE_DATA.toString('base64')}\x07`;

const UI: ConversationUiText = {
  queuedHint: getLabel('tui.ui.queuedHint', 'en'),
  queuedMore: getLabel('tui.ui.queuedMore', 'en'),
  thinking: getLabel('tui.ui.thinking', 'en'),
  hint: getLabel('tui.ui.hint', 'en'),
  placeholder: getLabel('tui.ui.placeholder', 'en'),
};

/** What the orchestrator formats from the session's resolved provider/model. */
const MODEL_LABEL = 'Model: mock/mock-fast';

const INITIAL_ENTRIES: readonly TranscriptEntry[] = [
  { role: 'system', content: 'Interactive mode - describe your task.' },
  { role: 'user', content: 'seeded task' },
];

const NO_LOCAL_COMMANDS: ReadonlyMap<string, TuiLocalCommand> = new Map();

type CommandAvailability = TuiConversation['commandAvailability'];

/** A plain run: no `takt list` retry, no previous `order.md`. */
const NO_ORDER_COMMANDS: CommandAvailability = {
  enableRetryCommand: false,
  hasPreviousOrder: false,
};

function flushFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

interface ScriptedConversation extends TuiConversation {
  readonly submitCalls: readonly TuiSubmitInput[];
  readonly instructionCalls: readonly TuiSubmitInput[];
  readonly resumedSessions: readonly string[];
  readonly sealCalls: readonly boolean[];
  readonly savedImages: readonly PastedImage[];
  resolveWith(submission: TuiSubmission): void;
  rejectWith(error: Error): void;
}

/**
 * Conversation double whose submission stays pending until the test settles it,
 * so mid-flight interrupts, rejections and an unresponsive provider (never
 * settled) are all observable.
 */
function createScriptedConversation(
  localCommands: ReadonlyMap<string, TuiLocalCommand>,
  commandAvailability: CommandAvailability,
): ScriptedConversation {
  const submitCalls: TuiSubmitInput[] = [];
  const instructionCalls: TuiSubmitInput[] = [];
  const resumedSessions: string[] = [];
  const sealCalls: boolean[] = [];
  const savedImages: PastedImage[] = [];
  let settleSubmission: ((submission: TuiSubmission) => void) | null = null;
  let failSubmission: ((error: Error) => void) | null = null;

  function recordAndHold(
    calls: TuiSubmitInput[],
    input: TuiSubmitInput,
  ): Promise<TuiSubmission> {
    calls.push(input);
    return new Promise<TuiSubmission>((resolve, reject) => {
      settleSubmission = resolve;
      failSubmission = reject;
    });
  }

  return {
    lang: 'en',
    commandAvailability,
    submitCalls,
    instructionCalls,
    resumedSessions,
    sealCalls,
    savedImages,

    sealImages(): void {
      sealCalls.push(true);
    },

    resolveLocalCommand(text: string): TuiLocalCommand | null {
      const command = localCommands.get(text.trim());
      return command === undefined ? null : command;
    },
    submit(input: TuiSubmitInput): Promise<TuiSubmission> {
      return recordAndHold(submitCalls, input);
    },
    createInstruction(input: TuiSubmitInput): Promise<TuiSubmission> {
      return recordAndHold(instructionCalls, input);
    },
    resumeSession(sessionId: string): void {
      resumedSessions.push(sessionId);
    },
    pasteClipboardImage(): Promise<string> {
      return Promise.resolve(PASTED_IMAGE_PLACEHOLDER);
    },
    saveInlineImage(image: PastedImage): Promise<string> {
      savedImages.push(image);
      return Promise.resolve(PASTED_IMAGE_PLACEHOLDER);
    },

    resolveWith(submission: TuiSubmission): void {
      if (!settleSubmission) {
        throw new Error('no submission in flight');
      }
      settleSubmission(submission);
    },
    rejectWith(error: Error): void {
      if (!failSubmission) {
        throw new Error('no submission in flight');
      }
      failSubmission(error);
    },
  };
}

interface RenderOverrides {
  readonly autoSubmit?: boolean;
  readonly initialHistory?: readonly string[];
  readonly modelLabel?: string;
}

function renderConversation(
  conversation: TuiConversation,
  submitMode: 'chat' | 'summarize',
  onExit: (exit: ConversationExit) => void,
  overrides: RenderOverrides = {},
) {
  return render(
    <ConversationView
      ui={UI}
      lang="en"
      conversation={conversation}
      initialEntries={INITIAL_ENTRIES}
      submitMode={submitMode}
      autoSubmit={overrides.autoSubmit ?? false}
      initialHistory={overrides.initialHistory ?? []}
      modelLabel={overrides.modelLabel ?? MODEL_LABEL}
      onExit={onExit}
    />,
  );
}

describe('ConversationView', () => {
  it('should commit the resume command and exit so the picker can run', async () => {
    const onExit = vi.fn();
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([['/resume', { kind: 'resume_session' }]]),
      NO_ORDER_COMMANDS,
    );
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/resume');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    // The command is consumed here, so the history the next mount starts from
    // carries it and the draft it starts with is empty.
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ kind: 'resume_session' }, ['/resume']);
    app.unmount();

    const resumed = renderConversation(conversation, 'chat', vi.fn(), {
      initialHistory: ['/resume'],
    });
    await flushFrames();
    expect(resumed.lastFrame() ?? '').toContain(UI.placeholder);

    resumed.stdin.write(ARROW_UP);
    await flushFrames();
    const frame = resumed.lastFrame() ?? '';
    expect(frame).not.toContain(UI.placeholder);
    expect(frame).toContain('/resume');

    resumed.unmount();
  });

  it('should keep the image store open across a hand-off and seal on the last exit', async () => {
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([['/resume', { kind: 'resume_session' }]]),
      NO_ORDER_COMMANDS,
    );
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/resume');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    // The selector runs next and this view is mounted again on the same store.
    expect(conversation.sealCalls).toEqual([]);

    app.unmount();
    await flushFrames();
    expect(conversation.sealCalls, 'a hand-off unmount must not seal').toEqual([]);

    // The next mount can still paste, because nothing was sealed.
    const resumed = renderConversation(conversation, 'chat', vi.fn(), {
      initialHistory: ['/resume'],
    });
    await flushFrames();
    resumed.stdin.write(INLINE_IMAGE_PASTE);
    await flushFrames();
    expect(conversation.savedImages).toHaveLength(1);

    // Ending the run is what seals it.
    resumed.stdin.write(CTRL_C);
    await flushFrames();
    expect(conversation.sealCalls.length).toBeGreaterThan(0);

    resumed.unmount();
  });

  it('should leave a real store usable after a hand-off unmount', async () => {
    // The store the orchestrator owns, wired exactly as the run wires it.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'takt-cv-handoff-'));
    const store = createImageAttachmentStore({ tmpRoot, sessionId: 'session-1' });
    const conversation = {
      ...createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/resume', { kind: 'resume_session' }]]),
        NO_ORDER_COMMANDS,
      ),
      sealImages: () => store.seal(),
    };
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('/resume');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    app.unmount();
    await flushFrames();

    // A paste after the hand-off still reaches disk.
    const attachment = await store.saveImage(PNG_BYTES, 'image/png');
    expect(existsSync(attachment.tempPath)).toBe(true);

    cleanupImageAttachmentStore(store);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('should submit on Enter pressed right after a lone OSC opener', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    // Ink reports a stripped-ESC opener as a lone ']', which starts a hold.
    app.stdin.write(']');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    // The held opener is typed and the Enter still submits.
    expect(conversation.submitCalls).toHaveLength(1);
    expect(conversation.submitCalls[0]?.text).toBe('hi]');

    app.unmount();
  });

  it('should insert a newline on Ctrl+J pressed right after a lone OSC opener', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(']');
    await flushFrames();
    app.stdin.write(CTRL_J);
    await flushFrames();
    app.stdin.write('there');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls[0]?.text).toBe('hi]\nthere');

    app.unmount();
  });

  it('should move across a ZWJ emoji in one press', async () => {
    const family = '👨\u200D👩\u200D👧';
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write(`a${family}b`);
    await flushFrames();
    // One press crosses the whole cluster, so the caret is now right after 'a'.
    app.stdin.write(ARROW_LEFT);
    await flushFrames();
    app.stdin.write(ARROW_LEFT);
    await flushFrames();
    app.stdin.write('X');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls[0]?.text).toBe(`aX${family}b`);

    app.unmount();
  });

  it('should delete a ZWJ emoji with one backspace', async () => {
    const family = '👨\u200D👩\u200D👧';
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write(`a${family}b`);
    await flushFrames();
    app.stdin.write(ARROW_LEFT);
    await flushFrames();
    // The caret sits between the cluster and 'b'; one backspace takes it all.
    app.stdin.write(BACKSPACE);
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls[0]?.text).toBe('ab');

    app.unmount();
  });

  it('should sanitize the model row before drawing it', async () => {
    const app = renderConversation(
      createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      'chat',
      vi.fn(),
      { modelLabel: 'Model: mock/\u001b[31mred\nsecond line' },
    );
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Model: mock/red second line');
    expect(frame).not.toContain('\u001b[31m');

    app.unmount();
  });

  it('should show the session model under the prompt', async () => {
    const app = renderConversation(
      createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      'chat',
      vi.fn(),
    );
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain(MODEL_LABEL);
    // One row of its own, below the key hints.
    const rows = frame.split('\n');
    const hintRow = rows.findIndex((row) => row.includes('Enter: send'));
    const modelRow = rows.findIndex((row) => row.includes(MODEL_LABEL));
    expect(modelRow).toBe(hintRow + 1);

    app.unmount();
  });

  it('should wrap a long draft inside the box instead of cutting it off', async () => {
    const app = renderConversation(
      createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      'chat',
      vi.fn(),
    );
    await flushFrames();

    // Longer than the test terminal is wide, so it can only fit by wrapping.
    const draft = `${'ab '.repeat(60)}END`;
    app.stdin.write(draft);
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    // Every typed character survived, and the tail is on screen rather than cut.
    expect((frame.match(/ab /g) ?? []).length).toBe(60);
    expect(frame).toContain('END');
    // The box grew downwards; no row runs past the terminal width.
    const boxRows = frame.split('\n').filter((row) => row.startsWith('│'));
    expect(boxRows.length).toBeGreaterThan(1);
    for (const row of boxRows) {
      expect(row.length).toBeLessThanOrEqual(100);
    }

    app.unmount();
  });

  it('should walk the lines of a multi-line draft before reaching the history', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('first line');
    await flushFrames();
    app.stdin.write(ALT_ENTER);
    await flushFrames();
    app.stdin.write('second line');
    await flushFrames();

    // Up lands on the line above, clamped to its end, so the typed mark shows
    // where the caret actually went.
    app.stdin.write(ARROW_UP);
    await flushFrames();
    app.stdin.write('!');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls[0]?.text).toBe('first line!\nsecond line');

    app.unmount();
  });

  it('should reach the history from the first line of a multi-line draft', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('remembered');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    conversation.resolveWith({ kind: 'assistant_response', content: 'ok' });
    await flushFrames();

    app.stdin.write('top');
    await flushFrames();
    app.stdin.write(ALT_ENTER);
    await flushFrames();
    app.stdin.write('bottom');
    await flushFrames();

    // First Up moves onto 'top'; the second has no line above and recalls.
    app.stdin.write(ARROW_UP);
    await flushFrames();
    app.stdin.write(ARROW_UP);
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls[1]?.text).toBe('remembered');

    app.unmount();
  });

  it('should cut to the end of the line on Ctrl+K', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('keep this cut that');
    await flushFrames();
    for (let index = 0; index < 8; index += 1) {
      app.stdin.write(ARROW_LEFT);
    }
    await flushFrames();
    app.stdin.write(CTRL_K);
    await flushFrames();

    expect(app.lastFrame() ?? '').toContain('keep this ');
    expect(app.lastFrame() ?? '').not.toContain('cut that');

    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[0]?.text).toBe('keep this');

    app.unmount();
  });

  it('should render the seeded transcript and the prompt hint', async () => {
    const app = renderConversation(
      createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      'chat',
      vi.fn(),
    );
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Interactive mode - describe your task.');
    // The marker column stands in for the speaker; there is no heading row.
    expect(frame).toContain('❯ seeded task');
    expect(frame).not.toContain('You');
    expect(frame).toContain('Enter: send');

    app.unmount();
  });

  it('should submit the draft on Enter and show the streamed tail while in flight', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls).toHaveLength(1);
    expect(conversation.submitCalls[0]?.text).toBe('hi');
    expect(conversation.submitCalls[0]?.abortSignal.aborted).toBe(false);

    conversation.submitCalls[0]?.onAssistantChunk('streamed tail');
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('streamed tail');
    expect(app.lastFrame() ?? '').toContain('Thinking...');

    conversation.resolveWith({ kind: 'assistant_response', content: 'final answer' });
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('final answer');
    expect(frame).not.toContain('streamed tail');
    expect(frame).not.toContain('Thinking...');

    app.unmount();
  });

  it('should show the assistant marker at most once per frame across the streaming hand-off', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    conversation.submitCalls[0]?.onAssistantChunk('partial answer');
    await flushFrames();

    // While streaming, the live tail carries no marker; only the committed entry does.
    expect(app.lastFrame() ?? '').toContain('partial answer');
    expect(app.lastFrame() ?? '').not.toContain('●');

    conversation.resolveWith({ kind: 'assistant_response', content: 'partial answer done' });
    await flushFrames();

    // Each frame is a full snapshot, so the marker must never appear twice within one.
    const perFrameMarkers = app.frames.map((frame) => (frame.match(/●/g) ?? []).length);
    expect(Math.max(...perFrameMarkers)).toBe(1);
    expect(app.lastFrame() ?? '').toContain('● partial answer done');
    expect(app.lastFrame() ?? '').toContain('partial answer done');

    app.unmount();
  });

  it('should keep the frame bounded while a long response streams', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    conversation.submitCalls[0]?.onAssistantChunk(
      Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n'),
    );
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThan(20);
    expect(frame).toContain('line 199');
    expect(frame).not.toContain('line 100');

    app.unmount();
  });

  it('should strip terminal control sequences from the stream and the committed reply', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    const sink = conversation.submitCalls[0]?.onAssistantChunk;
    expect(sink).toBeDefined();
    sink!('\x1b[31mstreamed tail');
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('streamed tail');

    // An unterminated sequence is withheld until its remaining bytes arrive.
    sink!(' \x1b]52;c;cGF5bG9hZA==');
    await flushFrames();

    conversation.resolveWith({
      kind: 'assistant_response',
      content: '\x1b]52;c;cGF5bG9hZA==\x07red reply',
    });
    await flushFrames();

    const allFrames = app.frames.join('\n');
    expect(allFrames).not.toContain('\x1b');
    expect(allFrames).not.toContain('cGF5bG9hZA==');
    expect(app.lastFrame() ?? '').toContain('red reply');

    app.unmount();
  });

  it('should strip terminal control sequences from an error notice', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    conversation.resolveWith({
      kind: 'error',
      message: '\x1b]52;c;cGF5bG9hZA==\x07\x1b[31mprovider exploded',
    });
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('provider exploded');
    expect(frame).not.toContain('\x1b');
    expect(frame).not.toContain('cGF5bG9hZA==');

    app.unmount();
  });

  it('should report a rejected submission as a failed exit instead of hanging', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    const failure = new Error('provider crashed');
    conversation.rejectWith(failure);
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith({ kind: 'failed', error: failure }, expect.any(Array));

    app.unmount();
  });

  it('should cancel on Ctrl+D with a draft in the buffer, like the readline editor', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('half-written task');
    await flushFrames();
    app.stdin.write(CTRL_D);
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );
    expect(conversation.submitCalls).toHaveLength(0);

    app.unmount();
  });

  it('should cancel on Ctrl+C while idle', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write(CTRL_C);
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );
    expect(conversation.submitCalls).toHaveLength(0);

    app.unmount();
  });

  it('should abort an in-flight submission on Ctrl+C and exit only once it settles', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    app.stdin.write(CTRL_C);
    await flushFrames();

    expect(conversation.submitCalls[0]?.abortSignal.aborted).toBe(true);
    expect(onExit).not.toHaveBeenCalled();

    conversation.resolveWith({ kind: 'error', message: 'aborted' });
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );
    expect(app.lastFrame() ?? '').not.toContain('aborted');

    app.unmount();
  });

  it('should force the exit on a second Ctrl+C when the provider ignores the abort', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    app.stdin.write(CTRL_C);
    await flushFrames();
    expect(conversation.submitCalls[0]?.abortSignal.aborted).toBe(true);
    expect(onExit).not.toHaveBeenCalled();

    app.stdin.write(CTRL_C);
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );

    app.unmount();
  });

  it('should abort and ignore a late response when the tree is unmounted from outside', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('hi');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    app.unmount();
    await flushFrames();
    expect(conversation.submitCalls[0]?.abortSignal.aborted).toBe(true);

    const framesBeforeLateResponse = app.frames.length;
    conversation.submitCalls[0]?.onAssistantChunk('late chunk');
    conversation.resolveWith({ kind: 'assistant_response', content: 'late answer' });
    await flushFrames();

    expect(onExit).not.toHaveBeenCalled();
    expect(app.frames).toHaveLength(framesBeforeLateResponse);
  });

  const LOCAL_COMMAND_EXITS: readonly {
    readonly name: string;
    readonly input: string;
    readonly command: TuiLocalCommand;
    readonly expected: ConversationExit;
  }[] = [
    {
      name: 'cancel',
      input: '/cancel',
      command: { kind: 'cancel' },
      expected: { kind: 'result', result: { action: 'cancel', task: '' } },
    },
    {
      name: 'execute',
      input: '/play run it',
      command: { kind: 'execute', task: 'run it' },
      expected: { kind: 'result', result: { action: 'execute', task: 'run it' } },
    },
    {
      name: 'choose_action',
      input: '/retry',
      command: { kind: 'choose_action', task: 'previous order' },
      expected: { kind: 'choose_action', task: 'previous order' },
    },
    {
      name: 'resume_session',
      input: '/resume',
      command: { kind: 'resume_session' },
      expected: { kind: 'resume_session' },
    },
  ];

  it.each(LOCAL_COMMAND_EXITS)(
    'should exit with the $name outcome the conversation resolved locally',
    async ({ input, command, expected }) => {
      const conversation = createScriptedConversation(
        new Map([[input, command]]),
        NO_ORDER_COMMANDS,
      );
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      await flushFrames();

      app.stdin.write(input);
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();

      expect(onExit).toHaveBeenCalledExactlyOnceWith(expected, expect.any(Array));
      expect(conversation.submitCalls).toHaveLength(0);
      // Resuming is the surrounding TUI's job; this view only reports the intent.
      expect(conversation.resumedSessions).toHaveLength(0);
      expect(app.frames.join('\n')).not.toContain('Thinking...');

      app.unmount();
    },
  );

  it('should render a local notice and stay in the conversation', async () => {
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([
        ['/accept', { kind: 'notice', message: 'No assistant response found.' }],
      ]),
      NO_ORDER_COMMANDS,
    );
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/accept');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('No assistant response found.');
    expect(frame).toContain('/accept');
    expect(onExit).not.toHaveBeenCalled();
    expect(conversation.submitCalls).toHaveLength(0);

    app.unmount();
  });

  it('should insert the pasted image placeholder at the caret', async () => {
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([
        ['/paste-image', { kind: 'paste_image' }],
      ]),
      NO_ORDER_COMMANDS,
    );
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/paste-image');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(app.lastFrame() ?? '').toContain(`❯ ${PASTED_IMAGE_PLACEHOLDER}`);
    expect(onExit).not.toHaveBeenCalled();

    app.unmount();
  });

  it('should capture the clipboard image on Ctrl+V and insert it at the caret', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('ab');
    await flushFrames();
    app.stdin.write(ARROW_LEFT);
    await flushFrames();
    app.stdin.write(CTRL_V);
    await flushFrames();

    expect(app.lastFrame() ?? '').toContain(`❯ a${PASTED_IMAGE_PLACEHOLDER}`);

    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[0]?.text).toBe(`a${PASTED_IMAGE_PLACEHOLDER}b`);

    app.unmount();
  });

  it('should keep the draft editable when a Ctrl+V capture fails', async () => {
    const conversation = {
      ...createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      pasteClipboardImage: () => Promise.reject(new Error('Clipboard does not contain an image.')),
    };
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('draft');
    await flushFrames();
    app.stdin.write(CTRL_V);
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain(getLabel('tui.errors.imagePasteFailed', 'en'));
    expect(frame).toContain('Clipboard does not contain an image.');
    expect(frame).toContain('❯ draft');

    app.stdin.write('!');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[0]?.text).toBe('draft!');

    app.unmount();
  });

  it('should insert the placeholder for an image the terminal pastes inline', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write(INLINE_IMAGE_PASTE);
    await flushFrames();

    expect(conversation.savedImages).toHaveLength(1);
    expect(conversation.savedImages[0]?.mimeType).toBe('image/png');
    expect(conversation.savedImages[0]?.data.equals(INLINE_IMAGE_DATA)).toBe(true);
    expect(app.lastFrame() ?? '').toContain(`❯ ${PASTED_IMAGE_PLACEHOLDER}`);

    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[0]?.text).toBe(PASTED_IMAGE_PLACEHOLDER);

    app.unmount();
  });

  it('should finish an inline image save before exiting so its temp file is cleaned up', async () => {
    let releaseSave!: () => void;
    const conversation = {
      ...createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      saveInlineImage: () => new Promise<string>((resolve) => {
        releaseSave = () => resolve(PASTED_IMAGE_PLACEHOLDER);
      }),
    };
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write(INLINE_IMAGE_PASTE);
    await flushFrames();

    app.stdin.write(CTRL_C);
    await flushFrames();
    // The save is still running, so the run must not have exited yet.
    expect(onExit).not.toHaveBeenCalled();

    releaseSave();
    await flushFrames();

    expect(onExit).toHaveBeenCalledWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );

    app.unmount();
  });

  it('should finish a Ctrl+V capture before exiting so its temp file is cleaned up', async () => {
    let releasePaste!: () => void;
    const conversation = {
      ...createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      pasteClipboardImage: () => new Promise<string>((resolve) => {
        releasePaste = () => resolve(PASTED_IMAGE_PLACEHOLDER);
      }),
    };
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write(CTRL_V);
    await flushFrames();

    app.stdin.write(CTRL_C);
    await flushFrames();
    expect(onExit).not.toHaveBeenCalled();

    releasePaste();
    await flushFrames();

    expect(onExit).toHaveBeenCalledWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );

    app.unmount();
  });

  it('should route the first input through createInstruction in summarize mode', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'summarize', onExit);
    await flushFrames();

    app.stdin.write('add a cache layer');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls).toHaveLength(0);
    expect(conversation.instructionCalls).toHaveLength(1);
    expect(conversation.instructionCalls[0]?.text).toBe('add a cache layer');

    conversation.resolveWith({ kind: 'task_instruction', task: 'Add a cache layer' });
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'choose_action', task: 'Add a cache layer' },
      expect.any(Array),
    );

    app.unmount();
  });

  it('should move the caret with the arrow keys and insert at the caret', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('abc');
    await flushFrames();
    app.stdin.write(ARROW_LEFT);
    await flushFrames();
    app.stdin.write(ARROW_LEFT);
    await flushFrames();
    app.stdin.write('X');
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('❯ aXbc');

    app.stdin.write(ARROW_RIGHT);
    await flushFrames();
    app.stdin.write('Y');
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('❯ aXbYc');

    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[0]?.text).toBe('aXbYc');

    app.unmount();
  });

  it('should summarize the seeded input on mount when autoSubmit is set', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'summarize', onExit, { autoSubmit: true });
    await flushFrames();

    expect(conversation.instructionCalls).toHaveLength(1);
    expect(conversation.instructionCalls[0]?.text).toBe('');
    expect(conversation.submitCalls).toHaveLength(0);

    conversation.resolveWith({ kind: 'task_instruction', task: 'seeded instruction' });
    await flushFrames();
    expect(onExit).toHaveBeenCalledWith({ kind: 'choose_action', task: 'seeded instruction' }, expect.any(Array));

    app.unmount();
  });

  it('should not add an empty user row for the seeded auto-submit', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'summarize', vi.fn(), { autoSubmit: true });
    await flushFrames();

    // Each frame is a full snapshot, so the committed rows are counted in one.
    // The prompt's own marker sits inside the box border, so it never matches.
    const userRows = ((app.lastFrame() ?? '').match(/^❯ /gm) ?? []).length;
    const seededUserRows = INITIAL_ENTRIES.filter((entry) => entry.role === 'user').length;
    expect(userRows).toBe(seededUserRows);

    app.unmount();
  });

  it('should not summarize on mount without autoSubmit', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'summarize', vi.fn());
    await flushFrames();

    expect(conversation.instructionCalls).toHaveLength(0);

    app.unmount();
  });

  it('should leave no temp file when an outside unmount races a real save', async () => {
    // A real store, so the assertion is about files on disk rather than a spy.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'takt-cv-attach-'));
    const store = createImageAttachmentStore({ tmpRoot, sessionId: 'session-1' });
    let releasePaste!: () => void;
    const conversation = {
      ...createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/paste-image', { kind: 'paste_image' }]]),
        NO_ORDER_COMMANDS,
      ),
      // Ignores the abort, exactly like a clipboard read already in flight.
      pasteClipboardImage: () => new Promise<string>((resolve) => {
        releasePaste = () => {
          void store.saveImage(PNG_BYTES, 'image/png')
            .then((attachment) => resolve(attachment.placeholder))
            .catch(() => resolve(''));
        };
      }),
      sealImages: () => store.seal(),
    };
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('/paste-image');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    // The caller tears the tree down and cleans up while the capture runs.
    app.unmount();
    cleanupImageAttachmentStore(store);

    releasePaste();
    await flushFrames();

    expect(store.listAttachments()).toEqual([]);
    expect(existsSync(join(tmpRoot, 'takt', 'session-1'))).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('should seal against a save that lands after a forced exit', async () => {
    let releasePaste!: () => void;
    const conversation = {
      ...createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/paste-image', { kind: 'paste_image' }]]),
        NO_ORDER_COMMANDS,
      ),
      pasteClipboardImage: () => new Promise<string>((resolve) => {
        releasePaste = () => resolve('[Image #1]');
      }),
    };
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/paste-image');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    app.stdin.write(CTRL_C);
    await flushFrames();
    expect(onExit).not.toHaveBeenCalled();

    // The capture ignores the abort, so the second Ctrl+C must not wait for it.
    app.stdin.write(CTRL_C);
    await flushFrames();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );
    expect(conversation.sealCalls.length).toBeGreaterThan(0);

    releasePaste();
    await flushFrames();
    expect(onExit).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it('should drain a running capture before exiting with the summarized task', async () => {
    let releasePaste!: () => void;
    const conversation = {
      ...createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/paste-image', { kind: 'paste_image' }]]),
        NO_ORDER_COMMANDS,
      ),
      pasteClipboardImage: () => new Promise<string>((resolve) => {
        releasePaste = () => resolve('{{image:1}}');
      }),
    };
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/paste-image');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    // The summary lands while the capture is still running.
    app.stdin.write('summarize this');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    conversation.resolveWith({ kind: 'task_instruction', task: 'run it' });
    await flushFrames();

    // The picker must not start while a temp file is still being written.
    expect(onExit).not.toHaveBeenCalled();

    releasePaste();
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'choose_action', task: 'run it' },
      ['/paste-image', 'summarize this'],
    );

    app.unmount();
  });

  it('should finish a clipboard capture before exiting so its temp file is cleaned up', async () => {
    let releasePaste!: (placeholder: string) => void;
    const pasteSettled = vi.fn();
    const conversation = {
      ...createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/paste-image', { kind: 'paste_image' }]]),
        NO_ORDER_COMMANDS,
      ),
      pasteClipboardImage: () => new Promise<string>((resolve) => {
        releasePaste = (placeholder: string) => {
          pasteSettled();
          resolve(placeholder);
        };
      }),
    };
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/paste-image');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    app.stdin.write(CTRL_C);
    await flushFrames();
    // The capture is still running, so the run must not have exited yet.
    expect(onExit).not.toHaveBeenCalled();

    releasePaste('{{image:1}}');
    await flushFrames();

    expect(pasteSettled).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );
    // The late placeholder must not land in the buffer after the exit.
    expect(app.lastFrame() ?? '').not.toContain('{{image:1}}');

    app.unmount();
  });

  it('should hand the run abort signal to the clipboard capture', async () => {
    const signals: AbortSignal[] = [];
    let releasePaste!: () => void;
    const conversation = {
      ...createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/paste-image', { kind: 'paste_image' }]]),
        NO_ORDER_COMMANDS,
      ),
      pasteClipboardImage: (abortSignal: AbortSignal) => new Promise<string>((resolve) => {
        signals.push(abortSignal);
        releasePaste = () => resolve('{{image:1}}');
      }),
    };
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('/paste-image');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    app.stdin.write(CTRL_C);
    await flushFrames();
    expect(signals[0]?.aborted).toBe(true);

    releasePaste();
    await flushFrames();

    app.unmount();
  });

  it('should drain a concurrent clipboard capture and submission before exiting', async () => {
    let releasePaste!: () => void;
    const pasteSettled = vi.fn();
    const conversation = {
      ...createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/paste-image', { kind: 'paste_image' }]]),
        NO_ORDER_COMMANDS,
      ),
      pasteClipboardImage: () => new Promise<string>((resolve) => {
        releasePaste = () => {
          pasteSettled();
          resolve('{{image:1}}');
        };
      }),
    };
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('/paste-image');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    // The capture is still running; a submission starts on top of it.
    app.stdin.write('meanwhile');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls).toHaveLength(1);

    app.stdin.write(CTRL_C);
    await flushFrames();
    expect(onExit).not.toHaveBeenCalled();

    // Settling only the submission must not be enough — the capture still owns a file.
    conversation.resolveWith({ kind: 'error', message: 'aborted' });
    await flushFrames();
    expect(onExit).not.toHaveBeenCalled();

    releasePaste();
    await flushFrames();

    expect(pasteSettled).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'cancel', task: '' } },
      expect.any(Array),
    );

    app.unmount();
  });

  it('should hand the summarized task back with the history for the next mount', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('first turn');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    conversation.resolveWith({ kind: 'task_instruction', task: 'do it' });
    await flushFrames();

    expect(onExit).toHaveBeenCalledWith({ kind: 'choose_action', task: 'do it' }, ['first turn']);
    app.unmount();

    // Continuing means a new mount, seeded with what was typed before.
    const continued = renderConversation(conversation, 'chat', vi.fn(), {
      initialHistory: ['first turn'],
    });
    await flushFrames();
    continued.stdin.write('second turn');
    await flushFrames();
    expect(continued.lastFrame() ?? '').toContain('❯ second turn');

    continued.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[1]?.text).toBe('second turn');

    continued.unmount();
  });

  it('should insert a newline on Ctrl+J, which Ink delivers as a bare line feed', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('first line');
    await flushFrames();
    // Ink reports Ctrl+J as input '\n' with no key flags set.
    app.stdin.write('\n');
    await flushFrames();
    app.stdin.write('second line');
    await flushFrames();

    expect(conversation.submitCalls).toHaveLength(0);

    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[0]?.text).toBe('first line\nsecond line');

    app.unmount();
  });

  it('should apply every keypress of a burst that arrives before a re-render', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('abcd');
    await flushFrames();

    // Key repeat delivers these without React re-rendering in between.
    app.stdin.write(ARROW_LEFT);
    app.stdin.write(ARROW_LEFT);
    app.stdin.write('X');
    await flushFrames();

    expect(app.lastFrame() ?? '').toContain('❯ abXcd');

    app.stdin.write(ENTER);
    await flushFrames();
    expect(conversation.submitCalls[0]?.text).toBe('abXcd');

    app.unmount();
  });

  it('should insert a newline on Shift+Enter and Option+Enter instead of submitting', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('first line');
    await flushFrames();
    app.stdin.write(ALT_ENTER);
    await flushFrames();
    app.stdin.write('second line');
    await flushFrames();

    expect(conversation.submitCalls).toHaveLength(0);
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('❯ first line');
    expect(frame).toContain('  second line');

    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.submitCalls[0]?.text).toBe('first line\nsecond line');

    app.unmount();
  });

  it('should recall the previous submission with the up arrow', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('remembered draft');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    conversation.resolveWith({ kind: 'assistant_response', content: 'ok' });
    await flushFrames();

    app.stdin.write(ARROW_UP);
    await flushFrames();

    expect(app.lastFrame() ?? '').toContain('❯ remembered draft');

    app.unmount();
  });

  it('should offer slash completions, move the highlight and accept one with Tab', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('/');
    await flushFrames();

    const completionFrame = app.lastFrame() ?? '';
    expect(completionFrame).toContain('❯ /accept');
    expect(completionFrame).toContain('/play');
    expect(completionFrame).toContain('/go');
    expect(completionFrame).toContain('/cancel');
    expect(completionFrame).toContain('Run a task immediately');
    // Both order commands are unavailable in this run, so they stay out of the menu.
    expect(completionFrame).not.toContain('/retry');
    expect(completionFrame).not.toContain('/replay');

    app.stdin.write(ARROW_DOWN);
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('❯ /play');

    app.stdin.write(ARROW_UP);
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('❯ /accept');

    app.stdin.write(TAB);
    await flushFrames();

    const acceptedFrame = app.lastFrame() ?? '';
    // The buffer now holds the accepted command and the menu is gone.
    expect(acceptedFrame).toContain('❯ /accept');
    expect(acceptedFrame).not.toContain('Run a task immediately');
    expect(acceptedFrame).not.toContain('/cancel');

    app.unmount();
  });

  it('should offer the order commands only when the run makes them available', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, {
      enableRetryCommand: true,
      hasPreviousOrder: true,
    });
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('/r');
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('/retry');
    expect(frame).toContain('/replay');
    expect(frame).toContain('/resume');
    expect(frame).not.toContain('/play');

    app.unmount();
  });
});
