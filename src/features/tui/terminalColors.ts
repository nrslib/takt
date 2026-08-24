import { Buffer } from 'node:buffer';

export interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface UserMessageColors {
  readonly background: string;
  /** Omitted to keep the terminal's default foreground without resetting the background. */
  readonly foreground?: string;
}

interface TerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing: boolean | null;
  readonly _readableState?: {
    flowing: boolean | null;
  };
  listenerCount(eventName: string): number;
  on(eventName: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  on(eventName: 'readable', listener: () => void): unknown;
  removeListener(eventName: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  removeListener(eventName: 'readable', listener: () => void): unknown;
  read(): Uint8Array | string | null;
  pause(): unknown;
  resume(): unknown;
  unshift(chunk: Uint8Array): void;
  setRawMode?: (mode: boolean) => unknown;
}

interface TerminalOutput {
  readonly isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface TerminalInputGuard {
  attach(): void;
  detach(): void;
}

export interface UserMessageColorResolution {
  readonly colors: UserMessageColors;
  readonly delayedResponseGuard?: TerminalInputGuard;
}

const OSC_BACKGROUND_QUERY = '\x1b]11;?\x1b\\';
const OSC_BACKGROUND_PREFIX = Buffer.from('\x1b]11;');
const TERMINAL_BACKGROUND_QUERY_TIMEOUT_MS = 50;
const DARK_BACKGROUND_LUMINANCE_THRESHOLD = 128;
const DARK_BACKGROUND_ALPHA = 0.12;
const LIGHT_BACKGROUND_ALPHA = 0.04;

/** The previous fixed band remains a readable fallback when the probe cannot run. */
export const FALLBACK_USER_MESSAGE_COLORS: UserMessageColors = {
  background: '#42454b',
  foreground: '#ffffff',
};

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.trunc(value)));
}

function formatChannel(value: number): string {
  return clampChannel(value).toString(16).padStart(2, '0');
}

function blendChannel(base: number, overlay: number, alpha: number): number {
  return clampChannel(base * (1 - alpha) + overlay * alpha);
}

/** Reproduces Codex's dark/light terminal-background blend for the user band. */
export function userMessageColorsForBackground(background: RgbColor): UserMessageColors {
  const luminance = background.red * 0.299
    + background.green * 0.587
    + background.blue * 0.114;
  const isDark = luminance <= DARK_BACKGROUND_LUMINANCE_THRESHOLD;
  const alpha = isDark ? DARK_BACKGROUND_ALPHA : LIGHT_BACKGROUND_ALPHA;
  const overlay = isDark ? 255 : 0;

  return {
    background: `#${formatChannel(blendChannel(background.red, overlay, alpha))}`
      + `${formatChannel(blendChannel(background.green, overlay, alpha))}`
      + formatChannel(blendChannel(background.blue, overlay, alpha)),
  };
}

function parseRgbComponent(value: string): number | null {
  if (value.length === 2) {
    return Number.parseInt(value, 16);
  }
  if (value.length === 4) {
    return Math.round(Number.parseInt(value, 16) / 257);
  }
  return null;
}

/** Parses the rgb:rr/gg/bb or rgb:rrrr/gggg/bbbb payload used by OSC 11. */
export function parseTerminalBackgroundResponse(payload: string): RgbColor | null {
  const match = /^rgb:([\da-f]{2}|[\da-f]{4})\/([\da-f]{2}|[\da-f]{4})\/([\da-f]{2}|[\da-f]{4})$/i.exec(payload);
  if (match === null) {
    return null;
  }

  const red = parseRgbComponent(match[1] ?? '');
  const green = parseRgbComponent(match[2] ?? '');
  const blue = parseRgbComponent(match[3] ?? '');
  if (red === null || green === null || blue === null) {
    return null;
  }
  return { red, green, blue };
}

function findPrefix(buffer: Buffer): number {
  for (let index = 0; index <= buffer.length - OSC_BACKGROUND_PREFIX.length; index += 1) {
    if (buffer.subarray(index, index + OSC_BACKGROUND_PREFIX.length).equals(OSC_BACKGROUND_PREFIX)) {
      return index;
    }
  }
  return -1;
}

function partialPrefixLength(buffer: Buffer): number {
  const maxLength = Math.min(OSC_BACKGROUND_PREFIX.length - 1, buffer.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (buffer.subarray(buffer.length - length).equals(OSC_BACKGROUND_PREFIX.subarray(0, length))) {
      return length;
    }
  }
  return 0;
}

interface OscTerminator {
  readonly payloadEnd: number;
  readonly sequenceEnd: number;
}

