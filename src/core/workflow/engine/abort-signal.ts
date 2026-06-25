import { createPartTimeoutReason } from '../../../shared/types/agent-failure.js';

export function buildAbortSignal(
  timeoutMs: number,
  parentSignal: AbortSignal | readonly AbortSignal[] | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error(createPartTimeoutReason(timeoutMs)));
  }, timeoutMs);

  const parentSignals = Array.isArray(parentSignal)
    ? parentSignal
    : parentSignal ? [parentSignal] : [];
  const abortListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of parentSignals) {
    const listener = () => timeoutController.abort(signal.reason);
    if (signal.aborted) {
      listener();
    } else {
      signal.addEventListener('abort', listener, { once: true });
      abortListeners.push({ signal, listener });
    }
  }

  return {
    signal: timeoutController.signal,
    dispose: () => {
      clearTimeout(timeoutId);
      for (const { signal, listener } of abortListeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}
