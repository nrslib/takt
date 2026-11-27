export const RATE_LIMIT_MAX_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

export async function waitForRateLimitRetry(retry: number, signal: AbortSignal | undefined): Promise<void> {
  const delayMs = Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retry - 1)), RETRY_MAX_DELAY_MS);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('Provider execution aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}
