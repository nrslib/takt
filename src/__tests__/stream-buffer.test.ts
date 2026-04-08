import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LineTimeSliceBuffer } from '../core/workflow/engine/stream-buffer.js';

describe('LineTimeSliceBuffer', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('改行までを返し、残りはバッファする', () => {
    const flushed: Array<{ key: string; text: string }> = [];
    const buffer = new LineTimeSliceBuffer({
      flushIntervalMs: 100,
      onTimedFlush: (key, text) => flushed.push({ key, text }),
    });

    const lines = buffer.push('a', 'hello\nworld');
    expect(lines).toEqual(['hello']);
    expect(flushed).toEqual([]);
  });

  it('time-slice経過で未改行バッファをflushする', async () => {
    vi.useFakeTimers();
    const flushed: Array<{ key: string; text: string }> = [];
    const buffer = new LineTimeSliceBuffer({
      flushIntervalMs: 50,
      minTimedFlushChars: 1,
      onTimedFlush: (key, text) => flushed.push({ key, text }),
    });

    buffer.push('a', 'partial');
    expect(flushed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60);
    expect(flushed).toEqual([{ key: 'a', text: 'partial' }]);
  });

  it('time-slice flush は境界（空白/句読点）までで切る', async () => {
    vi.useFakeTimers();
    const flushed: Array<{ key: string; text: string }> = [];
    const buffer = new LineTimeSliceBuffer({
      flushIntervalMs: 50,
      minTimedFlushChars: 10,
      onTimedFlush: (key, text) => flushed.push({ key, text }),
    });

    buffer.push('a', 'hello world from buffer');
    await vi.advanceTimersByTimeAsync(60);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual({ key: 'a', text: 'hello world from ' });
    expect(buffer.flushAll()).toEqual([{ key: 'a', text: 'buffer' }]);
  });

  it.each([1, 10, 24, 30])(
    '先頭の境界文字だけでは切らず、minTimedFlushChars=%s でも同一語を分割しない',
    async (minTimedFlushChars) => {
      vi.useFakeTimers();
      const flushed: Array<{ key: string; text: string }> = [];
      const buffer = new LineTimeSliceBuffer({
        flushIntervalMs: 50,
        minTimedFlushChars,
        maxTimedBufferMs: 120,
        onTimedFlush: (key, text) => flushed.push({ key, text }),
      });

      buffer.push('a', ' ag');
      await vi.advanceTimersByTimeAsync(50);
      expect(flushed).toHaveLength(0);

      buffer.push('a', 'ent');
      await vi.advanceTimersByTimeAsync(100);

      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toEqual({ key: 'a', text: ' agent' });
      expect(buffer.flushAll()).toEqual([]);
    },
  );

  it('境界がない文字列は maxTimedBufferMs 経過後に強制flushする', async () => {
    vi.useFakeTimers();
    const flushed: Array<{ key: string; text: string }> = [];
    const buffer = new LineTimeSliceBuffer({
      flushIntervalMs: 50,
      minTimedFlushChars: 100,
      maxTimedBufferMs: 120,
      onTimedFlush: (key, text) => flushed.push({ key, text }),
    });

    buffer.push('a', '高松市保育需要');
    await vi.advanceTimersByTimeAsync(60);
    expect(flushed).toEqual([]);

    await vi.advanceTimersByTimeAsync(120);
    expect(flushed).toEqual([{ key: 'a', text: '高松市保育需要' }]);
  });

  it('flushAllでタイマーを止めて内容を回収する', () => {
    const flushed: Array<{ key: string; text: string }> = [];
    const buffer = new LineTimeSliceBuffer({
      flushIntervalMs: 100,
      onTimedFlush: (key, text) => flushed.push({ key, text }),
    });

    buffer.push('a', 'x');
    buffer.push('b', 'y');

    expect(buffer.flushAll()).toEqual([
      { key: 'a', text: 'x' },
      { key: 'b', text: 'y' },
    ]);
    expect(flushed).toEqual([]);
  });
});
