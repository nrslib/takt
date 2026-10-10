import { render } from 'ink-testing-library';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { render as renderInk, renderToString, Text, useCursor, useWindowSize } from 'ink';
import { Terminal } from '@xterm/headless';
import { PassThrough } from 'node:stream';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationView,
  type ConversationExit,
  type ConversationUiText,
  type ConversationViewProps,
} from '../features/tui/ConversationView.js';
import type { InteractiveModeResult } from '../features/interactive/interactive.js';
import type { PastedImage } from '../features/interactive/inlineImagePaste.js';
import type { EditorDraft } from '../features/tui/editorState.js';
import {
  TranscriptEntryView,
  TranscriptView,
  type TranscriptEntry,
} from '../features/tui/TranscriptEntryView.js';
import { runTuiConversation } from '../features/tui/conversationRunner.js';
import { formatTranscriptEntryOutput } from '../features/tui/transcriptOutput.js';
import { PromptInput } from '../features/tui/PromptInput.js';
import {
  createTuiConversation,
  type TuiConversation,
  type TuiLocalCommand,
  type TuiSubmission,
  type TuiSubmitInput,
} from '../features/tui/tuiConversation.js';
import { getLabel } from '../shared/i18n/index.js';
import { matchSlashCommand } from '../features/interactive/commandMatcher.js';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupImageAttachmentStore,
  createImageAttachmentStore,
  createSessionImageAttachmentStore,
} from '../features/interactive/imageAttachments.js';
import { stripAnsi } from '../shared/utils/text.js';
import { makeProvider } from './test-helpers.js';
import { expectUndeliveredPrompt } from './helpers/undelivered.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ENTER = '\r';
const ALT_ENTER = '\x1b\r';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const ESC = '\x1b';
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
  interruptHint: getLabel('tui.ui.interruptHint', 'en'),
  responseInterrupted: getLabel('tui.ui.responseInterrupted', 'en'),
  instructionInterrupted: getLabel('tui.ui.instructionInterrupted', 'en'),
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

function createPendingProviderConversation() {
  const pending: Array<() => void> = [];
  const call = vi.fn().mockImplementation(() => new Promise((resolve) => {
    pending.push(() => resolve({
      persona: 'interactive', status: 'done', content: 'late response', timestamp: new Date(),
    }));
  }));
  const store = createSessionImageAttachmentStore('/repo');
  const conversation = createTuiConversation({
    cwd: '/repo',
    plan: {
      ctx: {
        provider: makeProvider({ setup: () => ({ call }) }),
        providerType: 'mock', model: 'mock-model', lang: 'en',
        personaName: 'interactive', sessionId: undefined,
      },
      strategy: {
        systemPrompt: 'system', formalSpec: false, modelCheckTimeoutSeconds: 300,
        allowedTools: [], transformPrompt: (message: string) => message,
        introMessage: 'Interactive mode',
      },
    },
    attachmentStore: store,
    persistSession: false,
  });
  return { call, store, conversation, settlePending: () => pending.forEach((settle) => settle()) };
}

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
  let activeSessionId: string | undefined;
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
    // The plain conversation does not record which command produced a task.
    tracksResultSource: false,

    // The real conversation asks the registry; the double answers for the
    // commands this test gave it, so a `/path`-looking line stays text.
    isCommandLine(text: string): boolean {
      return matchSlashCommand(text.trim(), commandAvailability) !== null;
    },
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
    resumeSession(sessionId: string): Promise<string | undefined> {
      resumedSessions.push(sessionId);
      activeSessionId = sessionId;
      return Promise.resolve(undefined);
    },
    getSessionId(): string | undefined {
      return activeSessionId;
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
  readonly initialDraft?: EditorDraft;
  readonly initialQueue?: readonly string[];
  readonly modelLabel?: () => string;
  readonly residentSession?: boolean;
  readonly liveStatusReader?: () => string;
  readonly liveStatusRefreshIntervalMs?: number;
  readonly userMessageColors?: ConversationViewProps['userMessageColors'];
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
      userMessageColors={overrides.userMessageColors ?? {
        background: '#42454b',
        foreground: '#ffffff',
      }}
      submitMode={submitMode}
      autoSubmit={overrides.autoSubmit ?? false}
      initialHistory={overrides.initialHistory ?? []}
      initialDraft={overrides.initialDraft}
      initialQueue={overrides.initialQueue ?? []}
      residentSession={overrides.residentSession ?? false}
      liveStatusReader={overrides.liveStatusReader}
      liveStatusRefreshIntervalMs={overrides.liveStatusRefreshIntervalMs}
      modelLabel={overrides.modelLabel ?? (() => MODEL_LABEL)}
      onExit={onExit}
    />,
  );
}

const USER_MESSAGE_BACKGROUND = '\x1b[48;2;66;69;75m';
const DEFAULT_FOREGROUND = '\x1b[39m';
const USER_MESSAGE_FOREGROUND = '\x1b[38;2;255;255;255m';
const DIM_TEXT = '\x1b[2m';
const FALLBACK_USER_MESSAGE_COLORS = { background: '#42454b', foreground: '#ffffff' } as const;
const THEMED_USER_MESSAGE_COLORS = { background: '#d7d7d7' } as const;

function renderWithColors(node: ReactNode, columns: number): string {
  const originalChalkLevel = chalk.level;
  try {
    chalk.level = 3;
    return renderToString(node, { columns });
  } finally {
    chalk.level = originalChalkLevel;
  }
}

class ResizableOutput extends PassThrough {
  columns: number;
  rows: number;
  readonly isTTY = true;
  readonly frames: string[] = [];

  /** Creates a sized test TTY that records each write for later terminal-emulator playback. */
  constructor(columns: number, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.on('data', (chunk: Buffer) => {
      this.frames.push(chunk.toString());
    });
  }

  /** Updates the emulated TTY dimensions and notifies Ink with a resize event. */
  resize(columns: number, rows = this.rows): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

function waitForOutput(
  output: ResizableOutput,
  predicate: (captured: string) => boolean,
  description: string,
): Promise<string> {
  const getOutput = (): string => output.frames.join('');
  const current = getOutput();
  if (predicate(current)) {
    return Promise.resolve(current);
  }

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      output.off('data', check);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    };
    const check = (): void => {
      const captured = getOutput();
      if (!predicate(captured)) {
        return;
      }
      cleanup();
      resolve(captured);
    };

