/** Normalize cancellation reasons to an AbortError for the provider failure classifier. */
function abortError(reason: unknown): Error {
  const message = reason instanceof Error ? reason.message : 'DeepSeek Harness execution aborted';
  const error = new Error(message || 'DeepSeek Harness execution aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Stop waiting when the signal aborts without cancelling the underlying operation.
 * Remove the listener when either the operation or cancellation settles the wait.
 */
export async function waitForAbortable<T>(
  operation: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (abortSignal === undefined) {
    return operation;
  }
  if (abortSignal.aborted) {
    throw abortError(abortSignal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      abortSignal.removeEventListener('abort', onAbort);
      reject(abortError(abortSignal.reason));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value: T) => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface SessionDispatchQueue {
  /** Schedule a turn after this session's previous turn; other sessions remain independent. */
  run<T>(
    sessionId: string,
    abortSignal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Forget queue bookkeeping during shutdown; this does not cancel scheduled operations. */
  clear(): void;
}

/**
 * Serialize turns per session, retaining the queue slot until the operation settles.
 * Aborting a caller's wait must not let the next turn overtake a still-running operation.
 */
export function createSessionDispatchQueue(): SessionDispatchQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    /** Skip aborted turns before dispatch and retain FIFO ordering after caller cancellation. */
    run<T>(
      sessionId: string,
      abortSignal: AbortSignal | undefined,
      operation: () => Promise<T>,
    ): Promise<T> {
      const previous = tails.get(sessionId) ?? Promise.resolve();
      const scheduled = previous.then(async () => {
        if (abortSignal?.aborted === true) {
          throw abortError(abortSignal.reason);
        }
        return operation();
      });
      const nextTail = scheduled.then(() => undefined, () => undefined);
      tails.set(sessionId, nextTail);
      void nextTail.then(() => {
        if (tails.get(sessionId) === nextTail) {
          tails.delete(sessionId);
        }
      });
      return waitForAbortable(scheduled, abortSignal);
    },

    /** Discard tail references after process shutdown without cancelling their promises. */
    clear(): void {
      tails.clear();
    },
  };
}

export { abortError };
