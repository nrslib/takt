import { closeSync, openSync } from 'node:fs';
import { format } from 'node:util';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';

// StatusLine is a singleton — import the same instance used by production code
import { statusLine } from '../shared/ui/StatusLine.js';
import { StreamDisplay } from '../shared/ui/StreamDisplay.js';
import { confirm } from '../shared/prompt/confirm.js';
import { selectOption } from '../shared/prompt/select.js';

/** Replay captured ANSI output and return the text actually visible on screen. */
async function readTerminalText(output: string): Promise<string> {
  const terminal = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
  try {
    const ttyOutput = output.replace(/\r?\n/gu, '\r\n');
    await new Promise<void>((resolve) => terminal.write(ttyOutput, resolve));
    const baseY = terminal.buffer.active.baseY;
    return Array.from({ length: terminal.rows }, (_, index) => (
      terminal.buffer.active.getLine(baseY + index)?.translateToString(true) ?? ''
    )).join('\n');
  } finally {
    terminal.dispose();
  }
}

describe('StatusLine', () => {
  let savedStdoutIsTTY: boolean | undefined;
  let savedStderrIsTTY: boolean | undefined;
  let savedStdoutFd: number;
  let savedStderrFd: number;
  let savedStdoutWrite: typeof process.stdout.write;
  let savedStderrWrite: typeof process.stderr.write;
  let stdoutFd: number;
  let stderrFd: number;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    savedStdoutIsTTY = process.stdout.isTTY;
    savedStderrIsTTY = process.stderr.isTTY;
    savedStdoutFd = process.stdout.fd;
    savedStderrFd = process.stderr.fd;
    savedStdoutWrite = process.stdout.write;
    savedStderrWrite = process.stderr.write;
    stdoutFd = openSync(process.execPath, 'r');
    stderrFd = openSync(fileURLToPath(import.meta.url), 'r');
    stdoutChunks = [];
    stderrChunks = [];

    // Capture stdout and stderr independently
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'fd', { value: stdoutFd, configurable: true });
    Object.defineProperty(process.stderr, 'fd', { value: stderrFd, configurable: true });
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    statusLine.stop();
    vi.useRealTimers();
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutIsTTY, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: savedStderrIsTTY, configurable: true });
    Object.defineProperty(process.stdout, 'fd', { value: savedStdoutFd, configurable: true });
    Object.defineProperty(process.stderr, 'fd', { value: savedStderrFd, configurable: true });
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
    closeSync(stdoutFd);
    closeSync(stderrFd);
  });

  it('should not start when stdout is not a TTY', () => {
    statusLine.stop();
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });

    statusLine.start('test');

    // Advance timers — no spinner should render
    vi.useFakeTimers();
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    expect(stdoutChunks).toEqual([]);
  });

  it.each([true, undefined])('renders immediately only when requested (%s) and keeps periodic updates', async (renderImmediately) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    statusLine.start('Working...', { renderImmediately, intervalMs: 120 });
    const initialOutput = stdoutChunks.join('');
    expect((await readTerminalText(initialOutput)).trim()).toBe(renderImmediately ? '⠋ Working...' : '');
    statusLine.update('Updated');
    vi.advanceTimersByTime(119);
    expect(stdoutChunks.join('')).toBe(initialOutput);
    vi.advanceTimersByTime(1);
    expect((await readTerminalText(stdoutChunks.join(''))).trim()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Updated$/u);
  });

  it.each(['stdout', 'stderr'] as const)(
    'keeps the spinner running when %s terminal metadata cannot be read',
    async (streamName) => {
      const closedFd = openSync(process.execPath, 'r');
      closeSync(closedFd);
      Object.defineProperty(process[streamName], 'fd', { value: closedFd, configurable: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
      const originalStdoutWrite = process.stdout.write;
      const originalStderrWrite = process.stderr.write;

      vi.useFakeTimers();
      expect(() => statusLine.start('Working...')).not.toThrow();
      vi.advanceTimersByTime(80);
      process.stderr.write('warning');
      expect(stdoutChunks).not.toContain('\r\x1b[K');
      vi.advanceTimersByTime(80);
      const output = stdoutChunks.join('');
      statusLine.stop();
      vi.useRealTimers();

      expect(process.stdout.write).toBe(originalStdoutWrite);
      expect(process.stderr.write).toBe(originalStderrWrite);
      expect(await readTerminalText(output)).toContain('Working...');
      expect(stderrChunks.join('')).toBe('warning');
    },
  );

  it.each([
    { name: 'without a newline', output: 'warning' },
    { name: 'with a newline', output: 'warning\n' },
  ])('keeps the stdout spinner visible after stderr output $name', async ({ output }) => {
    vi.useFakeTimers();
    statusLine.start('Working...');
    vi.advanceTimersByTime(80);

    process.stderr.write(output);
    expect(stdoutChunks).not.toContain('\r\x1b[K');
    vi.advanceTimersByTime(80);
    vi.useRealTimers();

    const stdoutTerminal = await readTerminalText(stdoutChunks.join(''));
    expect(stdoutTerminal).toContain('Working...');
    expect(stdoutTerminal).not.toContain('warning');
    expect(stderrChunks.join('')).toBe(output);
  });

  it('keeps the stdout spinner visible after newline-free output to a separate TTY', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    vi.useFakeTimers();
    statusLine.start('Working...');
    vi.advanceTimersByTime(80);

    process.stderr.write('warning');
    expect(stdoutChunks).not.toContain('\r\x1b[K');
    vi.advanceTimersByTime(80);
    vi.useRealTimers();

    const stdoutTerminal = await readTerminalText(stdoutChunks.join(''));
    const stderrTerminal = await readTerminalText(stderrChunks.join(''));
    expect(stdoutTerminal).toContain('Working...');
    expect(stdoutTerminal).not.toContain('warning');
    expect(stderrTerminal).toContain('warning');
    expect(stderrChunks.join('')).toBe('warning');
  });

  it('does not overwrite partial stderr output when both streams share a TTY', async () => {
    const sharedChunks: string[] = [];
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'fd', { value: stdoutFd, configurable: true });
    process.stdout.write = ((chunk: unknown) => {
      sharedChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      sharedChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    vi.useFakeTimers();
    statusLine.start('Working...');
    vi.advanceTimersByTime(80);
    expect(sharedChunks.join('')).toContain('Working...');

    process.stderr.write('warning');
    vi.advanceTimersByTime(80);
    statusLine.stop();
    vi.useRealTimers();

    const sharedTerminal = await readTerminalText(sharedChunks.join(''));
    expect(sharedTerminal).toContain('warning');
    expect(sharedTerminal).not.toContain('Working...');
  });

  it.each([
    { name: 'spinner clear', output: '\r\x1b[K' },
    { name: 'color reset', output: '\x1b[0m' },
    { name: 'cursor visibility', output: '\x1b[?25h' },
    { name: 'control characters', output: '\r\x07\x7f\x9f' },
    { name: 'newline with color reset', output: 'completed\n\x1b[0m' },
    { name: 'newline with spinner clear', output: 'completed\n\r\x1b[K' },
    { name: 'newline with controls', output: 'completed\n\r\x07' },
    { name: 'newline with terminal title', output: 'completed\n\x1b]0;title\x07' },
  ])('redraws the spinner after $name without visible trailing text', async ({ output }) => {
    vi.useFakeTimers();
    statusLine.start('Working...');
    vi.advanceTimersByTime(80);
    process.stdout.write(output);
    vi.advanceTimersByTime(160);
    const captured = stdoutChunks.join('');
    statusLine.stop();
    vi.useRealTimers();

    const screen = await readTerminalText(captured);
    expect(screen).toContain('Working...');
    if (output.startsWith('completed')) expect(screen).toContain('completed');
  });

  it('keeps a partial colored body open across control-only writes until its newline', async () => {
    vi.useFakeTimers();
    statusLine.start('Working...');
    vi.advanceTimersByTime(80);
    process.stdout.write('\x1b[32m日本語\x1b[0m');
    process.stdout.write('\x1b[0m\x07');
    vi.advanceTimersByTime(160);
    const partialOutput = stdoutChunks.join('');
    process.stdout.write('の本文\n\x1b[0m');
    vi.advanceTimersByTime(160);
    const completedOutput = stdoutChunks.join('');
    statusLine.stop();
    vi.useRealTimers();

    const partialScreen = await readTerminalText(partialOutput);
    expect(partialScreen).toContain('日本語');
    expect(partialScreen).not.toContain('Working...');
    const completedScreen = await readTerminalText(completedOutput);
    expect(completedScreen).toContain('日本語の本文');
    expect(completedScreen).toContain('Working...');
  });

  it('redraws after StreamDisplay clears a tool spinner before its first frame', async () => {
    vi.useFakeTimers();
    const display = new StreamDisplay('test-agent', false);
    try {
      statusLine.start('Working...');
      display.showToolUse('Bash', { command: 'ls' });
      display.flush();
      vi.advanceTimersByTime(160);
      const captured = stdoutChunks.join('');
      statusLine.stop();
      vi.useRealTimers();
      expect(await readTerminalText(captured)).toContain('Working...');
    } finally {
      display.reset();
    }
  });

  it('should intercept stdout.write when started on TTY', () => {
    statusLine.start('Working...');

    // stdout.write should now be the wrapped version
    const wrappedWrite = process.stdout.write;
    expect(wrappedWrite).not.toBe(savedStdoutWrite);

    statusLine.stop();
    // After stop, stdout.write is restored — but to our test mock, not savedStdoutWrite,
    // because start() captured our mock as the "original"
  });

  it.each([
    {
      name: 'Japanese text',
      chunks: ['日本語の', 'ストリーム本文', 'を保持します。'],
    },
    {
      name: 'Markdown table',
      chunks: ['| 項目 | 値 |', '\n| --- | --- |\n| 名前 | ', 'タクト |'],
    },
    {
      name: 'JSON',
      chunks: ['{"name":', '"タクト",', '"active":true}'],
    },
    {
      name: 'four-chunk Japanese text, Markdown table, and JSON',
      chunks: ['日本語 ', '本文\n| 列A | 列B |\n', '{"項目": ', '"値"}\n'],
    },
  ])('preserves split $name text across spinner timer ticks in the rendered terminal', async ({ chunks }) => {
    vi.useFakeTimers();
    const display = new StreamDisplay('test-agent', false);
    statusLine.start('Working...');

    for (const chunk of chunks) {
      display.showText(chunk);
      vi.advanceTimersByTime(80);
    }
    display.flushText();
    statusLine.stop();
    vi.useRealTimers();

    const screen = await readTerminalText(stdoutChunks.join(''));
    expect(screen).toContain(chunks.join(''));
  });

  it('preserves split thinking across spinner timer ticks in the rendered terminal', async () => {
    vi.useFakeTimers();
    const display = new StreamDisplay('test-agent', false);
    statusLine.start('Thinking...');
    const chunks = ['思考 ', 'の断片\n続き ', 'です\n'];

    for (const chunk of chunks) {
      display.showThinking(chunk);
      vi.advanceTimersByTime(80);
    }
    display.flushThinking();
    statusLine.stop();
    vi.useRealTimers();

    const screen = await readTerminalText(stdoutChunks.join(''));
    expect(screen).toContain(chunks.join(''));
  });

  it('preserves tool output while the status line spinner is active', async () => {
    vi.useFakeTimers();
    const display = new StreamDisplay('test-agent', false);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args) => {
      process.stdout.write(`${format(...args)}\n`);
    });
    try {
      statusLine.start('Working...');
      display.showToolUse('Bash', { command: 'ls' });
      vi.advanceTimersByTime(80);
      display.showToolOutput('tool output\n');
      display.showToolResult('done', false);
      display.flush();
      statusLine.stop();
      vi.useRealTimers();

      const screen = await readTerminalText(stdoutChunks.join(''));
      expect(screen).toContain('Bash output:');
      expect(screen).toContain('tool output');
      expect(screen).toContain('✓ Bash');
    } finally {
      display.reset();
      statusLine.stop();
      consoleLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['confirm', 'select'] as const)(
    'preserves unfinished text and the real %s prompt across suspend and resume',
    async (promptKind) => {
      const input = new PassThrough();
      Object.assign(input, { isTTY: true, isRaw: false, setRawMode: vi.fn() });
      const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
      const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args) => {
        process.stdout.write(`${format(...args)}\n`);
      });
      vi.stubEnv('TAKT_NO_TTY', '0');
      vi.stubEnv('TAKT_TEST_FLG_TOUCH_TTY', '0');
      vi.useFakeTimers();
      try {
        statusLine.start('Working...');
        vi.advanceTimersByTime(80);
        const display = new StreamDisplay('test-agent', false);
        display.showText('改行前の本文を保持します。');

        const answer = promptKind === 'confirm'
          ? confirm('Continue?')
          : selectOption('Select an option', [{ label: 'Keep text', value: 'keep' }]);
        const waitingStart = stdoutChunks.length;
        vi.advanceTimersByTime(240);
        expect(stdoutChunks.slice(waitingStart).join('')).not.toContain('Working...');

        input.write(promptKind === 'confirm' ? 'y\r' : '\r');
        await expect(answer).resolves.toBe(promptKind === 'confirm' ? true : 'keep');
        vi.advanceTimersByTime(160);
        const resumedOutput = stdoutChunks.join('');
        statusLine.stop();
        vi.useRealTimers();

        const screen = await readTerminalText(resumedOutput);
        expect(screen).toContain('改行前の本文を保持します。');
        expect(screen).toContain(promptKind === 'confirm' ? 'Continue? [Y/n]: y' : 'Select an option');
        if (promptKind === 'select') expect(screen).toContain('✓ Keep text');
        expect(screen).toContain('Working...');
      } finally {
        statusLine.stop();
        vi.useRealTimers();
        input.destroy();
        stdin.mockRestore();
        consoleLog.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it('should restore stdout and stderr on stop', () => {
    // Capture what write functions are set before start
    const preStartStdout = process.stdout.write;
    const preStartStderr = process.stderr.write;

    statusLine.start('test');
    statusLine.stop();

    expect(process.stdout.write).toBe(preStartStdout);
    expect(process.stderr.write).toBe(preStartStderr);
  });

  it('should update message when start is called while active', () => {
    vi.useFakeTimers();
    statusLine.start('first');
    statusLine.start('second');

    stdoutChunks = [];
    vi.advanceTimersByTime(100);
    vi.useRealTimers();

    const rendered = stdoutChunks.filter((c) => c.includes('second'));
    expect(rendered.length).toBeGreaterThan(0);

    statusLine.stop();
  });

  it('should update message via update()', () => {
    vi.useFakeTimers();
    statusLine.start('original');
    statusLine.update('updated');

    stdoutChunks = [];
    vi.advanceTimersByTime(100);
    vi.useRealTimers();

    const rendered = stdoutChunks.filter((c) => c.includes('updated'));
    expect(rendered.length).toBeGreaterThan(0);

    statusLine.stop();
  });

  it('erases the previous longer message when redrawing a shorter message', async () => {
    vi.useFakeTimers();
    statusLine.start('a much longer message', { dim: true, intervalMs: 120, truncate: true });
    vi.advanceTimersByTime(120);
    statusLine.update('short');
    vi.advanceTimersByTime(120);
    const output = stdoutChunks.join('');
    statusLine.stop();
    vi.useRealTimers();
    expect((await readTerminalText(output)).trim()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] short$/u);
  });

  it('preserves the display style and interval across suspend and resume', () => {
    vi.useFakeTimers();
    statusLine.start('dim message', { dim: true, intervalMs: 120, truncate: true });
    statusLine.suspend();
    statusLine.update('new message');
    stdoutChunks = [];
    statusLine.resume();
    vi.advanceTimersByTime(119);
    expect(stdoutChunks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stdoutChunks.join('')).toContain('new message');
    expect(stdoutChunks.join('')).not.toContain('dim message');
  });

  it('should defer start while suspended and resume with the latest message', () => {
    vi.useFakeTimers();
    statusLine.start('original');
    statusLine.suspend();
    stdoutChunks = [];

    statusLine.start('deferred');
    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('deferred'))).toBe(false);

    statusLine.resume();
    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('deferred'))).toBe(true);
  });

  it('should defer update while suspended and resume with the latest message', () => {
    vi.useFakeTimers();
    statusLine.start('original');
    statusLine.suspend();
    stdoutChunks = [];

    statusLine.update('updated');
    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('updated'))).toBe(false);

    statusLine.resume();
    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('updated'))).toBe(true);
  });

  it('should defer start after suspending an inactive status line', () => {
    vi.useFakeTimers();
    statusLine.stop();
    statusLine.suspend();
    statusLine.start('deferred');

    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('deferred'))).toBe(false);

    statusLine.resume();
    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('deferred'))).toBe(true);
  });

  it('should be safe to call stop multiple times', () => {
    statusLine.start('test');
    statusLine.stop();
    statusLine.stop(); // should not throw
  });

  it('should be safe to call stop without start', () => {
    statusLine.stop(); // should not throw
  });

  it('should resume only after all nested suspensions are released', () => {
    vi.useFakeTimers();
    statusLine.start('Working...');
    statusLine.suspend();
    statusLine.suspend();
    stdoutChunks = [];

    statusLine.resume();
    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Working...'))).toBe(false);

    statusLine.resume();
    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Working...'))).toBe(true);
  });

  it('should not resume after stop invalidates a suspension', () => {
    vi.useFakeTimers();
    statusLine.start('Working...');
    statusLine.suspend();
    statusLine.stop();
    stdoutChunks = [];

    statusLine.resume();
    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('Working...'))).toBe(false);
  });
});
