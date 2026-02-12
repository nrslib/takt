import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAbortSignal } from '../core/piece/engine/abort-signal.js';

describe('buildAbortSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('タイムアウトでabortされる', () => {
    const { signal, dispose } = buildAbortSignal(100, undefined);

    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).message).toBe('Part timeout after 100ms');

    dispose();
  });

  it('親シグナルがabortされると子シグナルへ伝搬する', () => {
    const parent = new AbortController();
    const { signal, dispose } = buildAbortSignal(1000, parent.signal);
    const reason = new Error('parent aborted');

    parent.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);

    dispose();
  });

  it('disposeでタイマーと親リスナーを解放する', () => {
    const parent = new AbortController();
    const addSpy = vi.spyOn(parent.signal, 'addEventListener');
    const removeSpy = vi.spyOn(parent.signal, 'removeEventListener');
    const { signal, dispose } = buildAbortSignal(100, parent.signal);

    expect(addSpy).toHaveBeenCalledTimes(1);

    dispose();
    vi.advanceTimersByTime(200);

    expect(signal.aborted).toBe(false);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('親シグナルが既にabort済みなら即時伝搬する', () => {
    const parent = new AbortController();
    const reason = new Error('already aborted');
    const addSpy = vi.spyOn(parent.signal, 'addEventListener');
    parent.abort(reason);

    const { signal, dispose } = buildAbortSignal(1000, parent.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    expect(addSpy).not.toHaveBeenCalled();

    dispose();
  });
});
