export interface LineTimeSliceBufferOptions {
  flushIntervalMs: number;
  onTimedFlush: (key: string, text: string) => void;
  minTimedFlushChars?: number;
  maxTimedBufferMs?: number;
}

export class LineTimeSliceBuffer {
  private static readonly DEFAULT_MIN_TIMED_FLUSH_CHARS = 24;
  private static readonly DEFAULT_MAX_TIMED_BUFFER_MS = 1500;
  private readonly flushIntervalMs: number;
  private readonly onTimedFlush: (key: string, text: string) => void;
  private readonly minTimedFlushChars: number;
  private readonly maxTimedBufferMs: number;
  private readonly buffers: Map<string, string> = new Map();
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();
  private readonly pendingSince: Map<string, number> = new Map();

  constructor(options: LineTimeSliceBufferOptions) {
    this.flushIntervalMs = options.flushIntervalMs;
    this.onTimedFlush = options.onTimedFlush;
    this.minTimedFlushChars = options.minTimedFlushChars ?? LineTimeSliceBuffer.DEFAULT_MIN_TIMED_FLUSH_CHARS;
    this.maxTimedBufferMs = options.maxTimedBufferMs ?? LineTimeSliceBuffer.DEFAULT_MAX_TIMED_BUFFER_MS;
  }

  addKey(key: string): void {
    if (!this.buffers.has(key)) {
      this.buffers.set(key, '');
    }
  }

  push(key: string, text: string): string[] {
    this.addKey(key);
    const buffer = this.buffers.get(key) ?? '';
    const combined = buffer + text;
    const parts = combined.split('\n');
    const remainder = parts.pop() ?? '';
    this.buffers.set(key, remainder);

    if (remainder === '') {
      this.pendingSince.delete(key);
      this.clearTimer(key);
    } else {
      if (!this.pendingSince.has(key)) {
        this.pendingSince.set(key, Date.now());
      }
      this.scheduleTimer(key);
    }

    return parts;
  }

  flushKey(key: string): string | undefined {
    this.clearTimer(key);
    this.pendingSince.delete(key);
    const buffer = this.buffers.get(key) ?? '';
    if (buffer === '') {
      return undefined;
    }
    this.buffers.set(key, '');
    return buffer;
  }

  flushAll(): Array<{ key: string; text: string }> {
    const result: Array<{ key: string; text: string }> = [];
    for (const key of this.buffers.keys()) {
      const text = this.flushKey(key);
      if (text !== undefined) {
        result.push({ key, text });
      }
    }
    return result;
  }

  private scheduleTimer(key: string): void {
    this.clearTimer(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const text = this.flushTimedKey(key);
      if (text !== undefined) {
        this.onTimedFlush(key, text);
      }
    }, this.flushIntervalMs);
    this.timers.set(key, timer);
  }

  private flushTimedKey(key: string): string | undefined {
    const buffer = this.buffers.get(key) ?? '';
    if (buffer === '') {
      this.pendingSince.delete(key);
      return undefined;
    }

    const startedAt = this.pendingSince.get(key) ?? Date.now();
    const elapsed = Date.now() - startedAt;
    const canForceFlush = elapsed >= this.maxTimedBufferMs;

    if (!canForceFlush && buffer.length < this.minTimedFlushChars) {
      this.scheduleTimer(key);
      return undefined;
    }

    const boundaryIndex = this.findBoundaryIndex(buffer);
    const flushIndex = boundaryIndex > 0
      ? boundaryIndex
      : buffer.length;

    const flushText = buffer.slice(0, flushIndex);
    const remainder = buffer.slice(flushIndex);
    this.buffers.set(key, remainder);

    if (remainder === '') {
      this.pendingSince.delete(key);
    } else {
      this.scheduleTimer(key);
    }

    return flushText;
  }

  private findBoundaryIndex(text: string): number {
    let lastIndex = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (this.isBoundary(ch)) {
        lastIndex = i;
      }
    }
    return lastIndex + 1;
  }

  private isBoundary(ch: string): boolean {
    return /\s|[,.!?;:、。！？；：（）\[\]{}]/u.test(ch);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(key);
  }
}
