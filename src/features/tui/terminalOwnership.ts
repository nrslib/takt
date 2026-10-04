/**
 * While Ink is mounted it owns the terminal: each frame is erased by moving the
 * cursor up exactly as many lines as the previous frame occupied. Any other
 * writer moves the cursor without Ink knowing, so the next erase misses rows and
 * they are stranded in the scrollback — spinner and prompt fragments wedged
 * between the confirmed messages.
 *
 * Foreign writes are therefore held back and replayed once Ink has let go, which
 * keeps the frame accounting exact without losing anything a provider printed.
 */

type StreamWrite = typeof process.stdout.write;
type WriteCallback = (error?: Error | null) => void;

interface HeldWrite {
  readonly write: StreamWrite;
  /** Copied on capture: a caller may reuse its buffer before the replay runs. */
  readonly chunk: string | Uint8Array;
  readonly encoding: BufferEncoding | undefined;
  readonly callback: WriteCallback | undefined;
}

export interface TerminalOwnership {
  /** Hand these to Ink; they bypass the hold and reach the terminal directly. */
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  /** Restore the real streams and replay everything written meanwhile. */
  release(): void;
}

/** Only one owner can hold the process streams; a second would restore stale writers. */
let ownershipHeld = false;

/** Reflect.get with `target` as receiver so the stream's own getters still work. */
function createDirectStream(stream: NodeJS.WriteStream, directWrite: StreamWrite): NodeJS.WriteStream {
  return new Proxy(stream, {
    get(target, property) {
      if (property === 'write') {
        return directWrite;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function copyChunk(chunk: string | Uint8Array): string | Uint8Array {
  return typeof chunk === 'string' ? chunk : Uint8Array.prototype.slice.call(chunk);
}

function replayHeldWrite(entry: HeldWrite): void {
  if (entry.encoding === undefined) {
    entry.write(entry.chunk, entry.callback);
    return;
  }
  entry.write(entry.chunk as string, entry.encoding, entry.callback);
}

export function takeTerminalOwnership(): TerminalOwnership {
  if (ownershipHeld) {
    throw new Error('Terminal ownership is already held; release it before taking it again.');
  }
  ownershipHeld = true;

  const directStdoutWrite = process.stdout.write.bind(process.stdout) as StreamWrite;
  const directStderrWrite = process.stderr.write.bind(process.stderr) as StreamWrite;
  const held: HeldWrite[] = [];
  let released = false;

  function hold(directWrite: StreamWrite): StreamWrite {
    const write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ): boolean => {
      const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      // A writer that kept a reference to this function past the release must
      // reach the terminal instead of filling a queue nobody drains.
      if (released) {
        return encoding === undefined
          ? directWrite(chunk, done)
          : directWrite(chunk as string, encoding, done);
      }
      held.push({ write: directWrite, chunk: copyChunk(chunk), encoding, callback: done });
      // Held in memory, so there is no backpressure to report.
      return true;
    };
    return write as StreamWrite;
  }

  process.stdout.write = hold(directStdoutWrite);
  process.stderr.write = hold(directStderrWrite);

  /**
   * A selector opened while Ink is mounted ends the process itself when the user
   * interrupts it (`shared/prompt/select.ts` exits with 130), and `release()`
   * never runs. Everything the queue holds — a provider's log, a warning about
   * why the run stopped — would go down with it, which is exactly the output the
   * failure needs. `exit` handlers can only do synchronous work, which restoring
   * the streams and replaying the queue are.
   */
  const releaseOnExit = (): void => {
    restoreAndReplay();
  };
  process.once('exit', releaseOnExit);

  function restoreAndReplay(): void {
    released = true;
    ownershipHeld = false;
    process.stdout.write = directStdoutWrite;
    process.stderr.write = directStderrWrite;

    // Drain the whole queue even if one replay throws, then surface the first
    // failure — losing the rest of a provider's output would hide more than it
    // reports.
    let firstFailure: unknown;
    // Tracked separately from the value: a thrown `undefined` is still a failure.
    let hasFailure = false;
    for (const entry of held) {
      try {
        replayHeldWrite(entry);
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = error;
        }
      }
    }
    held.length = 0;
    if (hasFailure) {
      throw firstFailure;
    }
  }

  return {
    stdout: createDirectStream(process.stdout, directStdoutWrite),
    stderr: createDirectStream(process.stderr, directStderrWrite),
    release(): void {
      if (released) {
        return;
      }
      process.off('exit', releaseOnExit);
      restoreAndReplay();
    },
  };
}
