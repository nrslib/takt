import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmWithCancel, promptInputWithCancel } from '../shared/prompt/confirm.js';
import { ESCAPE_SEQUENCE_TIMEOUT_MS } from '../shared/prompt/select-key-input.js';
import { statusLine } from '../shared/ui/StatusLine.js';

let stdoutIsTTYDescriptor: PropertyDescriptor | null | undefined;
let stdinIsTTYDescriptor: PropertyDescriptor | undefined;
let stdinIsRawDescriptor: PropertyDescriptor | undefined;
let originalSetRawMode: typeof process.stdin.setRawMode | undefined;
let originalStdinResume: typeof process.stdin.resume | undefined;
let originalStdinPause: typeof process.stdin.pause | undefined;
let originalStdoutWrite: typeof process.stdout.write | undefined;
let removeListenerSpy: { mockRestore(): void } | undefined;
let originalNoTty: string | undefined;
let originalForceTty: string | undefined;

function getMockCalls(mock: unknown): unknown[][] {
  return (mock as { mock: { calls: unknown[][] } }).mock.calls;
}

function enableStdoutTty(): void {
  stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY') ?? null;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
}

function setupPromptStdin() {
  stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  stdinIsRawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isRaw');
  enableStdoutTty();
  originalSetRawMode = process.stdin.setRawMode;
  originalStdinResume = process.stdin.resume;
  originalStdinPause = process.stdin.pause;
  originalStdoutWrite = process.stdout.write;
  removeListenerSpy = vi.spyOn(process.stdin, 'removeListener');
  originalNoTty = process.env.TAKT_NO_TTY;
  originalForceTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;
  delete process.env.TAKT_NO_TTY;
  process.env.TAKT_TEST_FLG_TOUCH_TTY = '1';
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isRaw', { value: false, configurable: true, writable: true });
  process.stdin.setRawMode = vi.fn((mode: boolean) => {
    Object.defineProperty(process.stdin, 'isRaw', { value: mode, configurable: true, writable: true });
    return process.stdin;
  }) as unknown as typeof process.stdin.setRawMode;
  process.stdin.resume = vi.fn(() => process.stdin) as unknown as typeof process.stdin.resume;
  process.stdin.pause = vi.fn(() => process.stdin) as unknown as typeof process.stdin.pause;
  process.stdout.write = vi.fn(() => true) as unknown as typeof process.stdout.write;

  return {
    send(input: string): void {
      process.stdin.emit('data', Buffer.from(input, 'utf8'));
    },
  };
}

function restorePromptStdin(): void {
  removeListenerSpy?.mockRestore();
  removeListenerSpy = undefined;
  if (originalSetRawMode !== undefined) process.stdin.setRawMode = originalSetRawMode;
  if (originalStdinResume !== undefined) process.stdin.resume = originalStdinResume;
  if (originalStdinPause !== undefined) process.stdin.pause = originalStdinPause;
  if (originalStdoutWrite !== undefined) process.stdout.write = originalStdoutWrite;
  if (originalNoTty === undefined) {
    delete process.env.TAKT_NO_TTY;
  } else {
    process.env.TAKT_NO_TTY = originalNoTty;
  }
  if (originalForceTty === undefined) {
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
  } else {
    process.env.TAKT_TEST_FLG_TOUCH_TTY = originalForceTty;
  }
  for (const [key, descriptor] of [
    ['isTTY', stdinIsTTYDescriptor],
    ['isRaw', stdinIsRawDescriptor],
  ] as const) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(process.stdin, key);
    } else {
      Object.defineProperty(process.stdin, key, descriptor);
    }
  }
  stdinIsTTYDescriptor = undefined;
  stdinIsRawDescriptor = undefined;
  originalSetRawMode = undefined;
  originalStdinResume = undefined;
  originalStdinPause = undefined;
  originalStdoutWrite = undefined;
  originalNoTty = undefined;
  originalForceTty = undefined;
}

afterEach(() => {
  statusLine.stop();
  restorePromptStdin();
  if (stdoutIsTTYDescriptor === null) {
    Reflect.deleteProperty(process.stdout, 'isTTY');
  } else if (stdoutIsTTYDescriptor !== undefined) {
    Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTYDescriptor);
  }
  stdoutIsTTYDescriptor = undefined;
  vi.useRealTimers();
});