    output.on('data', check);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for terminal output: ${description}`));
    }, 5_000);
    check();
  });
}

interface ProcessPseudoTerminal {
  readonly stdin: PassThrough;
  readonly stdout: ResizableOutput;
  restore(): void;
}

function installProcessPseudoTerminal(rows: number): ProcessPseudoTerminal {
  const descriptors = {
    stdin: Object.getOwnPropertyDescriptor(process, 'stdin'),
    stdout: Object.getOwnPropertyDescriptor(process, 'stdout'),
    stderr: Object.getOwnPropertyDescriptor(process, 'stderr'),
  };
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stdout = new ResizableOutput(100, rows);
  const stderr = new PassThrough();
  Object.assign(stderr, { isTTY: true, columns: 100, rows });
  stderr.on('data', () => undefined);

  const write = stdout.write.bind(stdout);
  stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (value.includes('\x1b]11;?\x1b\\')) {
      setImmediate(() => {
        stdin.write('\x1b]11;rgb:1010/1010/1010\x1b\\');
      });
    }
    if (typeof encodingOrCallback === 'function') {
      return write(chunk, encodingOrCallback);
    }
    if (encodingOrCallback !== undefined) {
      return write(chunk, encodingOrCallback, callback);
    }
    return write(chunk, callback);
  }) as typeof stdout.write;

  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: stdin,
  });
  Object.defineProperty(process, 'stdout', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: stdout,
  });
  Object.defineProperty(process, 'stderr', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: stderr,
  });

  let restored = false;
  return {
    stdin,
    stdout,
    restore(): void {
      if (restored) {
        return;
      }
      restored = true;
      if (descriptors.stdin !== undefined) {
        Object.defineProperty(process, 'stdin', descriptors.stdin);
      }
      if (descriptors.stdout !== undefined) {
        Object.defineProperty(process, 'stdout', descriptors.stdout);
      }
      if (descriptors.stderr !== undefined) {
        Object.defineProperty(process, 'stderr', descriptors.stderr);
      }
    },
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function getMaximumTerminalScrollbackOffset(
  output: ResizableOutput,
): Promise<number> {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: output.columns,
    rows: output.rows,
    convertEol: true,
  });
  let maximumBaseY = 0;
  try {
    for (const frame of output.frames) {
      await new Promise<void>((resolve) => terminal.write(frame, resolve));
      maximumBaseY = Math.max(maximumBaseY, terminal.buffer.active.baseY);
    }
  } finally {
    terminal.dispose();
  }
  return maximumBaseY;
}

async function writeTerminalFrames(terminal: Terminal, frames: readonly string[]): Promise<void> {
  for (const frame of frames) {
    await new Promise<void>((resolve) => terminal.write(frame, resolve));
  }
}

/** Reads visible rows and native scrollback so stale frames cannot hide above the viewport. */
function getTerminalText(terminal: Terminal): string {
  return Array.from({ length: terminal.buffer.active.length }, (_, index) => (
    terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
  )).join('\n');
}

function getVisibleTerminalText(terminal: Terminal, rows: number): string {
  const baseY = terminal.buffer.active.baseY;
  return Array.from({ length: rows }, (_, index) => (
    terminal.buffer.active.getLine(baseY + index)?.translateToString(true) ?? ''
  )).join('\n');
}

function createTestInput(): NodeJS.ReadStream {
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: () => input,
    ref: () => input,
    unref: () => input,
  });
  return input as unknown as NodeJS.ReadStream;
}

describe('TranscriptEntryView', () => {
  it.each(['12345678', '日本語の', '12345678\nabcdefgh'])('should keep user glyphs at the exact right margin: %s', async (content) => {
    const terminal = new Terminal({ allowProposedApi: true, cols: 10, rows: 12, convertEol: true });
    try {
      await writeTerminalFrames(terminal, [formatTranscriptEntryOutput({ role: 'user', content }, FALLBACK_USER_MESSAGE_COLORS)]);
      const buffer = getTerminalText(terminal);
      expect(buffer).toContain(`❯ ${content.replaceAll('\n', '\n  ')}`);
    } finally {
      terminal.dispose();
    }
  });
  it('should render a submitted user message as a full-width dark band with white text and one padded row on each side', () => {
    const columns = 24;
    const output = renderWithColors(
      <TranscriptEntryView
        entry={{ role: 'user', content: 'submitted message' }}
        userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
      />,
      columns,
    );
    const [topPadding, content, bottomPadding, outsideBand] = output.split('\n');

    expect(stripAnsi(topPadding ?? '')).toBe(' '.repeat(columns));
    expect(topPadding?.startsWith(USER_MESSAGE_BACKGROUND)).toBe(true);
    expect(stripAnsi(content ?? '').trimEnd()).toBe('❯ submitted message');
    expect(stripAnsi(content ?? '')).toHaveLength(columns);
    expect(content?.startsWith(USER_MESSAGE_BACKGROUND)).toBe(true);
    expect(content).toContain(
      `${USER_MESSAGE_FOREGROUND}❯ submitted message${DEFAULT_FOREGROUND}`,
    );
    expect(content).not.toContain(DIM_TEXT);
    expect(stripAnsi(bottomPadding ?? '')).toBe(' '.repeat(columns));
    expect(bottomPadding?.startsWith(USER_MESSAGE_BACKGROUND)).toBe(true);
    expect(outsideBand ?? '').not.toContain(USER_MESSAGE_BACKGROUND);
  });

  it.each([false, true])('should preserve preexisting scrollback and redraw only the prompt on resize (incremental=%s)', async (incrementalRendering) => {
    const message = 'alpha beta gamma delta';
    const narrowColumns = 20;
    const wideColumns = 26;
    const archive = Array.from({ length: 12 }, (_, index) => `archive-${index.toString().padStart(2, '0')}`);
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const stdout = new ResizableOutput(wideColumns, 20);
    const stderr = new PassThrough();
    const originalChalkLevel = chalk.level;
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: wideColumns,
      rows: stdout.rows,
      convertEol: true,
    });
    let app: ReturnType<typeof renderInk> | undefined;
    let processedFrames = 0;
    /** Applies only newly captured frames, preserving the emulator's existing history. */
    const updateTerminal = async (): Promise<void> => {
      const end = stdout.frames.length;
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames, end));
      processedFrames = end;
    };

    try {
      chalk.level = 3;
      await writeTerminalFrames(terminal, ['preexisting shell history\r\n']);
      const input = createTestInput();
      app = renderInk(
        <ConversationView
          ui={UI}
          lang="en"
          conversation={conversation}
          userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
          initialEntries={[
            ...archive.map((content) => ({ role: 'assistant' as const, content })),
            { role: 'user', content: message },
            { role: 'assistant', content: 'answer' },
            { role: 'system', content: 'notice' },
          ]}
          submitMode="chat"
          autoSubmit={false}
          initialHistory={[]}
          initialDraft={{ text: 'not submitted', cursor: 13 }}
          initialQueue={[]}
          residentSession={false}
          modelLabel={() => MODEL_LABEL}
          onExit={() => undefined}
        />,
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stderr as unknown as NodeJS.WriteStream,
          stdin: input,
          exitOnCtrlC: false,
          interactive: true,
          incrementalRendering,
          patchConsole: false,
        },
      );
      await waitForOutput(
        stdout,
        (captured) => captured.includes(message) && captured.includes('not submitted'),
        'initial transcript and prompt',
      );
      await flushFrames();
      await updateTerminal();
      expect(getTerminalText(terminal)).toContain('preexisting shell history');
      expect(terminal.buffer.active.baseY).toBeGreaterThan(0);

      for (const columns of [narrowColumns, wideColumns, narrowColumns, wideColumns]) {
        terminal.resize(columns, stdout.rows);
        const start = stdout.frames.length;
        stdout.resize(columns);
        await waitForOutput(
          stdout,
          () => stripAnsi(stdout.frames.slice(start).join('')).includes('not subm'),
          'prompt redraw after resize settles',
        );
        await flushFrames();
        await updateTerminal();
        const buffer = getTerminalText(terminal);
        expect(buffer.replace(/\s/g, '')).toContain('preexistingshellhistory');
        const resizeOutput = stdout.frames.slice(start).join('');
        expect(resizeOutput).not.toMatch(/\x1b\[(?:2|3)J/);
        expect(resizeOutput).not.toContain(archive[0]);
        for (const entry of archive) {
          expect(countOccurrences(buffer, entry), buffer).toBe(1);
        }
        expect(countOccurrences(buffer.replace(/\s/g, ''), message.replace(/\s/g, '')), buffer).toBe(1);
        expect(countOccurrences(buffer, 'answer')).toBe(1);
        expect(countOccurrences(buffer, 'notice')).toBe(1);
        expect(countOccurrences(buffer.replace(/[\s│]/g, ''), 'notsubmitted'), buffer).toBe(1);
        // Committed history is owned by the terminal, never replayed by the app.
        expect(countOccurrences(stdout.frames.join(''), message)).toBe(1);
      }

      const unchangedStart = stdout.frames.length;
      stdout.resize(wideColumns);
      input.write('!');
      await waitForOutput(stdout, (output) => output.includes('not submitted!'), 'draft edit after resize');
      const unchangedOutput = stdout.frames.slice(unchangedStart).join('');
      expect(unchangedOutput).not.toContain('\x1b[3J');
      expect(unchangedOutput).not.toContain(archive[0]);
      expect(conversation.submitCalls).toHaveLength(0);
      expect(conversation.instructionCalls).toHaveLength(0);
    } finally {
      app?.unmount();
      await app?.waitUntilExit();
      app?.cleanup();
      terminal.dispose();
      chalk.level = originalChalkLevel;
    }
  });

  it.each([
    { role: 'user', content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' },
    { role: 'assistant', content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' },
    { role: 'user', content: '日本語の履歴も広い端末では一行に戻り、明示的な改行だけは維持します。' },
    { role: 'assistant', content: '日本語の履歴も広い端末では一行に戻り、明示的な改行だけは維持します。' },
  ] as const)('should reflow a committed $role paragraph when widening without replaying history: $content', async ({ role, content }) => {
    const narrowColumns = 24;
    const wideColumns = 100;
    const stdout = new ResizableOutput(narrowColumns, 12);
    const terminal = new Terminal({ allowProposedApi: true, cols: narrowColumns, rows: stdout.rows, convertEol: true });
    const entries: TranscriptEntry[] = [{ role, content }];
    const beforeExitListeners = process.listenerCount('beforeExit');
    let app: ReturnType<typeof renderInk> | undefined;
    try {
      await writeTerminalFrames(terminal, [
        'earlier shell marker\r\n', ...Array<string>(20).fill('older shell line\r\n'),
      ]);
      app = renderInk(<><TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} /><Text>live input</Text></>, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new PassThrough() as unknown as NodeJS.WriteStream,
        stdin: createTestInput(), exitOnCtrlC: false, interactive: true, patchConsole: false,
      });
      await waitForOutput(stdout, (value) => value.includes('live input'), 'initial narrow transcript');
      await flushFrames();
      let processedFrames = stdout.frames.length;
      await writeTerminalFrames(terminal, stdout.frames);
      expect(getTerminalText(terminal)).not.toContain(content);
      for (const columns of [wideColumns, narrowColumns, wideColumns]) {
        terminal.resize(columns, stdout.rows);
        stdout.resize(columns);
        const start = processedFrames;
        await waitForOutput(stdout, () => stdout.frames.length > start, 'resized input');
        await writeTerminalFrames(terminal, stdout.frames.slice(start));
        processedFrames = stdout.frames.length;
        const buffer = getTerminalText(terminal);
        expect(buffer.replace(/\s/g, '')).toContain('earliershellmarker');
        expect(countOccurrences(buffer.replace(/\s/g, ''), content.replace(/\s/g, ''))).toBe(1);
        // A paragraph committed at the narrow width must become one row at the
        // wider width, not retain Ink's old hard line breaks.
        expect(buffer.includes(content), buffer).toBe(columns === wideColumns);
        expect(stdout.frames.slice(start).join('')).not.toContain(content.slice(0, 10));
        expect(stdout.frames.slice(start).join('')).not.toMatch(/\x1b\[(?:2|3)J/);
      }
    } finally {
      app?.unmount();
      await app?.waitUntilExit();
      app?.cleanup();
      terminal.dispose();
      expect(process.listenerCount('beforeExit')).toBe(beforeExitListeners);
    }
  });

  it.each([false, true])('should not archive a multiline input frame when height or width shrinks (incremental=%s)', async (incrementalRendering) => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const stdout = new ResizableOutput(80, 20);
    const input = createTestInput();
    const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 20, convertEol: true, scrollback: 10000 });
    const draft = 'long issue body 👩‍💻\t日本語 '.repeat(40) + 'DRAFT_END';
    let app: ReturnType<typeof renderInk> | undefined;
    let processedFrames = 0;
    /** Applies new frames once while exercising height reductions around an unsent draft. */
    const updateTerminal = async (): Promise<void> => {
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames));
      processedFrames = stdout.frames.length;
    };
    try {
      await writeTerminalFrames(terminal, ['SHELL_MARKER\r\n', ...Array<string>(40).fill('older shell line\r\n')]);
      app = renderInk(<ConversationView
        ui={UI} lang="en" conversation={conversation} userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
        initialEntries={[{ role: 'assistant', content: 'committed history marker' }]}
        submitMode="chat" autoSubmit={false} initialHistory={[]} initialDraft={{ text: draft, cursor: draft.length }}
        initialQueue={[]} residentSession={false} modelLabel={() => MODEL_LABEL} onExit={() => undefined}
      />, {
        stdout: stdout as unknown as NodeJS.WriteStream, stderr: new PassThrough() as unknown as NodeJS.WriteStream,
        stdin: input, exitOnCtrlC: false, interactive: true, incrementalRendering, anchorLiveFrame: true, patchConsole: false,
      });
      await app.waitUntilRenderFlush();
      await updateTerminal();
      for (const busy of [false, true]) {
        if (busy) {
          input.write(ENTER);
          await waitForOutput(stdout, (value) => value.includes('Thinking'), 'busy reply');
          input.write(`\x1b[200~${draft}\x1b[201~`);
          await app.waitUntilRenderFlush();
          await updateTerminal();
        }
        for (const [columns, rows] of [[80, 6], [80, 20], [14, 20], [80, 20], [32, 8], [80, 20]] as const) {
          const offset = stdout.frames.length;
          terminal.resize(columns, rows);
          stdout.resize(columns, rows);
          await waitForOutput(stdout, () => stdout.frames.slice(offset).join('').includes('╭'), 'resized input frame');
          await app.waitUntilRenderFlush();
          await updateTerminal();
          const buffer = getTerminalText(terminal);
          expect(countOccurrences(buffer, '╭'), buffer).toBe(1);
          expect(countOccurrences(buffer, '╰'), buffer).toBe(1);
          expect(countOccurrences(buffer, 'Thinking'), buffer).toBe(busy ? 1 : 0);
          expect(buffer).toContain('SHELL_MARKER');
          expect(buffer.replace(/\s/g, '')).toContain('committedhistorymarker');
        }
      }
      expect(conversation.submitCalls).toHaveLength(1);
      expect(conversation.submitCalls[0]?.text).toBe(draft);
      // A large PTY write may be split while the terminal resizes. Painted
      // rows must remain at/below the cursor even during a partial frame.
      const frame = [...stdout.frames].reverse().find((value) => value.includes('Thinking') && value.includes('DRAFT_END'));
      if (frame === undefined) throw new Error('No complete busy frame was captured');
      for (const cut of [frame.indexOf('\x1b[?7l'), frame.indexOf('╭') + 1]) {
        const partial = new Terminal({ allowProposedApi: true, cols: 80, rows: 20, convertEol: true, scrollback: 10000 });
        try {
          await writeTerminalFrames(partial, ['SHELL_MARKER\r\n', ...Array<string>(40).fill('older shell line\r\n'), frame.slice(0, cut)]);
          partial.resize(80, 6);
          await writeTerminalFrames(partial, [frame.slice(cut)]);
          const history = Array.from({ length: partial.buffer.active.baseY }, (_, index) => partial.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n');
          expect(history).not.toMatch(/╭|╰|Thinking/);
          partial.resize(80, 20);
          await writeTerminalFrames(partial, [frame]);
          const buffer = getTerminalText(partial);
          expect(countOccurrences(buffer, '╭'), buffer).toBe(1);
          expect(countOccurrences(buffer, 'Thinking'), buffer).toBe(1);
          expect(buffer).toContain('SHELL_MARKER');
        } finally {
          partial.dispose();
        }
      }
      expect(stdout.frames.join('')).not.toMatch(/\x1b\[(?:2|3)J/);
      app.unmount();
      await app.waitUntilExit();
      await updateTerminal();
      expect(getTerminalText(terminal)).not.toContain('╭');
    } finally {
      app?.unmount();
      await app?.waitUntilExit();
      app?.cleanup();
      if (conversation.submitCalls.length > 0) {
        conversation.resolveWith({ kind: 'assistant_response', content: 'cleanup answer' });
      }
      terminal.dispose();
    }
  });

  it.each([false, true])('should preserve native history across fullscreen transitions and unmount (incremental=%s)', async (incrementalRendering) => {
    const stdout = new ResizableOutput(30, 4);
    const terminal = new Terminal({ allowProposedApi: true, cols: stdout.columns, rows: stdout.rows, convertEol: true });
    const entries: TranscriptEntry[] = [{ role: 'assistant', content: 'committed once' }];
    const fullscreen = Array.from({ length: 4 }, (_, index) => `live fullscreen row ${index}`).join('\n');
    /** Keeps committed entries stable while switching the live region into and out of fullscreen. */
    const tree = (live: string): ReactNode => (
      <>
        <TranscriptView entries={entries} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} />
        <Text>{live}</Text>
      </>
    );
    let app: ReturnType<typeof renderInk> | undefined;
    try {
      await writeTerminalFrames(terminal, ['old shell output\r\n', ...Array<string>(10).fill('shell line\r\n')]);
      app = renderInk(tree(fullscreen), {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new PassThrough() as unknown as NodeJS.WriteStream,
        stdin: createTestInput(),
        exitOnCtrlC: false, interactive: true, incrementalRendering, patchConsole: false,
      });
      await waitForOutput(stdout, (value) => value.includes('live fullscreen row 3'), 'fullscreen frame');
      await flushFrames();
      let processedFrames = stdout.frames.length;
      await writeTerminalFrames(terminal, stdout.frames);
      app.rerender(tree('smaller live frame'));
      await waitForOutput(stdout, (value) => value.includes('smaller live frame'), 'leaving fullscreen');
      await flushFrames();
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames));
      processedFrames = stdout.frames.length;
      expect(getTerminalText(terminal)).not.toContain('live fullscreen row');
      app.rerender(tree(fullscreen));
      await flushFrames();
      app.unmount();
      await app.waitUntilExit();
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames));
      const buffer = getTerminalText(terminal);
      expect(buffer).toContain('old shell output');
      expect(countOccurrences(buffer, 'committed once')).toBe(1);
      expect(countOccurrences(buffer, 'live fullscreen row 0')).toBe(1);
      expect(stdout.frames.join('')).not.toMatch(/\x1b\[(?:2|3)J/);
    } finally {
      app?.unmount();
      await app?.waitUntilExit();
      app?.cleanup();
      terminal.dispose();
    }
  });

  it('should pause live writes during resizing without losing committed output or teardown output', async () => {
    const wideColumns = 40;
    const entries: TranscriptEntry[] = [{ role: 'system', content: 'current mount notice' }];
    const stdout = new ResizableOutput(wideColumns, 12);
    const terminal = new Terminal({
      allowProposedApi: true, cols: wideColumns, rows: stdout.rows, convertEol: true,
    });
    let app: ReturnType<typeof renderInk> | undefined;
    /** Builds separate static and live regions to test output queued during a resize. */
    const tree = (items: readonly TranscriptEntry[], live: string): ReactNode => (
      <>
        <TranscriptView entries={items} userMessageColors={FALLBACK_USER_MESSAGE_COLORS} />
        <Text>{live}</Text>
      </>
    );

    try {
      await writeTerminalFrames(terminal, [
        ...Array.from({ length: 20 }, (_, index) => `old shell line ${index}\r\n`),
      ]);
      app = renderInk(tree(entries, 'live before resize'), {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new PassThrough() as unknown as NodeJS.WriteStream,
        stdin: createTestInput(),
        exitOnCtrlC: false, interactive: true, patchConsole: false,
      });
      await waitForOutput(stdout, (value) => value.includes('live before resize'), 'initial live frame');
      await flushFrames();
      let processedFrames = stdout.frames.length;
      await writeTerminalFrames(terminal, stdout.frames.slice(0, processedFrames));
      const pendingEntries: TranscriptEntry[] = [
        ...entries, { role: 'assistant', content: 'answer during resize' },
      ];
      terminal.resize(24, stdout.rows);
      stdout.resize(24);
      app.rerender(tree(pendingEntries, 'live after resize'));
      // React may commit Static while the output gate is closed; it must be queued.
      expect(stdout.frames.length).toBe(processedFrames);
      await waitForOutput(stdout, (value) => value.includes('answer during resize') && value.includes('live after resize'), 'settled resize');
      const end = stdout.frames.length;
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames, end));
      processedFrames = end;
      let buffer = getTerminalText(terminal);
      expect(buffer).toContain('old shell line 0');
      expect(countOccurrences(buffer, 'current mount notice')).toBe(1);
      expect(countOccurrences(buffer, 'answer during resize')).toBe(1);
      expect(countOccurrences(buffer, 'live after resize')).toBe(1);
      expect(buffer).not.toContain('live before resize');

      terminal.resize(wideColumns, stdout.rows);
      stdout.resize(wideColumns);
      app.rerender(tree([
        ...pendingEntries, { role: 'system', content: 'notice before exit' },
      ], 'final live frame'));
      app.unmount();
      await app.waitUntilExit();
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames));
      buffer = getTerminalText(terminal);
      expect(buffer).toContain('old shell line 0');
      expect(countOccurrences(buffer, 'answer during resize')).toBe(1);
      expect(countOccurrences(buffer, 'notice before exit')).toBe(1);
      expect(stdout.frames.join('')).not.toMatch(/\x1b\[(?:2|3)J/);
      const exitFrames = stdout.frames.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(stdout.frames.length).toBe(exitFrames);
    } finally {
      app?.unmount();
      await app?.waitUntilExit();
      app?.cleanup();
      terminal.dispose();
    }
  });

  it('should redraw the busy status and prompt while /go stays in flight through narrowing and widening', async () => {
    const narrowColumns = 32;
    const wideColumns = 60;
    const pendingPrompt = 'pending prompt wraps when terminal width is narrow';
    const archive = Array.from({ length: 12 }, (_, index) => `busy-archive-${index.toString().padStart(2, '0')}`);
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const stdout = new ResizableOutput(wideColumns, 14);
    const stderr = new PassThrough();
    const originalChalkLevel = chalk.level;
    let app: ReturnType<typeof renderInk> | undefined;
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: wideColumns,
      rows: stdout.rows,
      convertEol: true,
    });
    let processedFrames = 0;

    /** Replays only new PTY frames into the emulator while a /go submission stays in flight. */
    const updateTerminal = async (): Promise<void> => {
      const end = stdout.frames.length;
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames, end));
      processedFrames = end;
    };

    try {
      chalk.level = 3;
      const input = createTestInput();
      app = renderInk(
        <ConversationView
          ui={UI}
          lang="en"
          conversation={conversation}
          userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
          initialEntries={archive.map((content) => ({ role: 'assistant' as const, content }))}
          submitMode="chat"
          autoSubmit={false}
          initialHistory={[]}
          initialDraft={{ text: '', cursor: 0 }}
          initialQueue={[]}
          residentSession={false}
          modelLabel={() => MODEL_LABEL}
          onExit={() => undefined}
        />,
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stderr as unknown as NodeJS.WriteStream,
          stdin: input,
          exitOnCtrlC: false,
          interactive: true,
          patchConsole: false,
        },
      );

      input.write('/go task');
      await flushFrames();
      input.write(ENTER);
      await waitForOutput(stdout, (captured) => captured.includes(UI.thinking), 'busy status');
      input.write(pendingPrompt);
      await waitForOutput(
        stdout,
        (captured) => stripAnsi(captured).replace(/\s+/g, ' ').includes(pendingPrompt),
        'busy prompt',
      );
      await updateTerminal();

      terminal.resize(narrowColumns, stdout.rows);
      const narrowStart = stdout.frames.length;
      stdout.resize(narrowColumns);
      await waitForOutput(
        stdout,
        () => stripAnsi(stdout.frames.slice(narrowStart).join('')).includes('terminal width is narrow'),
        'narrow wrapped prompt redraw',
      );
      await updateTerminal();
      const narrowScreen = stripAnsi(getVisibleTerminalText(terminal, stdout.rows));
      expect(countOccurrences(narrowScreen, 'pending prompt wraps when')).toBe(1);
      expect(narrowScreen.split('\n').some((line) => line.includes('terminal width is narrow'))).toBe(true);
      expect(countOccurrences(narrowScreen, 'terminal width is narrow')).toBe(1);
      expect(countOccurrences(narrowScreen, UI.thinking)).toBe(1);
      expect(countOccurrences(getTerminalText(terminal), UI.thinking)).toBe(1);

      terminal.resize(wideColumns, stdout.rows);
      const wideStart = stdout.frames.length;
      stdout.resize(wideColumns);
      await waitForOutput(
        stdout,
        () => stripAnsi(stdout.frames.slice(wideStart).join('')).includes(pendingPrompt),
        'wide single-row prompt redraw',
      );
      await updateTerminal();
      const wideScreen = stripAnsi(getVisibleTerminalText(terminal, stdout.rows));
      expect(countOccurrences(wideScreen.replace(/\s+/g, ' '), pendingPrompt)).toBe(1);
      expect(countOccurrences(wideScreen, 'terminal width is narrow')).toBe(1);
      expect(wideScreen.split('\n').some((line) => line.includes(pendingPrompt))).toBe(true);
      expect(countOccurrences(wideScreen, UI.thinking)).toBe(1);
      expect(countOccurrences(getTerminalText(terminal), UI.thinking)).toBe(1);

      // A burst finishing at the original width must not draw intermediate frames
      // or erase history. The final live prompt is drawn after the quiet period.
      const resizeFrames: Array<{ columns: number; frames: string[] }> = [];
      for (const columns of [48, 24, 40, wideColumns]) {
        const start = stdout.frames.length;
        stdout.resize(columns);
        resizeFrames.push({ columns, frames: stdout.frames.slice(start) });
      }
      const burstEnd = stdout.frames.length;
      for (const { columns, frames } of resizeFrames) {
        terminal.resize(columns, stdout.rows);
        await writeTerminalFrames(terminal, frames);
      }
      processedFrames = burstEnd;
      await waitForOutput(
        stdout,
        () => stdout.frames.length > burstEnd,
        'redraw after rapid resizing stops',
      );
      await updateTerminal();
      const buffer = getTerminalText(terminal);
      for (const entry of archive) {
        expect(countOccurrences(buffer, entry), buffer).toBe(1);
      }
      expect(countOccurrences(buffer, '/go task')).toBe(1);
      expect(countOccurrences(buffer, UI.thinking), buffer).toBe(1);
      expect(countOccurrences(buffer.replace(/\s+/g, ' '), pendingPrompt), buffer).toBe(1);
      expect(conversation.instructionCalls).toHaveLength(0);
      expect(conversation.submitCalls).toHaveLength(1);
      expect(stdout.frames.join('')).not.toMatch(/\x1b\[(?:2|3)J/);
    } finally {
      app?.unmount();
      await app?.waitUntilExit();
      app?.cleanup();
      terminal.dispose();
      chalk.level = originalChalkLevel;
    }
  });

  it.each([false, true])('should clear reflowed rows above and below a hardware cursor (incremental=%s)', async (incrementalRendering) => {
    const wideColumns = 20;
    const narrowColumns = 5;
    const firstRow = 'abcdefghijklm';
    const cursorRow = 'cursor';
    const lastRow = 'stale tail';
    const stdout = new ResizableOutput(wideColumns);
    const stderr = new PassThrough();
    const input = createTestInput();
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: wideColumns,
      rows: stdout.rows,
      convertEol: true,
    });
    let processedFrames = 0;
    let app: ReturnType<typeof renderInk> | undefined;

    /** Places a hardware cursor beneath a width-dependent row to expose stale reflowed tails. */
    function CursorPositionedOutput({ tail }: { readonly tail: string }): ReactNode {
      const { columns } = useWindowSize();
      const { setCursorPosition } = useCursor();
      setCursorPosition({ x: 0, y: Math.ceil(firstRow.length / columns) });
      return <Text>{`${firstRow}\n${cursorRow}\n${tail}`}</Text>;
    }

    /** Applies new output before checking the hardware cursor and remaining visible text. */
    const updateTerminal = async (): Promise<void> => {
      const end = stdout.frames.length;
      await writeTerminalFrames(terminal, stdout.frames.slice(processedFrames, end));
      processedFrames = end;
    };

    try {
      app = renderInk(<CursorPositionedOutput tail={lastRow} />, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        stdin: input,
        exitOnCtrlC: false,
        interactive: true,
        incrementalRendering,
        patchConsole: false,
      });
      await waitForOutput(stdout, (captured) => captured.includes(lastRow), 'initial cursor output');
      await updateTerminal();
      expect(terminal.buffer.active.cursorY).toBe(1);

      terminal.resize(narrowColumns, stdout.rows);
      const narrowStart = stdout.frames.length;
      stdout.resize(narrowColumns);
      app.rerender(<CursorPositionedOutput tail="fresh" />);
      await waitForOutput(
        stdout,
        () => stdout.frames.length > narrowStart,
        'narrow cursor redraw',
      );
      await flushFrames();
      await updateTerminal();

      const screen = stripAnsi(getVisibleTerminalText(terminal, stdout.rows)).replace(/\s/g, '');
      expect(terminal.buffer.active.cursorY, screen).toBe(3);
      expect(screen).toBe(`${firstRow}${cursorRow}fresh`);
    } finally {
      app?.unmount();
      await app?.waitUntilExit();
      app?.cleanup();
      terminal.dispose();
    }
  });

  it('should use the resolved background and terminal-default foreground in the user band', () => {
    const output = renderWithColors(
      <TranscriptEntryView
        entry={{ role: 'user', content: 'submitted message' }}
        userMessageColors={THEMED_USER_MESSAGE_COLORS}
      />,
      24,
    );
    const [, content] = output.split('\n');

    expect(output).toContain('\x1b[48;2;215;215;215m');
    expect(content?.startsWith('\x1b[48;2;215;215;215m')).toBe(true);
    expect(stripAnsi(output)).toContain('❯ submitted message');
    expect(output).not.toContain(USER_MESSAGE_FOREGROUND);
    expect(output).not.toContain(USER_MESSAGE_BACKGROUND);
  });

  it('should apply the submitted-message band only to user transcript entries', () => {
    const user = renderWithColors(
      <TranscriptEntryView
        entry={{ role: 'user', content: 'submitted' }}
        userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
      />,
      30,
    );
    const assistant = renderWithColors(
      <TranscriptEntryView
        entry={{ role: 'assistant', content: 'answer' }}
        userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
      />,
      30,
    );
    const system = renderWithColors(
      <TranscriptEntryView
        entry={{ role: 'system', content: 'notice' }}
        userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
      />,
      30,
    );
    const draft = renderWithColors(
      <PromptInput
        text="not submitted"
        cursor={13}
        contentWidth={24}
        placeholder="Type a message"
        hint="Enter: send"
        completions={[]}
        completionIndex={0}
        disabled={false}
      />,
      30,
    );

    expect(user).toContain(USER_MESSAGE_BACKGROUND);
    expect(assistant).not.toContain(USER_MESSAGE_BACKGROUND);
    expect(system).not.toContain(USER_MESSAGE_BACKGROUND);
    expect(draft).not.toContain(USER_MESSAGE_BACKGROUND);
    expect(stripAnsi(assistant).trimEnd()).toBe('● answer');
    expect(stripAnsi(system).trimEnd()).toBe('  notice');
  });
});

describe('TranscriptView', () => {
  it.each([
    { columns: 24, content: 'hello', expectedLines: ['hello'] },
    { columns: 80, content: 'hello', expectedLines: ['hello'] },
    {
      columns: 14,
      content: 'alpha beta gamma delta',
      expectedLines: ['alpha beta', 'gamma delta'],
    },
    {
      columns: 14,
      content: '日本語の発言です\n次の行',
      expectedLines: ['日本語の発言', 'です', '次の行'],
    },
  ])('should fill $columns terminal columns with the submitted user band for "$content"', ({ columns, content, expectedLines }) => {
    const background = '\x1b[48;2;215;215;215m';
    const output = renderWithColors(
      <TranscriptView
        entries={[{ role: 'user', content }]}
        userMessageColors={THEMED_USER_MESSAGE_COLORS}
      />,
      columns,
    );
    const rows = output.split('\n');
    const bandRows = rows.filter((row) => row.includes(background));

    expect(bandRows).toHaveLength(expectedLines.length + 2);
    for (const row of bandRows) {
      expect(row.startsWith(background)).toBe(true);
      expect(stringWidth(stripAnsi(row))).toBe(columns);
    }
    expect(stripAnsi(bandRows[0]!)).toBe(' '.repeat(columns));
    expect(stripAnsi(bandRows.at(-1)!)).toBe(' '.repeat(columns));
    expect(bandRows.slice(1, -1).map((row) => stripAnsi(row).trim().replace(/^❯\s*/, ''))).toEqual(expectedLines);
    expect(rows.slice(bandRows.length).every((row) => !row.includes(background))).toBe(true);
  });
});

describe('ConversationView', () => {
  it('refreshes workflow status without replacing the conversation and stops on unmount', async () => {
    vi.useFakeTimers();
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    let status = 'run: running';
    const reader = vi.fn(() => status);
    const view = renderConversation(conversation, 'chat', vi.fn(), {
      liveStatusReader: reader,
      liveStatusRefreshIntervalMs: 250,
    });
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(view.lastFrame()).toContain('run: running');
      status = 'run: completed';
      await vi.advanceTimersByTimeAsync(250);
      expect(view.lastFrame()).toContain('run: completed');
      expect(view.lastFrame()).not.toContain('run: running');
      expect(reader).toHaveBeenCalledTimes(2);
      expect(conversation.submitCalls).toEqual([]);
      view.unmount();
      await vi.advanceTimersByTimeAsync(50);
      const readsAfterUnmount = reader.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(reader).toHaveBeenCalledTimes(readsAfterUnmount);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it.each([
    ['/workflow', { kind: 'handoff', id: 'workflow' }],
    ['/interaction', { kind: 'handoff', id: 'mode' }],
    ['/provider', { kind: 'handoff', id: 'provider' }],
    ['/model custom-model', { kind: 'handoff', id: 'model', text: 'custom-model' }],
    ['/effort custom-effort', { kind: 'handoff', id: 'effort', text: 'custom-effort' }],
    ['/tell skip Android support', { kind: 'handoff', id: 'tell', text: 'skip Android support' }],
  ] as const)('should hand off a real resident command input without calling AI: %s', async (
    input,
    expected,
  ) => {
    const setupProvider = vi.fn(() => ({
      call: vi.fn(() => Promise.reject(new Error('setting commands must not call AI'))),
    }));
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: {
        ctx: {
          provider: makeProvider({ setup: setupProvider }),
          providerType: 'mock',
          model: 'mock-model',
          lang: 'en',
          personaName: 'interactive',
          sessionId: undefined,
        },
        strategy: {
          systemPrompt: 'system prompt',
          formalSpec: false,
          modelCheckTimeoutSeconds: 300,
          allowedTools: [],
          transformPrompt: (message: string) => message,
          introMessage: 'Interactive mode',
          enableTellCommand: true,
        },
      },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
      enableSettingsCommands: true,
    });
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit, { residentSession: true });
    await flushFrames();

    app.stdin.write(input);
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      expected,
      expect.objectContaining({ history: [input], queue: [] }),
    );
    expect(setupProvider).not.toHaveBeenCalled();

    app.unmount();
  });

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
    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'resume_session' },
      expect.objectContaining({ history: ['/resume'], queue: [] }),
    );
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

  it('should keep a real store usable across a command hand-off and its remount', async () => {
    // Exec's `/setup` and `/go` leave through a hand-off, and exec has no
    // dispatch of its own, so this runs the way that run mounts the view.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'takt-cv-setup-'));
    const store = createImageAttachmentStore({ tmpRoot, sessionId: 'session-1' });
    const scripted = createScriptedConversation(
      new Map<string, TuiLocalCommand>([['/setup', { kind: 'handoff', id: 'exec-setup' }]]),
      NO_ORDER_COMMANDS,
    );
    const conversation = {
      ...scripted,
      sealImages: () => store.seal(),
      saveInlineImage: async (image: PastedImage): Promise<string> => {
        const saved = await store.saveImage(image.data, image.mimeType);
        return saved.placeholder;
      },
    };
    // Pasted earlier in this mount, so its file has to outlive the hand-off.
    const pastedBefore = await store.saveImage(PNG_BYTES, 'image/png');

    const mounted: ReturnType<typeof renderConversation>[] = [];
    try {
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit, { residentSession: false });
      mounted.push(app);
      await flushFrames();

      app.stdin.write('/setup');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      expect(onExit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'handoff', id: 'exec-setup' }),
        expect.anything(),
      );
      app.unmount();
      await flushFrames();

      // The menu ran on the bare terminal and the conversation is mounted again.
      const resumed = renderConversation(conversation, 'chat', vi.fn(), { residentSession: false });
      mounted.push(resumed);
      await flushFrames();
      resumed.stdin.write(INLINE_IMAGE_PASTE);
      await flushFrames();

      // Both files are there: nothing sealed the store on the way through.
      expect(readdirSync(join(tmpRoot, 'session-1', 'attachments'))).toHaveLength(2);
      expect(existsSync(pastedBefore.tempPath)).toBe(true);
    } finally {
      // A failed assertion must not leave an Ink tree holding stdin, or a temp
      // directory behind: unmounting twice is safe, so every mount is released.
      for (const app of mounted) {
        app.unmount();
      }
      cleanupImageAttachmentStore(store);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
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
    try {
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
    } finally {
      app.unmount();
      cleanupImageAttachmentStore(store);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
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
      { modelLabel: () => 'Model: mock/\u001b[31mred\nsecond line' },
    );
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Model: mock/red second line');
    expect(frame).not.toContain('\u001b[31m');

    app.unmount();
  });

  describe('queueing while the assistant answers', () => {
    /** Submits `text` and leaves the view busy on an unsettled submission. */
    async function startBusyTurn(app: ReturnType<typeof renderConversation>): Promise<void> {
      app.stdin.write('first question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
    }

    it('should keep the draft editable and queue what is submitted while busy', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();
      await startBusyTurn(app);

      // Typing during the answer edits the draft as usual.
      app.stdin.write('queued one');
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('❯ queued one');

      app.stdin.write(ENTER);
      await flushFrames();

      // Nothing was sent: the line waits above the prompt, with its hint.
      expect(conversation.submitCalls).toHaveLength(1);
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('queued one');
      expect(frame).toContain(UI.queuedHint);
      expect(frame).toContain(UI.placeholder);

      app.unmount();
    });

    it('should send the queued lines as one turn when the answer lands', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();
      await startBusyTurn(app);

      app.stdin.write('queued one');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('queued two');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // The two plain lines were written as one thought, so they go out as one.
      expect(conversation.submitCalls).toHaveLength(2);
      expect(conversation.submitCalls[1]?.text).toBe('queued one\nqueued two');
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('❯ queued one');
      expect(frame).not.toContain(UI.queuedHint);

      app.unmount();
    });

    it('should leave the half-typed line alone when the queue goes out', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();
      await startBusyTurn(app);

      for (const line of ['queued one', 'queued two']) {
        app.stdin.write(line);
        await flushFrames();
        app.stdin.write(ENTER);
        await flushFrames();
      }

      // Still typing when the answer lands, with the caret left inside the word.
      app.stdin.write('half typed');
      await flushFrames();
      app.stdin.write(ARROW_LEFT.repeat(5));
      await flushFrames();

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // The queue went out on its own; only what the user handed over is sent.
      expect(conversation.submitCalls).toHaveLength(2);
      expect(conversation.submitCalls[1]?.text).toBe('queued one\nqueued two');

      // The draft is still there, and the caret is still where it was left: the
      // next character lands inside the word rather than at the end.
      expect(app.lastFrame() ?? '').toContain('❯ half typed');
      app.stdin.write('X');
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('❯ half Xtyped');

      app.unmount();
    });

    it.each([
      {
        name: 'a hand-off',
        input: '/go',
        command: { kind: 'handoff', id: 'exec-go' } as TuiLocalCommand,
        expected: { kind: 'handoff', id: 'exec-go' },
      },
      {
        name: 'the session picker',
        input: '/resume',
        command: { kind: 'resume_session' } as TuiLocalCommand,
        expected: { kind: 'resume_session' },
      },
    ])('should hand the half-typed line over when the queue reaches $name', async ({
      input,
      command,
      expected,
    }) => {
      const conversation = createScriptedConversation(
        new Map<string, TuiLocalCommand>([[input, command]]),
        NO_ORDER_COMMANDS,
      );
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      await flushFrames();
      await startBusyTurn(app);

      // The command waits behind the answer, and the next line is still being
      // written when the answer lands and the queue moves.
      app.stdin.write(input);
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('half typed');
      await flushFrames();
      app.stdin.write(ARROW_LEFT.repeat(5));
      await flushFrames();

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // The mount ends, and what the user had reached goes with it so the next
      // one can put it back.
      expect(onExit).toHaveBeenCalledExactlyOnceWith(
        expected,
        expect.objectContaining({ draft: { text: 'half typed', cursor: 5 } }),
      );

      app.unmount();
    });

    it('should keep a line that only looks like a command with the text', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();
      await startBusyTurn(app);

      for (const line of ['/usr/bin/env is missing', 'and so is /opt/homebrew']) {
        app.stdin.write(line);
        await flushFrames();
        app.stdin.write(ENTER);
        await flushFrames();
      }

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // Neither line names a command, so both belong to the same message.
      expect(conversation.submitCalls).toHaveLength(2);
      expect(conversation.submitCalls[1]?.text)
        .toBe('/usr/bin/env is missing\nand so is /opt/homebrew');

      app.unmount();
    });

    it('should carry on with the queue after a queued local command', async () => {
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
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();
      await startBusyTurn(app);

      for (const line of ['/paste-image', 'after the paste']) {
        app.stdin.write(line);
        await flushFrames();
        app.stdin.write(ENTER);
        await flushFrames();
      }

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // The command ran and the line behind it went out rather than waiting
      // for a keystroke that never comes.
      expect(conversation.submitCalls[1]?.text).toBe('after the paste');
      expect(app.lastFrame() ?? '').not.toContain(UI.queuedHint);

      releasePaste();
      await flushFrames();
      app.unmount();
    });

    it('should queue the second of two Enters that arrive before a re-render', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('first question');
      await flushFrames();
      // Two submissions with no frame in between: the second must see the call
      // the first one started, not the flag React has yet to re-render.
      app.stdin.write(ENTER);
      app.stdin.write('second question');
      app.stdin.write(ENTER);
      await flushFrames();

      expect(conversation.submitCalls).toHaveLength(1);
      expect(conversation.submitCalls[0]?.text).toBe('first question');
      expect(app.lastFrame() ?? '').toContain(UI.queuedHint);

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();
      expect(conversation.submitCalls[1]?.text).toBe('second question');

      app.unmount();
    });

    it('should send three queued lines as one message', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();
      await startBusyTurn(app);

      for (const line of ['first thought', 'second thought', 'third thought']) {
        app.stdin.write(line);
        await flushFrames();
        app.stdin.write(ENTER);
        await flushFrames();
      }
      expect(conversation.submitCalls).toHaveLength(1);

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // One turn, not three: the lines were written as one thought.
      expect(conversation.submitCalls).toHaveLength(2);
      expect(conversation.submitCalls[1]?.text)
        .toBe('first thought\nsecond thought\nthird thought');

      conversation.resolveWith({ kind: 'assistant_response', content: 'second answer' });
      await flushFrames();
      // Nothing was left behind to send afterwards.
      expect(conversation.submitCalls).toHaveLength(2);

      app.unmount();
    });

    it('should send a queued command on its own, after the lines before it', async () => {
      const conversation = createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/accept', { kind: 'execute', task: 'run it' }]]),
        NO_ORDER_COMMANDS,
      );
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      await flushFrames();
      await startBusyTurn(app);

      app.stdin.write('queued text');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('/accept');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // The plain line goes first, on its own turn; the command still waits.
      expect(conversation.submitCalls[1]?.text).toBe('queued text');
      expect(onExit).not.toHaveBeenCalled();

      conversation.resolveWith({ kind: 'assistant_response', content: 'second answer' });
      await flushFrames();

      expect(onExit).toHaveBeenCalledExactlyOnceWith(
        { kind: 'result', result: { action: 'execute', task: 'run it' } },
        expect.objectContaining({ history: expect.any(Array) }),
      );

      app.unmount();
    });

    it('should run /cancel immediately instead of queueing it', async () => {
      const conversation = createScriptedConversation(
        new Map<string, TuiLocalCommand>([['/cancel', { kind: 'cancel' }]]),
        NO_ORDER_COMMANDS,
      );
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      await flushFrames();
      await startBusyTurn(app);

      app.stdin.write('queued one');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('/cancel');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      // The exit drains the turn that was still running.
      conversation.resolveWith({ kind: 'assistant_response', content: 'ignored' });
      await flushFrames();

      expect(onExit).toHaveBeenCalledExactlyOnceWith(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        expect.objectContaining({ history: expect.any(Array) }),
      );
      // The run ended, so the queued line is gone with it.
      expect(conversation.submitCalls).toHaveLength(1);

      app.unmount();
    });

    it('should drop the queue when Ctrl+C ends the run', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      await flushFrames();
      await startBusyTurn(app);

      app.stdin.write('queued one');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write(CTRL_C);
      await flushFrames();
      conversation.resolveWith({ kind: 'assistant_response', content: 'ignored' });
      await flushFrames();

      expect(onExit).toHaveBeenCalledExactlyOnceWith(
        { kind: 'result', result: { action: 'cancel', task: '' } },
        expect.objectContaining({ history: expect.any(Array) }),
      );
      expect(conversation.submitCalls).toHaveLength(1);

      app.unmount();
    });

    it('should take the last queued line back into the draft on Up', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();
      await startBusyTurn(app);

      app.stdin.write('queued one');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('queued two');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();

      app.stdin.write(ARROW_UP);
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('❯ queued two');

      app.stdin.write(' amended');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await flushFrames();

      // The edited line went back to the end of the queue, so it lands last.
      expect(conversation.submitCalls[1]?.text).toBe('queued one\nqueued two amended');

      app.unmount();
    });

    it('should recall the history with Up once the queue is empty', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn(), {
        initialHistory: ['remembered'],
      });
      await flushFrames();
      // Submitting puts the line in the history, so it is the newest entry.
      await startBusyTurn(app);

      app.stdin.write(ARROW_UP);
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('❯ first question');

      app.stdin.write(ARROW_UP);
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('❯ remembered');

      app.unmount();
    });
  });

  describe('interrupting with Esc', () => {
    it('should abort the call, note it and leave the session usable', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      conversation.submitCalls[0]?.onAssistantChunk('half an answer');
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('half an answer');

      app.stdin.write(ESC);
      await flushFrames();

      // The call was aborted, the partial answer dropped, and the note left.
      expect(conversation.submitCalls[0]?.abortSignal.aborted).toBe(true);
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain(UI.responseInterrupted);
      expect(frame).not.toContain('half an answer');
      expect(frame).not.toContain(UI.thinking);
      expect(onExit).not.toHaveBeenCalled();

      // The session is still there: the next line is sent as usual.
      app.stdin.write('another question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      expect(conversation.submitCalls).toHaveLength(2);

      app.unmount();
    });

    it('should ignore the answer that lands after an interrupt', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write(ESC);
      await flushFrames();

      // The provider ignored the abort and answered anyway.
      conversation.resolveWith({ kind: 'assistant_response', content: 'too late' });
      await flushFrames();

      expect(app.lastFrame() ?? '').not.toContain('too late');

      app.unmount();
    });

    it('should not commit the answer that lands after an interrupt', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write(ESC);
      await flushFrames();

      // An adapter that keeps its own transcript is told to record a turn only
      // when the view accepts it; this one the user stopped.
      const commit = vi.fn();
      conversation.resolveWith({ kind: 'assistant_response', content: 'too late', commit });
      await flushFrames();

      expect(commit).not.toHaveBeenCalled();

      app.unmount();
    });

    it('should commit an answer the view accepts', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();

      const commit = vi.fn();
      conversation.resolveWith({ kind: 'assistant_response', content: 'an answer', commit });
      await flushFrames();

      expect(commit).toHaveBeenCalledTimes(1);
      expect(app.lastFrame() ?? '').toContain('an answer');

      app.unmount();
    });

    it('should name the interrupted work when /go was running', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('/go');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write(ESC);
      await flushFrames();

      const frame = app.lastFrame() ?? '';
      expect(frame).toContain(UI.instructionInterrupted);
      expect(frame).not.toContain(UI.responseInterrupted);

      app.unmount();
    });

    it('should send what was queued as soon as the answer is interrupted', async () => {
      const { call, store, conversation, settlePending } = createPendingProviderConversation();
      const app = renderConversation(conversation, 'chat', vi.fn());
      try {
        await flushFrames();

        app.stdin.write('a question');
        await flushFrames();
        app.stdin.write(ENTER);
        await flushFrames();
        app.stdin.write('queued line');
        await flushFrames();
        app.stdin.write(ENTER);
        await flushFrames();

        app.stdin.write(ESC);
        await flushFrames();

        expect(call).toHaveBeenCalledTimes(2);
        expect(conversation.snapshotHistory?.()).toEqual([
          { role: 'user', content: 'a question' },
          { role: 'user', content: 'queued line' },
        ]);
        const frame = stripAnsi(app.lastFrame() ?? '');
        expect(frame).toContain(UI.responseInterrupted);
        expect(frame).toContain('❯ queued line');
        expect(frame.split('\n').filter((line) => line.trim() === '❯ a question')).toHaveLength(1);
        expect(frame.split('\n').filter((line) => line.trim() === '❯ queued line')).toHaveLength(1);
        expect(frame).not.toContain(UI.queuedHint);
        expectUndeliveredPrompt(String(call.mock.calls[1]?.[0]), ['a question'], 'queued line');
      } finally {
        app.unmount();
        settlePending();
        cleanupImageAttachmentStore(store);
      }
    });

    it('should exit after an interrupt without automatically resending the user message', async () => {
      const { call, store, conversation, settlePending } = createPendingProviderConversation();
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      try {
        await flushFrames();
        app.stdin.write('A');
        await flushFrames();
        app.stdin.write(ENTER);
        await flushFrames();
        app.stdin.write(ESC);
        await flushFrames();
        settlePending();
        await flushFrames();
        app.stdin.write(CTRL_D);
        await flushFrames();
        expect(onExit).toHaveBeenCalledOnce();
        expect(onExit.mock.calls[0]?.[0]).toMatchObject({ kind: 'result', result: { action: 'cancel' } });
        expect(call).toHaveBeenCalledTimes(1);
        expect(conversation.snapshotHistory?.()).toEqual([{ role: 'user', content: 'A' }]);
      } finally {
        app.unmount();
        settlePending();
        cleanupImageAttachmentStore(store);
      }
    });

    it('should leave the half-typed line alone when the interrupt drains the queue', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('queued line');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();

      // Esc arrives with the next line half typed and the caret inside it.
      app.stdin.write('half typed');
      await flushFrames();
      app.stdin.write(ARROW_LEFT.repeat(5));
      await flushFrames();
      app.stdin.write(ESC);
      await flushFrames();

      expect(conversation.submitCalls).toHaveLength(2);
      expect(conversation.submitCalls[1]?.text).toBe('queued line');

      app.stdin.write('X');
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('❯ half Xtyped');

      app.unmount();
    });

    it('should return to an idle prompt when nothing was queued', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write(ESC);
      await flushFrames();

      expect(conversation.submitCalls).toHaveLength(1);
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain(UI.responseInterrupted);
      expect(frame).not.toContain(UI.thinking);
      expect(frame).toContain(UI.placeholder);

      app.unmount();
    });

    it('should let the turn a drain started be interrupted in its turn', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('queued line');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();

      app.stdin.write(ESC);
      await flushFrames();
      expect(conversation.submitCalls).toHaveLength(2);

      // The queued line is now the running turn, and Esc stops that one too.
      app.stdin.write(ESC);
      await flushFrames();
      expect(conversation.submitCalls[1]?.abortSignal.aborted).toBe(true);
      const frame = app.lastFrame() ?? '';
      // Counted by splitting rather than by regex: the label is i18n text and
      // its punctuation would be read as pattern syntax.
      expect(frame.split(UI.responseInterrupted)).toHaveLength(3);
      expect(frame).not.toContain(UI.thinking);

      app.unmount();
    });

    it('should close the completion list before it interrupts anything', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const app = renderConversation(conversation, 'chat', vi.fn());
      await flushFrames();

      app.stdin.write('a question');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      // A slash draft opens the list while the answer is still running.
      app.stdin.write('/');
      await flushFrames();
      expect(app.lastFrame() ?? '').toContain('/cancel');

      app.stdin.write(ESC);
      await flushFrames();

      // The list is gone and the call is untouched.
      const frame = app.lastFrame() ?? '';
      expect(frame).not.toContain('/cancel');
      expect(frame).toContain(UI.thinking);
      expect(conversation.submitCalls[0]?.abortSignal.aborted).toBe(false);

      // A second Esc reaches the call.
      app.stdin.write(ESC);
      await flushFrames();
      expect(conversation.submitCalls[0]?.abortSignal.aborted).toBe(true);

      app.unmount();
    });

    it('should do nothing on Esc while the prompt is idle', async () => {
      const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
      const onExit = vi.fn();
      const app = renderConversation(conversation, 'chat', onExit);
      await flushFrames();

      app.stdin.write('draft text');
      await flushFrames();
      app.stdin.write(ESC);
      await flushFrames();

      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('❯ draft text');
      expect(frame).not.toContain(UI.responseInterrupted);
      expect(onExit).not.toHaveBeenCalled();

      app.unmount();
    });

    it('should stop taking keys once it hands the terminal to a selector', async () => {
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

      // A capture keeps the hand-off waiting, which is the window under test.
      app.stdin.write('/paste-image');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      app.stdin.write('summarize this');
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
      conversation.resolveWith({ kind: 'task_instruction', task: 'run it' });
      await flushFrames();

      // The decision is made: keystrokes are dropped from here on.
      app.stdin.write('ignored while leaving');
      await flushFrames();
      app.stdin.write(ESC);
      await flushFrames();
      expect(app.lastFrame() ?? '').not.toContain('ignored while leaving');

      releasePaste();
      await flushFrames();
      expect(onExit).toHaveBeenCalledExactlyOnceWith(
        { kind: 'choose_action', task: 'run it' },
        expect.objectContaining({ history: expect.any(Array) }),
      );

      app.unmount();
    });
  });

  it('should put what the call reported alongside the answer into the transcript', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('look at the screenshot');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    conversation.resolveWith({
      kind: 'assistant_response',
      content: 'an answer',
      notices: ['Provider "opencode" does not support native image input; image paths were added to the prompt.'],
    });
    await flushFrames();

    const frame = app.lastFrame() ?? '';
    // The note stands above the answer it came with.
    expect(frame).toContain('does not support native image input');
    expect(frame).toContain('● an answer');
    expect(frame.indexOf('native image input')).toBeLessThan(frame.indexOf('● an answer'));

    app.unmount();
  });

  it('should keep the image store open when the caller carries the decision out', async () => {
    // A resident session runs the decision and mounts this view again, so the
    // store it pastes into has to survive the exit.
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([['/accept', { kind: 'execute', task: 'run it' }]]),
      NO_ORDER_COMMANDS,
    );
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit, { residentSession: true });
    await flushFrames();

    app.stdin.write('/accept');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'execute', task: 'run it' } },
      expect.objectContaining({ history: expect.any(Array) }),
    );
    expect(conversation.sealCalls, 'the next mount pastes into this store').toEqual([]);
    app.unmount();
    expect(conversation.sealCalls).toEqual([]);

    // The mount that follows can still paste.
    const resumed = renderConversation(conversation, 'chat', vi.fn(), { residentSession: true });
    await flushFrames();
    resumed.stdin.write(INLINE_IMAGE_PASTE);
    await flushFrames();
    expect(conversation.savedImages).toHaveLength(1);

    resumed.unmount();
  });

  it('should seal on a finished decision when nothing follows it', async () => {
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([['/accept', { kind: 'execute', task: 'run it' }]]),
      NO_ORDER_COMMANDS,
    );
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('/accept');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    expect(conversation.sealCalls.length).toBeGreaterThan(0);

    app.unmount();
  });

  it('should keep a provider failure in the transcript when the queue moves on', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('a question');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    app.stdin.write('queued line');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();

    conversation.resolveWith({ kind: 'error', message: 'opencode: model is not available' });
    await flushFrames();

    // The queue started the next turn, and the reason is still readable.
    expect(conversation.submitCalls).toHaveLength(2);
    expect(app.lastFrame() ?? '').toContain('opencode: model is not available');

    app.unmount();
  });

  it('should carry lines a hand-off cut short into the next mount', async () => {
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([['/go', { kind: 'choose_action', task: 'do it' }]]),
      NO_ORDER_COMMANDS,
    );
    const onExit = vi.fn();
    const app = renderConversation(conversation, 'chat', onExit);
    await flushFrames();

    app.stdin.write('a question');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    for (const line of ['/go', 'after the go']) {
      app.stdin.write(line);
      await flushFrames();
      app.stdin.write(ENTER);
      await flushFrames();
    }

    conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
    await flushFrames();

    // `/go` drained first and hands the terminal over; the line behind it waits.
    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'choose_action', task: 'do it' },
      expect.objectContaining({ queue: ['after the go'] }),
    );
    app.unmount();

    // The next mount sends it without another keystroke.
    const continued = renderConversation(conversation, 'chat', vi.fn(), {
      initialQueue: ['after the go'],
    });
    await flushFrames();
    expect(conversation.submitCalls[1]?.text).toBe('after the go');

    continued.unmount();
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

  it('should show the rebuilt session model after a submission settles', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    let currentModel = 'Model: mock/old-model';
    const app = renderConversation(conversation, 'chat', vi.fn(), {
      modelLabel: () => currentModel,
    });
    await flushFrames();

    expect(app.lastFrame()).toContain('Model: mock/old-model');
    app.stdin.write('use the new model');
    await flushFrames();
    app.stdin.write(ENTER);
    await flushFrames();
    currentModel = 'Model: mock/new-model';
    conversation.resolveWith({ kind: 'assistant_response', content: 'done' });
    await flushFrames();

    expect(app.lastFrame()).toContain('Model: mock/new-model');
    expect(app.lastFrame()).not.toContain('Model: mock/old-model');

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

  it('should start with the carried draft and its caret where it was left', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const app = renderConversation(conversation, 'chat', vi.fn(), {
      initialDraft: { text: 'half typed', cursor: 5 },
    });
    await flushFrames();

    expect(app.lastFrame() ?? '').toContain('❯ half typed');

    // Typing continues from the caret, not from the end of the restored line.
    app.stdin.write('X');
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('❯ half Xtyped');

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

    expect(onExit).toHaveBeenCalledExactlyOnceWith({ kind: 'failed', error: failure }, expect.objectContaining({ history: expect.any(Array) }));

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
      expect.objectContaining({ history: expect.any(Array) }),
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
      expect.objectContaining({ history: expect.any(Array) }),
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
      expect.objectContaining({ history: expect.any(Array) }),
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
      expect.objectContaining({ history: expect.any(Array) }),
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
      input: '/accept',
      command: { kind: 'execute', task: 'run it' },
      expected: { kind: 'result', result: { action: 'execute', task: 'run it' } },
    },
    {
      name: 'choose_action',
      input: '/retry',
      command: { kind: 'choose_action', task: 'previous order', origin: 'retry' },
      expected: { kind: 'choose_action', task: 'previous order', origin: 'retry' },
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

      expect(onExit).toHaveBeenCalledExactlyOnceWith(expected, expect.objectContaining({ history: expect.any(Array) }));
      expect(conversation.submitCalls).toHaveLength(0);
      // Resuming is the surrounding TUI's job; this view only reports the intent.
      expect(conversation.resumedSessions).toHaveLength(0);
      expect(app.frames.join('\n')).not.toContain('Thinking...');

      app.unmount();
    },
  );

  it('should publish the command path only where the mode records it', async () => {
    const command: TuiLocalCommand = { kind: 'execute', task: 'previous order', origin: 'replay' };
    const plain = createScriptedConversation(new Map([['/replay', command]]), NO_ORDER_COMMANDS);
    const plainExit = vi.fn();
    const plainApp = renderConversation(plain, 'chat', plainExit);
    await flushFrames();
    plainApp.stdin.write('/replay');
    await flushFrames();
    plainApp.stdin.write(ENTER);
    await flushFrames();

    expect(plainExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'execute', task: 'previous order' } },
      expect.anything(),
    );
    plainApp.unmount();

    const recording = {
      ...createScriptedConversation(new Map([['/replay', command]]), NO_ORDER_COMMANDS),
      tracksResultSource: true,
    };
    const recordingExit = vi.fn();
    const recordingApp = renderConversation(recording, 'chat', recordingExit);
    await flushFrames();
    recordingApp.stdin.write('/replay');
    await flushFrames();
    recordingApp.stdin.write(ENTER);
    await flushFrames();

    // The caller decides what to do with the task by where it came from.
    expect(recordingExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'result', result: { action: 'execute', task: 'previous order', source: 'replay' } },
      expect.anything(),
    );
    recordingApp.unmount();
  });

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
      expect.objectContaining({ history: expect.any(Array) }),
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
      expect.objectContaining({ history: expect.any(Array) }),
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

    conversation.resolveWith({
      kind: 'task_instruction',
      task: 'Add a cache layer',
      notices: ['native image input'],
    });
    await flushFrames();

    expect(onExit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'choose_action', task: 'Add a cache layer' },
      expect.objectContaining({ history: expect.any(Array) }),
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
    expect(onExit).toHaveBeenCalledWith({ kind: 'choose_action', task: 'seeded instruction' }, expect.objectContaining({ history: expect.any(Array) }));

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
    try {
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
      expect(existsSync(join(tmpRoot, 'session-1'))).toBe(false);
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      app.unmount();
      cleanupImageAttachmentStore(store);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
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
      expect.objectContaining({ history: expect.any(Array) }),
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
      expect.objectContaining({ history: ['/paste-image', 'summarize this'], queue: [] }),
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
      expect.objectContaining({ history: expect.any(Array) }),
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
      expect.objectContaining({ history: expect.any(Array) }),
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

    expect(onExit).toHaveBeenCalledWith(
      { kind: 'choose_action', task: 'do it' },
      expect.objectContaining({ history: ['first turn'], queue: [] }),
    );
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
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, {
      ...NO_ORDER_COMMANDS,
      enableTellCommand: true,
      enableSettingsCommands: true,
    });
    const app = renderConversation(conversation, 'chat', vi.fn());
    await flushFrames();

    app.stdin.write('/');
    await flushFrames();

    const completionFrame = app.lastFrame() ?? '';
    expect(completionFrame).toContain('❯ /accept');
    expect(completionFrame).toContain('/go');
    expect(completionFrame).toContain('/tell');
    expect(completionFrame).toContain('/cancel');
    expect(completionFrame).toContain('/workflow');
    expect(completionFrame).toContain('/interaction');
    expect(completionFrame).toContain('/provider');
    expect(completionFrame).toContain('/model');
    expect(completionFrame).toContain('/effort');
    // Both order commands are unavailable in this run, so they stay out of the menu.
    expect(completionFrame).not.toContain('/retry');
    expect(completionFrame).not.toContain('/replay');

    app.stdin.write(ARROW_DOWN);
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('❯ /go');

    app.stdin.write(ARROW_UP);
    await flushFrames();
    expect(app.lastFrame() ?? '').toContain('❯ /accept');

    app.stdin.write(TAB);
    await flushFrames();

    const acceptedFrame = app.lastFrame() ?? '';
    // The buffer now holds the accepted command and the menu is gone.
    expect(acceptedFrame).toContain('❯ /accept');
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
    expect(frame).not.toContain('/accept');

    app.unmount();
  });
});

describe('TUI scrollback output', () => {
  it('should show local notices at five and six terminal rows', async () => {
    const renderLocalNotice = async (rows: number) => {
      const conversation = createScriptedConversation(
        new Map<string, TuiLocalCommand>([
          ['/accept', { kind: 'notice', message: 'No assistant response found.' }],
        ]),
        NO_ORDER_COMMANDS,
      );
      const stdout = new ResizableOutput(80, rows);
      const stderr = new PassThrough();
      const input = createTestInput();
      const terminal = new Terminal({
        allowProposedApi: true,
        cols: stdout.columns,
        rows,
        convertEol: true,
      });
      const onExit = vi.fn();
      let app: ReturnType<typeof renderInk> | undefined;

      try {
        app = renderInk(
          <ConversationView
            ui={UI}
            lang="en"
            conversation={conversation}
            userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
            initialEntries={[]}
            submitMode="chat"
            autoSubmit={false}
            initialHistory={[]}
            initialDraft={undefined}
            initialQueue={[]}
            residentSession={false}
            modelLabel={() => MODEL_LABEL}
            onExit={onExit}
          />,
          {
            stdout: stdout as unknown as NodeJS.WriteStream,
            stderr: stderr as unknown as NodeJS.WriteStream,
            stdin: input,
            exitOnCtrlC: false,
            interactive: true,
            patchConsole: false,
          },
        );

        input.write('/accept');
        await waitForOutput(stdout, (value) => value.includes('/accept'), 'local command draft');
        input.write(ENTER);
        await flushFrames();
        await writeTerminalFrames(terminal, stdout.frames);

        return {
          conversation,
          onExit,
          output: stdout.frames.join(''),
          screen: getVisibleTerminalText(terminal, rows),
        };
      } finally {
        terminal.dispose();
        app?.unmount();
      }
    };

    const fiveRows = await renderLocalNotice(5);
    const sixRows = await renderLocalNotice(6);

    expect(fiveRows.screen).toContain('No assistant response found.');
    expect(fiveRows.screen).not.toMatch(/[╭╮╰╯]/u);
    expect(fiveRows.output).not.toContain('\x1b[3J');
    expect(fiveRows.conversation.submitCalls).toHaveLength(0);
    expect(fiveRows.onExit).not.toHaveBeenCalled();

    expect(sixRows.screen).toContain('No assistant response found.');
    expect(sixRows.screen).toMatch(/[╭╮╰╯]/u);
    expect(sixRows.output).not.toContain('\x1b[3J');
    expect(sixRows.conversation.submitCalls).toHaveLength(0);
    expect(sixRows.onExit).not.toHaveBeenCalled();
  });

  it('should keep a five-row image failure notice bounded during response streaming', async () => {
    const conversation = {
      ...createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS),
      pasteClipboardImage: () => Promise.reject(new Error('Clipboard does not contain an image.')),
    };
    const stdout = new ResizableOutput(80, 5);
    const stderr = new PassThrough();
    const input = createTestInput();
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: stdout.columns,
      rows: stdout.rows,
      convertEol: true,
    });
    let app: ReturnType<typeof renderInk> | undefined;
    let appliedFrameCount = 0;

    const applyNewFrames = async (): Promise<void> => {
      await writeTerminalFrames(terminal, stdout.frames.slice(appliedFrameCount));
      appliedFrameCount = stdout.frames.length;
    };

    try {
      app = renderInk(
        <ConversationView
          ui={UI}
          lang="en"
          conversation={conversation}
          userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
          initialEntries={[]}
          submitMode="chat"
          autoSubmit
          initialHistory={[]}
          initialDraft={{ text: 'draft', cursor: 5 }}
          initialQueue={[]}
          residentSession={false}
          modelLabel={() => MODEL_LABEL}
          onExit={() => undefined}
        />,
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stderr as unknown as NodeJS.WriteStream,
          stdin: input,
          exitOnCtrlC: false,
          interactive: true,
          patchConsole: false,
        },
      );

      await waitForOutput(
        stdout,
        (value) => value.includes('⠋') && conversation.submitCalls.length === 1,
        'response without transcript history',
      );
      await applyNewFrames();
      input.write(CTRL_V);
      await flushFrames();
      await applyNewFrames();

      const firstSubmission = conversation.submitCalls[0];
      if (firstSubmission === undefined) {
        throw new Error('The test conversation did not receive the initial submission.');
      }
      firstSubmission.onAssistantChunk('streamed update');
      await waitForOutput(
        stdout,
        (value) => value.includes('streamed update'),
        'stream update after image failure',
      );
      await applyNewFrames();

      const failureScreen = getVisibleTerminalText(terminal, stdout.rows);

      expect(failureScreen).toContain('Clipboard does not contain an image.');
      expect(failureScreen).toContain('draft');
      expect(failureScreen).toContain(UI.thinking);
      expect(failureScreen).toContain('streamed update');
      expect(await getMaximumTerminalScrollbackOffset(stdout)).toBe(0);
      expect(stdout.frames.join('')).not.toContain('\x1b[3J');

      input.write('!');
      await waitForOutput(stdout, (value) => value.includes('draft!'), 'edited draft');
      input.write(ENTER);
      await waitForOutput(
        stdout,
        (value) => value.includes(UI.queuedHint),
        'queued draft after image failure',
      );
      firstSubmission.onAssistantChunk('second streamed update');
      await waitForOutput(
        stdout,
        (value) => value.includes('second streamed update'),
        'another stream update before queue drain',
      );
      await applyNewFrames();
      expect(await getMaximumTerminalScrollbackOffset(stdout)).toBe(0);

      conversation.resolveWith({ kind: 'assistant_response', content: 'first answer' });
      await waitForOutput(
        stdout,
        (value) => value.includes('⠋') && conversation.submitCalls.length === 2,
        'queued draft submission',
      );
      await applyNewFrames();

      expect(conversation.submitCalls[1]?.text).toBe('draft!');
      expect(getVisibleTerminalText(terminal, stdout.rows)).not.toContain(
        'Clipboard does not contain an image.',
      );
      expect(stdout.frames.join('')).not.toContain('\x1b[3J');
    } finally {
      terminal.dispose();
      app?.unmount();
      if (conversation.submitCalls.length > 0) {
        conversation.resolveWith({ kind: 'assistant_response', content: 'cleanup response' });
      }
    }
  });

  it('should preserve terminal scrollback while a long transcript rerenders for spinner and streamed text', async () => {
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, NO_ORDER_COMMANDS);
    const stdout = new ResizableOutput(80, 8);
    const stderr = new PassThrough();
    const initialEntries: TranscriptEntry[] = Array.from({ length: 12 }, (_, index) => ({
      role: 'system' as const,
      content: `archive-entry-${index}`,
    }));
    const input = createTestInput();
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: stdout.columns,
      rows: stdout.rows,
      convertEol: true,
    });
    let app: ReturnType<typeof renderInk> | undefined;

    try {
      app = renderInk(
        <ConversationView
          ui={UI}
          lang="en"
          conversation={conversation}
          userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
          initialEntries={initialEntries}
          submitMode="chat"
          autoSubmit={false}
          initialHistory={[]}
          initialDraft={undefined}
          initialQueue={[]}
          residentSession={false}
          modelLabel={() => MODEL_LABEL}
          onExit={() => undefined}
        />,
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stderr as unknown as NodeJS.WriteStream,
          stdin: input,
          exitOnCtrlC: false,
          interactive: true,
          patchConsole: false,
        },
      );

      await waitForOutput(stdout, (captured) => captured.includes('archive-entry-11'), 'initial transcript');
      await writeTerminalFrames(terminal, stdout.frames);
      expect(terminal.buffer.active.baseY).toBeGreaterThan(2);
      terminal.scrollToLine(2);
      const scrollPositionBeforeResponse = terminal.buffer.active.viewportY;
      const outputFrameCountBeforeResponse = stdout.frames.length;

      input.write('question during response');
      await waitForOutput(stdout, (captured) => captured.includes('question during response'), 'draft echo');
      input.write(ENTER);
      await waitForOutput(
        stdout,
        (captured) => captured.includes('⠋') && conversation.submitCalls.length === 1,
        'response spinner',
      );

      const submission = conversation.submitCalls[0];
      if (submission === undefined) {
        throw new Error('The test conversation did not receive the submitted question.');
      }
      submission.onAssistantChunk('streamed segment one');
      await waitForOutput(
        stdout,
        (value) => value.includes('streamed segment one'),
        'first streamed segment',
      );
      submission.onAssistantChunk('streamed segment two');
      const captured = await waitForOutput(
        stdout,
        (value) => value.includes('streamed segment one')
          && value.includes('streamed segment two')
          && [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'].filter((frame) => value.includes(frame)).length >= 2,
        'second streamed segment and another spinner frame',
      );
      await writeTerminalFrames(terminal, stdout.frames.slice(outputFrameCountBeforeResponse));

      expect(terminal.buffer.active.viewportY).toBe(scrollPositionBeforeResponse);
      expect(captured).not.toContain('\x1b[3J');
    } finally {
      terminal.dispose();
      app?.unmount();
    }
  });

  it('should keep queued input and completion selection inside a small live area', async () => {
    const availability: CommandAvailability = {
      ...NO_ORDER_COMMANDS,
      enableTellCommand: true,
      enableSettingsCommands: true,
    };
    const conversation = createScriptedConversation(NO_LOCAL_COMMANDS, availability);
    const stdout = new ResizableOutput(80, 8);
    const stderr = new PassThrough();
    const input = createTestInput();
    let app: ReturnType<typeof renderInk> | undefined;

    try {
      app = renderInk(
        <ConversationView
          ui={UI}
          lang="en"
          conversation={conversation}
          userMessageColors={FALLBACK_USER_MESSAGE_COLORS}
          initialEntries={[]}
          submitMode="chat"
          autoSubmit
          initialHistory={[]}
          initialDraft={undefined}
          initialQueue={[]}
          residentSession={false}
          modelLabel={() => MODEL_LABEL}
          onExit={() => undefined}
        />,
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stderr as unknown as NodeJS.WriteStream,
          stdin: input,
          exitOnCtrlC: false,
          interactive: true,
          patchConsole: false,
        },
      );

      await waitForOutput(
        stdout,
        (captured) => captured.includes('⠋') && conversation.submitCalls.length === 1,
        'pending response',
      );
      for (let index = 0; index < 7; index += 1) {
        input.write(`queued item ${index}`);
        await waitForOutput(
          stdout,
          (value) => value.includes(`queued item ${index}`),
          `queued draft ${index}`,
        );
        input.write(ENTER);
        const expectedQueueSummary = index === 0
          ? UI.queuedHint
          : UI.queuedMore.replace('{count}', String(index));
        await waitForOutput(
          stdout,
          (value) => value.includes(expectedQueueSummary),
          `queued line ${index}`,
        );
      }
      input.write('/');
      await waitForOutput(
        stdout,
        (value) => value.includes(UI.queuedHint) && value.includes('❯ /accept'),
        'queued input and completion choices',
      );
      input.write(ARROW_DOWN);
      const captured = await waitForOutput(
        stdout,
        (value) => value.includes('❯ /go'),
        'completion selection update',
      );

      expect(captured).toContain(UI.queuedHint);
      expect(await getMaximumTerminalScrollbackOffset(stdout)).toBe(0);
      expect(captured).not.toContain('\x1b[3J');
    } finally {
      app?.unmount();
      if (conversation.submitCalls.length > 0) {
        conversation.resolveWith({ kind: 'assistant_response', content: 'ignored after unmount' });
      }
    }
  });

  it('should restore committed session history once across queued handoffs, execution and resizes', async () => {
    const terminal = installProcessPseudoTerminal(40);
    const cwd = mkdtempSync(join(tmpdir(), 'takt-tui-scrollback-'));
    const conversation = createScriptedConversation(
      new Map<string, TuiLocalCommand>([
        ['/tell additional instruction', {
          kind: 'handoff',
          id: 'tell',
          text: 'additional instruction',
        }],
        ['/go create execution', {
          kind: 'choose_action',
          task: 'unique-go-task',
          origin: 'go',
        }],
      ]),
      { ...NO_ORDER_COMMANDS, enableTellCommand: true },
    );
    const selectedActions: { task: string; origin?: string }[] = [];
    const dispatchedResults: InteractiveModeResult[] = [];
    const onHandoff = vi.fn(async (id: string, text: string) => {
      expect(id).toBe('tell');
      expect(text).toBe('additional instruction');
      return { kind: 'continue' as const, notice: 'tell notice once' };
    });
    let submissionResolved = false;
    let runFinished = false;
    const run = runTuiConversation({
      cwd,
      lang: 'en',
      conversation,
      initialEntries: [
        { role: 'system', content: 'archive-entry-alpha' },
        { role: 'system', content: 'archive-entry-beta' },
      ],
      submitMode: 'chat',
      autoSubmit: false,
      modelLabel: () => MODEL_LABEL,
      chooseAction: async (task, origin) => {
        selectedActions.push({ task, ...(origin === undefined ? {} : { origin }) });
        return { action: 'execute', task: 'unique-selected-task' };
      },
      continuePrompt: 'continue editing',
      dispatchPlaceholder: 'Executing selected task',
      dispatch: async (result) => {
        dispatchedResults.push(result);
        return 'execution notice once';
      },
      onHandoff,
    });
    void run.then(
      () => { runFinished = true; },
      () => { runFinished = true; },
    );

    try {
      await waitForOutput(terminal.stdout, (value) => value.includes('archive-entry-beta'), 'initial transcript');
      terminal.stdin.write('unique-user-message');
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes('unique-user-message'),
        'user draft',
      );
      terminal.stdin.write(ENTER);
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes('⠋') && conversation.submitCalls.length === 1,
        'submitted response',
      );

      terminal.stdin.write('/tell additional instruction');
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes('/tell additional instruction'),
        'tell command draft during response',
      );
      terminal.stdin.write(ENTER);
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes(UI.queuedHint)
          && value.includes('/tell additional instruction'),
        'queued tell handoff',
      );

      const submission = conversation.submitCalls[0];
      if (submission === undefined) {
        throw new Error('The test conversation did not receive the submitted message.');
      }
      submission.onAssistantChunk('streaming-only-preview');
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes('streaming-only-preview'),
        'streaming preview',
      );
      conversation.resolveWith({
        kind: 'assistant_response',
        content: 'unique-final-answer',
        notices: ['unique-response-notice'],
      });
      submissionResolved = true;
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes('tell notice once'),
        'response commit before queued tell handoff',
      );
      expect(conversation.submitCalls).toHaveLength(1);

      terminal.stdin.write('/go create execution');
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes('/go create execution'),
        'go command draft',
      );
      terminal.stdin.write(ENTER);
      await waitForOutput(
        terminal.stdout,
        (value) => value.includes('execution notice once'),
        'execution dispatch remount',
      );
      const initialColumns = terminal.stdout.columns;
      const resizeStart = terminal.stdout.frames.length;
      const resizeOperations: Array<{ columns: number; start: number; end: number }> = [];
      for (const columns of [60, 80]) {
        const start = terminal.stdout.frames.length;
        terminal.stdout.resize(columns);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        resizeOperations.push({ columns, start, end: terminal.stdout.frames.length });
      }
      terminal.stdin.write(CTRL_D);
      const result = await run;
      runFinished = true;

      expect(result).toMatchObject({ action: 'cancel', task: '' });
      expect(onHandoff).toHaveBeenCalledExactlyOnceWith('tell', 'additional instruction');
      expect(terminal.stdout.frames.join('')).not.toMatch(/\x1b\[(?:2|3)J/);
      expect(selectedActions).toEqual([{ task: 'unique-go-task', origin: 'go' }]);
      expect(dispatchedResults).toMatchObject([{ action: 'execute', task: 'unique-selected-task' }]);
      const committedEntries = [
        'archive-entry-alpha',
        'archive-entry-beta',
        'unique-response-notice',
        'unique-final-answer',
        'tell notice once',
        'execution notice once',
      ];
      const terminalOutput = new Terminal({
        allowProposedApi: true,
        cols: initialColumns,
        rows: terminal.stdout.rows,
        convertEol: true,
      });
      try {
        await writeTerminalFrames(terminalOutput, terminal.stdout.frames.slice(0, resizeStart));
        for (const { columns, start, end } of resizeOperations) {
          terminalOutput.resize(columns, terminal.stdout.rows);
          await writeTerminalFrames(terminalOutput, terminal.stdout.frames.slice(start, end));
          const buffer = getTerminalText(terminalOutput);
          for (const entry of committedEntries) {
            expect(countOccurrences(buffer, entry), buffer).toBe(1);
          }
          expect(countOccurrences(buffer, 'unique-user-message'), buffer).toBe(1);
          expect(countOccurrences(buffer, '/tell additional instruction'), buffer).toBe(1);
        }
        const lastResize = resizeOperations.at(-1);
        await writeTerminalFrames(terminalOutput, terminal.stdout.frames.slice(lastResize?.end ?? resizeStart));
        const scrollback = Array.from(
          { length: terminalOutput.buffer.active.length },
          (_, index) => terminalOutput.buffer.active.getLine(index)?.translateToString(true) ?? '',
        ).join('\n');
        const entryCounts = Object.fromEntries(
          committedEntries.map((entry) => [entry, countOccurrences(scrollback, entry)]),
        );
        const committedInputEntryCounts = {
          'unique-user-message': countOccurrences(scrollback, 'unique-user-message'),
          '/tell additional instruction': countOccurrences(scrollback, '/tell additional instruction'),
        };
        expect({ entryCounts, committedInputEntryCounts }).toEqual({
          entryCounts: Object.fromEntries(committedEntries.map((entry) => [entry, 1])),
          committedInputEntryCounts: {
            'unique-user-message': 1,
            '/tell additional instruction': 1,
          },
        });
      } finally {
        terminalOutput.dispose();
      }
    } finally {
      if (!runFinished) {
        if (conversation.submitCalls.length > 0 && !submissionResolved) {
          submissionResolved = true;
          conversation.resolveWith({ kind: 'assistant_response', content: 'cleanup response' });
        }
        terminal.stdin.write(CTRL_D);
        await Promise.race([
          run.then(() => undefined, () => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      terminal.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
