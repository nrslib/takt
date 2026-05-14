import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { delay } from '../shared/utils/delay.js';

describe('delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resolve before the timeout elapses', async () => {
    const resolved = vi.fn();
    void delay(1000).then(resolved);

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).not.toHaveBeenCalled();
  });

  it('resolves once the timeout elapses', async () => {
    const resolved = vi.fn();
    void delay(1000).then(resolved);

    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('resolves with undefined', async () => {
    const promise = delay(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves immediately for ms = 0', async () => {
    const resolved = vi.fn();
    void delay(0).then(resolved);

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledTimes(1);
  });
});
