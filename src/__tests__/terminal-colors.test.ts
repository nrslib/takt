import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_USER_MESSAGE_COLORS,
  TERMINAL_BACKGROUND_QUERY_TIMEOUT_MS,
  parseTerminalBackgroundResponse,
  queryTerminalBackground,
  userMessageColorsForBackground,
} from '../features/tui/terminalColors.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readonly _readableState = { flowing: null as boolean | null };
  readonly rawModeCalls: boolean[] = [];
  readonly unshifted: Buffer[] = [];

  get readableFlowing(): boolean | null {
    return this._readableState.flowing;
  }

  read(): null {
    return null;
  }

  pause(): this {
    this._readableState.flowing = false;
    return this;
  }

  resume(): this {
    this._readableState.flowing = true;
    return this;
  }

  unshift(chunk: Uint8Array): boolean {
    this.unshifted.push(Buffer.from(chunk));
    return true;
  }

  setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    this.isRaw = mode;
    return this;
  }
}

class FakeOutput {
  isTTY = true;
  readonly writes: string[] = [];
  onWrite: (() => void) | undefined;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.onWrite?.();
    return true;
  }
}

class ReadableInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawModeCalls: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    this.isRaw = mode;
    return this;
  }
}

async function flushReadableEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('user message terminal colors', () => {
  it('should blend a dark terminal background with white at twelve percent', () => {
    expect(userMessageColorsForBackground({ red: 0x29, green: 0x2c, blue: 0x33 })).toEqual({
      background: '#42454b',
    });
  });

  it('should blend a light terminal background with black at four percent', () => {
    expect(userMessageColorsForBackground({ red: 0xe0, green: 0xe0, blue: 0xe0 })).toEqual({
      background: '#d7d7d7',
    });
  });

  it('should treat luminance 128 as dark', () => {
    expect(userMessageColorsForBackground({ red: 0x80, green: 0x80, blue: 0x80 }).background)
      .toBe('#8f8f8f');
  });

  it('should parse two- and four-digit OSC 11 RGB components', () => {
    expect(parseTerminalBackgroundResponse('rgb:2929/2c2c/3333')).toEqual({
      red: 0x29,
      green: 0x2c,
      blue: 0x33,
    });
    expect(parseTerminalBackgroundResponse('rgb:aa/bb/cc')).toEqual({
      red: 0xaa,
      green: 0xbb,
      blue: 0xcc,
    });
    expect(parseTerminalBackgroundResponse('rgb:gggg/0000/0000')).toBeNull();
  });

  it('should use the readable fallback without probing a non-TTY', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    input.isTTY = false;

    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: FALLBACK_USER_MESSAGE_COLORS,
    });
    expect(output.writes).toEqual([]);

    input.isTTY = true;
    output.isTTY = false;
    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: FALLBACK_USER_MESSAGE_COLORS,
    });
    expect(output.writes).toEqual([]);
  });

  it('should not compete with an existing stdin data listener', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    input.on('data', () => undefined);

    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: FALLBACK_USER_MESSAGE_COLORS,
    });
    expect(output.writes).toEqual([]);
    expect(input.listenerCount('data')).toBe(1);
  });

  it('should parse the response, replay unrelated input, and restore stdin', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.onWrite = () => {
      input.emit('data', Buffer.from('typed\x1b]11;rgb:2929'));
      input.emit('data', Buffer.from('/2c2c/3333\x1b\\tail'));
    };

    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: {
        background: '#42454b',
      },
    });
    expect(output.writes).toEqual(['\x1b]11;?\x1b\\']);
    expect(Buffer.concat(input.unshifted).toString()).toBe('typedtail');
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('should fall back after an unanswered query without hanging', async () => {
    vi.useFakeTimers();
    try {
      const input = new FakeInput();
      const output = new FakeOutput();
      const result = queryTerminalBackground(input, output);

      await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_QUERY_TIMEOUT_MS);
      const resolution = await result;
      expect(resolution.colors).toBe(FALLBACK_USER_MESSAGE_COLORS);
      expect(resolution.delayedResponseGuard).toBeDefined();
      expect(input.listenerCount('data')).toBe(0);
      expect(input.rawModeCalls).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should clean up each probe so a remount can probe again', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.onWrite = (() => {
      let count = 0;
      return () => {
        count += 1;
        const color = count === 1 ? '2929/2c2c/3333' : 'e0e0/e0e0/e0e0';
        input.emit('data', Buffer.from(`\x1b]11;rgb:${color}\x1b\\`));
      };
    })();

    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: {
        background: '#42454b',
      },
    });
    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: {
        background: '#d7d7d7',
      },
    });
    expect(input.listenerCount('data')).toBe(0);
    expect(input.rawModeCalls).toEqual([true, false, true, false]);
    expect(output.writes).toHaveLength(2);
  });

  it.each([
    { name: 'null', flowing: null },
    { name: 'false', flowing: false },
    { name: 'true', flowing: true },
  ])('should restore readableFlowing $name after probing', async ({ flowing }) => {
    const input = new FakeInput();
    const output = new FakeOutput();
    if (flowing === true) {
      input.resume();
    } else if (flowing === false) {
      input.pause();
    }
    output.onWrite = () => {
      input.emit('data', Buffer.from('\x1b]11;rgb:2929/2c2c/3333\x1b\\'));
    };

    await queryTerminalBackground(input, output);

    expect(input.readableFlowing).toBe(flowing);
  });

  it('should accept C1 ST as the OSC terminator', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.onWrite = () => {
      input.emit('data', Buffer.concat([
        Buffer.from('\x1b]11;rgb:2929/2c2c/3333'),
        Buffer.from([0x9c]),
      ]));
    };

    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: {
        background: '#42454b',
      },
    });
  });

  it('should isolate a delayed response from the next Ink readable input', async () => {
    vi.useFakeTimers();
    try {
      const input = new ReadableInput();
      const output = new FakeOutput();
      const result = queryTerminalBackground(input, output);

      await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_QUERY_TIMEOUT_MS);
      const resolution = await result;
      vi.useRealTimers();
      const guard = resolution.delayedResponseGuard;
      expect(guard).toBeDefined();
      expect(input.readableFlowing).toBeNull();

      guard?.attach();
      input.setEncoding('utf8');
      const inkInput: string[] = [];
      const onReadable = (): void => {
        let chunk: Buffer | string | null;
        while ((chunk = input.read()) !== null) {
          inkInput.push(Buffer.from(chunk).toString());
        }
      };
      input.on('readable', onReadable);

      input.push(Buffer.from('typed-before'));
      await flushReadableEvents();
      input.push(Buffer.from('\x1b'));
      await flushReadableEvents();
      input.push(Buffer.from('\x1b]11;rgb:2929'));
      await flushReadableEvents();
      input.push(Buffer.concat([
        Buffer.from('/2c2c/3333'),
        Buffer.from([0x9c]),
      ]));
      input.push(Buffer.from('typed-after'));
      await flushReadableEvents();

      expect(inkInput.join('')).toBe('typed-before\x1btyped-after');

      input.removeListener('readable', onReadable);
      guard?.detach();
      expect(input.listenerCount('readable')).toBe(0);
      expect(input.readableFlowing).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should fall back when installing the probe data listener throws', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    Object.defineProperty(input, 'on', {
      value: (): never => {
        throw new Error('on failed');
      },
    });

    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: FALLBACK_USER_MESSAGE_COLORS,
    });
    expect(output.writes).toEqual([]);
  });

  it('should fall back when removing the probe data listener throws', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    Object.defineProperty(input, 'removeListener', {
      value: (): never => {
        throw new Error('removeListener failed');
      },
    });
    output.onWrite = () => {
      input.emit('data', Buffer.from('\x1b]11;rgb:2929/2c2c/3333\x1b\\'));
    };

    await expect(queryTerminalBackground(input, output)).resolves.toEqual({
      colors: FALLBACK_USER_MESSAGE_COLORS,
    });
    expect(input.readableFlowing).toBeNull();
  });
});