function findOscTerminator(buffer: Buffer): OscTerminator | null {
  for (let index = OSC_BACKGROUND_PREFIX.length; index < buffer.length; index += 1) {
    if (buffer[index] === 0x07) {
      return { payloadEnd: index, sequenceEnd: index + 1 };
    }
    if (buffer[index] === 0x1b && buffer[index + 1] === 0x5c) {
      return { payloadEnd: index, sequenceEnd: index + 2 };
    }
    if (buffer[index] === 0x9c) {
      return { payloadEnd: index, sequenceEnd: index + 1 };
    }
    // Ink sets stdin to UTF-8 before it installs its readable listener. A raw
    // C1 ST byte is then decoded as a replacement character by StringDecoder.
    if (buffer[index] === 0xc2 && buffer[index + 1] === 0x9c) {
      return { payloadEnd: index, sequenceEnd: index + 2 };
    }
    if (buffer[index] === 0xef && buffer[index + 1] === 0xbf && buffer[index + 2] === 0xbd) {
      return { payloadEnd: index, sequenceEnd: index + 3 };
    }
  }
  return null;
}

function asBuffer(chunk: Uint8Array | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
}

interface OscBackgroundParseResult {
  readonly unrelatedInput: readonly Buffer[];
  readonly backgrounds: readonly RgbColor[];
}

class OscBackgroundResponseParser {
  private pending = Buffer.alloc(0);

  push(chunk: Uint8Array | string): OscBackgroundParseResult {
    const unrelatedInput: Buffer[] = [];
    const backgrounds: RgbColor[] = [];
    this.pending = Buffer.concat([this.pending, asBuffer(chunk)]);

    while (this.pending.length > 0) {
      const prefixIndex = findPrefix(this.pending);
      if (prefixIndex < 0) {
        const keepLength = partialPrefixLength(this.pending);
        const outputLength = this.pending.length - keepLength;
        if (outputLength > 0) {
          unrelatedInput.push(this.pending.subarray(0, outputLength));
        }
        this.pending = keepLength > 0 ? this.pending.subarray(outputLength) : Buffer.alloc(0);
        break;
      }
      if (prefixIndex > 0) {
        unrelatedInput.push(this.pending.subarray(0, prefixIndex));
        this.pending = this.pending.subarray(prefixIndex);
      }

      const terminator = findOscTerminator(this.pending);
      if (terminator === null) {
        break;
      }

      const sequence = this.pending.subarray(0, terminator.sequenceEnd);
      const payload = this.pending
        .subarray(OSC_BACKGROUND_PREFIX.length, terminator.payloadEnd)
        .toString('ascii');
      this.pending = this.pending.subarray(terminator.sequenceEnd);
      const background = parseTerminalBackgroundResponse(payload);
      if (background !== null) {
        backgrounds.push(background);
        continue;
      }
      // Preserve malformed or unrelated OSC data; only a valid color response
      // is ours to consume.
      unrelatedInput.push(sequence);
    }

    return { unrelatedInput, backgrounds };
  }

  flush(): Buffer[] {
    if (this.pending.length === 0) {
      return [];
    }
    const pending = this.pending;
    this.pending = Buffer.alloc(0);
    return [pending];
  }
}

function restoreFlowingState(stdin: TerminalInput, wasFlowing: boolean | null): boolean {
  let restored = true;
  try {
    if (wasFlowing === true) {
      stdin.resume();
    } else {
      stdin.pause();
    }
  } catch {
    restored = false;
  }

  try {
    if (stdin.readableFlowing !== wasFlowing && stdin._readableState !== undefined) {
      stdin._readableState.flowing = wasFlowing;
    }
    if (stdin.readableFlowing !== wasFlowing) {
      restored = false;
    }
  } catch {
    restored = false;
  }
  return restored;
}

