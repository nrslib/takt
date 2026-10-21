import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForRateLimitRetry } from '../infra/rate-limit/retry.js';

afterEach(() => vi.useRealTimers());

describe('waitForRateLimitRetry', () => {
  it.each([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000].map((delay, index) => ({ retry: index + 1, delay })))(
    '$retry回目は$delay msの境界で待機を終える', async ({ retry, delay }) => {
      vi.useFakeTimers();
      const completed = vi.fn();
      const pending = waitForRateLimitRetry(retry, undefined).then(completed);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(completed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(completed).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])('中断時はタイマーとlistenerを解放する（中断済み: %s）', async (alreadyAborted) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    if (alreadyAborted) controller.abort(reason);
    const pending = waitForRateLimitRetry(1, controller.signal);
    const assertion = expect(pending).rejects.toBe(reason);
    if (!alreadyAborted) {
      await vi.advanceTimersByTimeAsync(500);
      controller.abort(reason);
    }
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('正常終了後もabort listenerを残さない', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = waitForRateLimitRetry(1, controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
});
