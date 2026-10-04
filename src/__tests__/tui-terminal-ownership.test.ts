/**
 * Ink erases each frame by moving the cursor up exactly as many lines as it last
 * wrote. A write from anywhere else shifts the cursor without Ink knowing, and
 * the next erase misses rows — that is what strands spinner and prompt fragments
 * in the scrollback. Foreign writes must therefore be held until Ink lets go.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  takeTerminalOwnership,
  type TerminalOwnership,
} from '../features/tui/terminalOwnership.js';

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

/**
 * Ownership is process-wide state: a test that fails before releasing would
 * leave every later one failing with "already held", hiding the first cause.
 */
const taken: TerminalOwnership[] = [];

function take(): TerminalOwnership {
  const ownership = takeTerminalOwnership();
  taken.push(ownership);
  return ownership;
}

afterEach(() => {
  for (const ownership of taken.splice(0)) {
    try {
      ownership.release();
    } catch {
      // A release that throws is what the test under it was about.
    }
  }
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  vi.restoreAllMocks();
});

type WriteCallback = (error?: Error | null) => void;

/** Stands in for the real stream, including its completion-callback contract. */
function captureRealWrites(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const record = (sink: string[]) => (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    sink.push(String(chunk));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.();
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(record(stdout) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(record(stderr) as typeof process.stderr.write);
  return { stdout, stderr };
}

describe('terminal ownership', () => {
  it('should hold foreign writes and replay them in order on release', () => {
    const written = captureRealWrites();
    const terminal = take();

    // console.log routes through process.stdout.write in production; vitest
    // intercepts console itself, so the stream contract is what is asserted.
    process.stdout.write('provider log 1\n');
    process.stdout.write('provider log 2\n');
    process.stderr.write('provider warning\n');
    expect(written.stdout).toEqual([]);
    expect(written.stderr).toEqual([]);

    terminal.release();

    expect(written.stdout.join('')).toContain('provider log 1');
    expect(written.stdout.join('')).toContain('provider log 2');
    expect(written.stderr.join('')).toContain('provider warning');
  });

  it('should let the owner write straight through while foreign writes are held', () => {
    const written = captureRealWrites();
    const terminal = take();

    terminal.stdout.write('frame');
    process.stdout.write('foreign');

    expect(written.stdout).toEqual(['frame']);

    terminal.release();
    expect(written.stdout).toEqual(['frame', 'foreign']);
  });

  it('should keep the stream metadata Ink depends on', () => {
    captureRealWrites();
    const terminal = take();

    expect(terminal.stdout.columns).toBe(process.stdout.columns);
    expect(terminal.stdout.rows).toBe(process.stdout.rows);
    expect(terminal.stdout.isTTY).toBe(process.stdout.isTTY);
    expect(typeof terminal.stdout.on).toBe('function');

    terminal.release();
  });

  it('should restore the real writers and be safe to release twice', () => {
    const written = captureRealWrites();
    const terminal = take();

    process.stdout.write('held');
    terminal.release();
    terminal.release();

    process.stdout.write('after');
    expect(written.stdout).toEqual(['held', 'after']);
  });

  it('should defer a held write\'s completion callback until it is replayed', () => {
    captureRealWrites();
    const terminal = take();
    const done = vi.fn();

    // Reporting completion before the bytes reached the terminal would be a lie.
    process.stdout.write('held', done);
    expect(done).not.toHaveBeenCalled();

    terminal.release();
    expect(done).toHaveBeenCalled();
  });

  it('should preserve the encoding a held write was given', () => {
    const written = captureRealWrites();
    const terminal = take();

    process.stdout.write('held', 'utf8');
    terminal.release();

    expect(written.stdout).toEqual(['held']);
  });

  it('should copy the buffer a held write was given', () => {
    const written = captureRealWrites();
    const terminal = take();
    const buffer = Buffer.from('original');

    process.stdout.write(buffer);
    buffer.fill(0);
    terminal.release();

    expect(written.stdout).toEqual(['original']);
  });

  it('should refuse a second owner instead of restoring stale writers', () => {
    captureRealWrites();
    const terminal = take();

    expect(() => takeTerminalOwnership()).toThrow('already held');

    terminal.release();
    const second = take();
    second.release();
  });

  it('should replay the rest of the queue when one write throws and report the first failure', () => {
    const written: string[] = [];
    let calls = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
      calls += 1;
      if (calls === 1) {
        throw new Error('replay failed');
      }
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const terminal = take();

    process.stdout.write('first');
    process.stdout.write('second');

    // Everything the provider wrote still reaches the terminal, and the failure
    // is not swallowed.
    expect(() => terminal.release()).toThrow('replay failed');
    expect(written).toEqual(['second']);
  });

  it('should restore the streams and flush the queue when the process exits', () => {
    const written = captureRealWrites();
    take();

    process.stdout.write('held for the exit');
    // A selector interrupted while Ink is mounted ends the process itself, so
    // `release()` never runs and only the exit handler is left to do it.
    process.emit('exit', 0);

    expect(written.stdout).toEqual(['held for the exit']);
  });

  it('should pass writes straight through once released', () => {
    const written = captureRealWrites();
    const terminal = take();
    const heldWriter = process.stdout.write.bind(process.stdout);

    terminal.release();
    // A writer that captured the hold function before the release must still land.
    heldWriter('late');

    expect(written.stdout).toEqual(['late']);
  });
});