function createDelayedResponseGuard(stdin: TerminalInput): TerminalInputGuard {
  const parser = new OscBackgroundResponseParser();
  let attached = false;
  let reading = false;
  let previousFlowing: boolean | null | undefined;

  const replay = (chunks: readonly Buffer[]): void => {
    if (chunks.length === 0) {
      return;
    }
    try {
      stdin.unshift(Buffer.concat(chunks));
    } catch {
      // A stream that rejects unshift() has no safe replay operation. The guard
      // must still detach so it cannot keep the TUI alive or throw from readable.
    }
  };

  const onReadable = (): void => {
    if (!attached || reading) {
      return;
    }

    let hasInkReader = false;
    try {
      hasInkReader = stdin.listenerCount('readable') > 1;
    } catch {
      return;
    }
    if (!hasInkReader) {
      return;
    }

    reading = true;
    const unrelatedInput: Buffer[] = [];
    try {
      let chunk: Uint8Array | string | null;
      while ((chunk = stdin.read()) !== null) {
        const result = parser.push(chunk);
        unrelatedInput.push(...result.unrelatedInput);
      }
      replay(unrelatedInput);
    } catch {
      replay([...unrelatedInput, ...parser.flush()]);
    } finally {
      reading = false;
    }
  };

  return {
    attach(): void {
      if (attached) {
        return;
      }

      try {
        if (stdin.listenerCount('data') > 0) {
          return;
        }
        previousFlowing = stdin.readableFlowing;
        stdin.on('readable', onReadable);
        attached = true;
      } catch {
        try {
          stdin.removeListener('readable', onReadable);
        } catch {
          // The guard is optional and must not turn an input setup failure into
          // a failed conversation.
        }
        if (previousFlowing !== undefined) {
          restoreFlowingState(stdin, previousFlowing);
        }
        previousFlowing = undefined;
      }
    },
    detach(): void {
      if (!attached) {
        return;
      }
      attached = false;
      try {
        stdin.removeListener('readable', onReadable);
      } catch {
        // Continue restoring the buffered bytes and stream state.
      }
      replay(parser.flush());
      if (previousFlowing !== undefined) {
        restoreFlowingState(stdin, previousFlowing);
      }
      previousFlowing = undefined;
    },
  };
}

/**
 * Reads one terminal background response without consuming unrelated input.
 * The probe is deliberately optional: a TTY can decline or ignore OSC 11.
 */
export function queryTerminalBackground(
  stdin: TerminalInput,
  stdout: TerminalOutput,
): Promise<UserMessageColorResolution> {
  try {
    if (
      stdin.isTTY !== true
      || stdout.isTTY !== true
      || stdin.listenerCount('data') > 0
      || stdin.listenerCount('readable') > 0
    ) {
      return Promise.resolve({ colors: FALLBACK_USER_MESSAGE_COLORS });
    }
  } catch {
    return Promise.resolve({ colors: FALLBACK_USER_MESSAGE_COLORS });
  }

  let wasRaw: boolean;
  let wasFlowing: boolean | null;
  try {
    wasRaw = stdin.isRaw === true;
    wasFlowing = stdin.readableFlowing;
  } catch {
    return Promise.resolve({ colors: FALLBACK_USER_MESSAGE_COLORS });
  }

  return new Promise((resolve) => {
    let settled = false;
    const unrelatedInput: Buffer[] = [];
    const parser = new OscBackgroundResponseParser();

    const restoreInput = (): boolean => {
      let restored = true;
      const pendingInput = parser.flush();
      unrelatedInput.push(...pendingInput);
      try {
        stdin.removeListener('data', onData);
      } catch {
        restored = false;
      }
      try {
        stdin.pause();
      } catch {
        restored = false;
      }
      try {
        if (stdin.setRawMode !== undefined) {
          stdin.setRawMode(wasRaw);
        }
      } catch {
        restored = false;
      }
      if (unrelatedInput.length > 0) {
        try {
          stdin.unshift(Buffer.concat(unrelatedInput));
        } catch {
          restored = false;
        }
      }
      return restoreFlowingState(stdin, wasFlowing) && restored;
    };

    const finish = (
      colors: UserMessageColors,
      delayedResponseGuard?: TerminalInputGuard,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        clearTimeout(timeout);
      } catch {
        // A failed timer cleanup must not leave the probe promise pending.
      }
      let restored = true;
      try {
        restored = restoreInput();
      } catch {
        restored = false;
      }
      resolve({
        colors: restored ? colors : FALLBACK_USER_MESSAGE_COLORS,
        ...(restored && delayedResponseGuard !== undefined ? { delayedResponseGuard } : {}),
      });
    };

    const timeout = setTimeout(
      () => finish(FALLBACK_USER_MESSAGE_COLORS, createDelayedResponseGuard(stdin)),
      TERMINAL_BACKGROUND_QUERY_TIMEOUT_MS,
    );

    const onData = (chunk: Uint8Array | string): void => {
      if (settled) {
        return;
      }
      try {
        const result = parser.push(chunk);
        unrelatedInput.push(...result.unrelatedInput);
        const background = result.backgrounds[0];
        if (background !== undefined) {
          finish(userMessageColorsForBackground(background));
        }
      } catch {
        finish(FALLBACK_USER_MESSAGE_COLORS);
      }
    };

    try {
      stdin.on('data', onData);
      if (stdin.setRawMode !== undefined) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdout.write(OSC_BACKGROUND_QUERY);
    } catch {
      finish(FALLBACK_USER_MESSAGE_COLORS);
    }
  });
}

export function resolveUserMessageColors(): Promise<UserMessageColorResolution> {
  return queryTerminalBackground(process.stdin, process.stdout);
}

export { TERMINAL_BACKGROUND_QUERY_TIMEOUT_MS };
