export interface RetryStrategy {
  delayMs(attempt: number): number;
}

export class FixedDelayStrategy implements RetryStrategy {
  constructor(private readonly ms: number) {}

  delayMs(): number {
    return this.ms;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { retries?: number; strategy?: RetryStrategy },
): Promise<T> {
  const retries = options?.retries ?? 3;
  const strategy = options?.strategy ?? new FixedDelayStrategy(100);
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, strategy.delayMs(attempt)));
    }
  }
  throw lastError;
}
