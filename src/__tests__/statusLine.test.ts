import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// StatusLine is a singleton — import the same instance used by production code
import { statusLine } from '../shared/ui/StatusLine.js';

describe('StatusLine', () => {
  let savedStdoutIsTTY: boolean | undefined;
  let savedStdoutWrite: typeof process.stdout.write;
  let savedStderrWrite: typeof process.stderr.write;
  let stdoutChunks: string[];

  beforeEach(() => {
    savedStdoutIsTTY = process.stdout.isTTY;
    savedStdoutWrite = process.stdout.write;
    savedStderrWrite = process.stderr.write;
    stdoutChunks = [];

    // Capture stdout writes
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    statusLine.stop();
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutIsTTY, configurable: true });
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
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

  it('should intercept stdout.write when started on TTY', () => {
    statusLine.start('Working...');

    // stdout.write should now be the wrapped version
    const wrappedWrite = process.stdout.write;
    expect(wrappedWrite).not.toBe(savedStdoutWrite);

    statusLine.stop();
    // After stop, stdout.write is restored — but to our test mock, not savedStdoutWrite,
    // because start() captured our mock as the "original"
  });

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

  it('should clear spinner line with ESC sequence on stop', () => {
    statusLine.start('test');
    stdoutChunks = [];
    statusLine.stop();

    // stop() should write \r\x1b[K to clear the spinner line
    const clearWrites = stdoutChunks.filter((c) => c.includes('\x1b[K'));
    expect(clearWrites.length).toBeGreaterThan(0);
  });

  it('should be safe to call stop multiple times', () => {
    statusLine.start('test');
    statusLine.stop();
    statusLine.stop(); // should not throw
  });

  it('should be safe to call stop without start', () => {
    statusLine.stop(); // should not throw
  });
});
