export function buildAbortSignal(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error(`Part timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  let abortListener: (() => void) | undefined;
  if (parentSignal) {
    abortListener = () => timeoutController.abort(parentSignal.reason);
    if (parentSignal.aborted) {
      abortListener();
    } else {
      parentSignal.addEventListener('abort', abortListener, { once: true });
    }
  }

  return {
    signal: timeoutController.signal,
    dispose: () => {
      clearTimeout(timeoutId);
      if (parentSignal && abortListener) {
        parentSignal.removeEventListener('abort', abortListener);
      }
    },
  };
}