describe('cancellable prompts', () => {
  it('returns cancellation for a standalone Escape and restores terminal state', async () => {
    vi.useFakeTimers();
    const stdin = setupPromptStdin();
    const setRawMode = process.stdin.setRawMode;
    const removeListener = process.stdin.removeListener;
    const stdoutWrite = process.stdout.write;
    statusLine.start('Running...');

    const input = promptInputWithCancel('Worktree path');
    stdin.send('\x1B');
    await vi.advanceTimersByTimeAsync(ESCAPE_SEQUENCE_TIMEOUT_MS);

    await expect(input).resolves.toEqual({ kind: 'cancelled' });
    expect(getMockCalls(setRawMode).map(([mode]) => mode)).toEqual([true, false]);
    expect(getMockCalls(removeListener).some(([event]) => event === 'data')).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    const writes = getMockCalls(stdoutWrite);
    expect(writes.some(([chunk]) => String(chunk).includes('Running...'))).toBe(true);
  });

  it.each([
    { description: 'one chunk', chunks: ['\x1B[A'] },
    { description: 'split chunks', chunks: ['\x1B', '[', 'A'] },
  ])('keeps the text prompt active for an arrow sequence delivered in $description', async ({ chunks }) => {
    const stdin = setupPromptStdin();
    const setRawMode = process.stdin.setRawMode;
    const removeListener = process.stdin.removeListener;
    const input = promptInputWithCancel('Branch name');
    for (const chunk of chunks) {
      stdin.send(chunk);
    }
    stdin.send('feature/topic\r');

    await expect(input).resolves.toEqual({ kind: 'value', value: 'feature/topic' });
    expect(getMockCalls(setRawMode).map(([mode]) => mode)).toEqual([true, false]);
    expect(getMockCalls(removeListener).some(([event]) => event === 'data')).toBe(true);
  });

  it('keeps empty text input distinct from cancellation', async () => {
    const stdin = setupPromptStdin();
    const input = promptInputWithCancel('Worktree path');
    stdin.send('\r');

    await expect(input).resolves.toEqual({ kind: 'value', value: null });
  });

  it.each([
    { defaultYes: true, expected: true },
    { defaultYes: false, expected: false },
  ])('uses the configured confirmation default on empty Enter', async ({ defaultYes, expected }) => {
    const stdin = setupPromptStdin();
    const confirmation = confirmWithCancel('Continue?', defaultYes);
    stdin.send('\r');

    await expect(confirmation).resolves.toEqual({ kind: 'value', value: expected });
  });

  it.each([
    { answer: 'y', defaultYes: false, expected: true },
    { answer: 'n', defaultYes: true, expected: false },
  ])('keeps an explicit "$answer" answer distinct from cancellation', async ({ answer, defaultYes, expected }) => {
    const stdin = setupPromptStdin();
    const confirmation = confirmWithCancel('Continue?', defaultYes);
    stdin.send(`${answer}\r`);

    await expect(confirmation).resolves.toEqual({ kind: 'value', value: expected });
  });

  it('restores raw mode and the status line when terminal setup fails', async () => {
    vi.useFakeTimers();
    setupPromptStdin();
    const failure = new Error('raw mode setup failed');
    const stdoutWrite = process.stdout.write;
    const setRawMode = process.stdin.setRawMode as unknown as {
      mock: { calls: unknown[][] };
      mockImplementation: (implementation: (mode: boolean) => NodeJS.ReadStream) => void;
    };
    setRawMode.mockImplementation((mode) => {
      Object.defineProperty(process.stdin, 'isRaw', { value: mode, configurable: true, writable: true });
      if (mode) {
        throw failure;
      }
      return process.stdin;
    });
    statusLine.start('Running...');

    await expect(promptInputWithCancel('Input')).rejects.toBe(failure);

    expect(getMockCalls(setRawMode).map(([mode]) => mode)).toEqual([true, false]);
    expect(process.stdin.isRaw).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const writes = getMockCalls(stdoutWrite);
    expect(writes.some(([chunk]) => String(chunk).includes('Running...'))).toBe(true);
  });

  it.each([{ defaultYes: true }, { defaultYes: false }])(
    'returns cancellation for a standalone Escape with defaultYes=$defaultYes',
    async ({ defaultYes }) => {
      vi.useFakeTimers();
      const stdin = setupPromptStdin();
      const confirmation = confirmWithCancel('Continue?', defaultYes);
      stdin.send('\x1B');
      await vi.advanceTimersByTimeAsync(ESCAPE_SEQUENCE_TIMEOUT_MS);

      await expect(confirmation).resolves.toEqual({ kind: 'cancelled' });
    },
  );
});
