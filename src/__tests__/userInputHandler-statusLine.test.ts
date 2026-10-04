import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { setupRawStdin, restoreStdin } from './helpers/stdinSimulator.js';
import { confirm, promptInput, readMultilineFromStream } from '../shared/prompt/confirm.js';
import { selectOption, selectOptionWithDefault } from '../shared/prompt/select.js';
import { statusLine } from '../shared/ui/StatusLine.js';

const readlineMocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: readlineMocks.createInterface,
}));

describe('user input and StatusLine', () => {
  let savedStdoutIsTTY: boolean | undefined;
  let savedStdinIsTTY: boolean | undefined;
  let savedStdoutWrite: typeof process.stdout.write;
  let savedStderrWrite: typeof process.stderr.write;
  let savedStdinPause: typeof process.stdin.pause;
  let savedNoTty: string | undefined;
  let savedTouchTty: string | undefined;
  let stdoutChunks: string[];

  beforeEach(() => {
    statusLine.stop();
    savedStdoutIsTTY = process.stdout.isTTY;
    savedStdinIsTTY = process.stdin.isTTY;
    savedStdoutWrite = process.stdout.write;
    savedStderrWrite = process.stderr.write;
    savedStdinPause = process.stdin.pause;
    savedNoTty = process.env.TAKT_NO_TTY;
    savedTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;
    stdoutChunks = [];

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    process.env.TAKT_NO_TTY = '0';
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
    vi.useFakeTimers();
  });

  afterEach(() => {
    statusLine.stop();
    restoreStdin();
    vi.useRealTimers();
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutIsTTY, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: savedStdinIsTTY, configurable: true });
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
    process.stdin.pause = savedStdinPause;
    if (savedNoTty === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = savedNoTty;
    }
    if (savedTouchTty === undefined) {
      delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    } else {
      process.env.TAKT_TEST_FLG_TOUCH_TTY = savedTouchTty;
    }
    readlineMocks.createInterface.mockReset();
  });

  it('should not redraw the status line while promptInput is waiting', async () => {
    let answerCallback: ((answer: string) => void) | undefined;
    readlineMocks.createInterface.mockImplementation(() => ({
      question: (_prompt: string, callback: (answer: string) => void) => {
        answerCallback = callback;
      },
      close: vi.fn(),
    }));

    statusLine.start('Running...');
    const inputPromise = promptInput('Input');

    vi.advanceTimersByTime(240);

    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(false);
    expect(answerCallback).toBeDefined();

    answerCallback?.('answer');
    await expect(inputPromise).resolves.toBe('answer');

    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(true);
  });

  it('should resume the status line when promptInput rejects during forced TTY validation', async () => {
    process.env.TAKT_TEST_FLG_TOUCH_TTY = '1';
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    statusLine.start('Running...');

    await expect(promptInput('Input')).rejects.toThrow('TAKT_TEST_FLG_TOUCH_TTY=1 requires a TTY');

    vi.advanceTimersByTime(100);

    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(true);
  });

  it('should not redraw the status line while readMultilineFromStream is waiting', async () => {
    const actualReadline = await vi.importActual<typeof import('node:readline')>('node:readline');
    readlineMocks.createInterface.mockImplementation((options) => actualReadline.createInterface(options));

    const input = new PassThrough();
    statusLine.start('Running...');
    const inputPromise = readMultilineFromStream(input);
    await Promise.resolve();
    const waitingOutputStart = stdoutChunks.length;

    vi.advanceTimersByTime(240);

    const waitingOutput = stdoutChunks.slice(waitingOutputStart);
    expect(waitingOutput.some((chunk) => chunk.includes('Running...'))).toBe(false);

    input.end('first line\n\n');
    await expect(inputPromise).resolves.toBe('first line');

    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(true);
  });

  it('should not redraw the status line while selectOption is waiting', async () => {
    const controller = setupRawStdin([]);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    statusLine.start('Running...');
    const selectionPromise = selectOption('Select', [{ label: 'Option', value: 'option' }]);
    await Promise.resolve();
    const waitingOutputStart = stdoutChunks.length;

    vi.advanceTimersByTime(240);

    const waitingOutput = stdoutChunks.slice(waitingOutputStart);
    expect(waitingOutput.some((chunk) => chunk.includes('Running...'))).toBe(false);

    controller.send('\r');
    await expect(selectionPromise).resolves.toBe('option');

    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(true);
  });

  it('should suspend and resume the status line while confirm is waiting', async () => {
    let answerCallback: ((answer: string) => void) | undefined;
    readlineMocks.createInterface.mockImplementation(() => ({
      question: (_prompt: string, callback: (answer: string) => void) => {
        answerCallback = callback;
      },
      close: vi.fn(),
    }));

    statusLine.start('Running...');
    const confirmationPromise = confirm('Continue?');

    vi.advanceTimersByTime(240);

    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(false);
    expect(answerCallback).toBeDefined();

    answerCallback?.('y');
    await expect(confirmationPromise).resolves.toBe(true);

    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(true);
  });

  it('should suspend and resume the status line while confirm reads from a pipe', async () => {
    let lineHandler: ((line: string) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    readlineMocks.createInterface.mockImplementation(() => ({
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'line') lineHandler = (line: unknown) => callback(line);
        if (event === 'close') closeHandler = () => callback();
      },
    }));

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    process.env.TAKT_NO_TTY = '1';
    statusLine.start('Running...');
    const confirmationPromise = confirm('Continue?');
    await Promise.resolve();
    const waitingOutputStart = stdoutChunks.length;

    vi.advanceTimersByTime(240);

    const waitingOutput = stdoutChunks.slice(waitingOutputStart);
    expect(waitingOutput.some((chunk) => chunk.includes('Running...'))).toBe(false);
    expect(lineHandler).toBeDefined();
    expect(closeHandler).toBeDefined();

    lineHandler?.('y');
    closeHandler?.();
    await expect(confirmationPromise).resolves.toBe(true);

    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(true);
  });

  it('should suspend and resume the status line while selectOptionWithDefault is waiting', async () => {
    const controller = setupRawStdin([]);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    statusLine.start('Running...');
    const selectionPromise = selectOptionWithDefault(
      'Select',
      [{ label: 'Option', value: 'option' }],
      'option',
    );
    await Promise.resolve();
    const waitingOutputStart = stdoutChunks.length;

    vi.advanceTimersByTime(240);

    const waitingOutput = stdoutChunks.slice(waitingOutputStart);
    expect(waitingOutput.some((chunk) => chunk.includes('Running...'))).toBe(false);

    controller.send('\r');
    await expect(selectionPromise).resolves.toBe('option');

    vi.advanceTimersByTime(100);
    expect(stdoutChunks.some((chunk) => chunk.includes('Running...'))).toBe(true);
  });
});
