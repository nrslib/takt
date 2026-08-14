import { createPartTimeoutReason } from '../../../shared/types/agent-failure.js';

export interface AbortScope {
  readonly signal: AbortSignal;
  readonly abort: (reason: unknown) => void;
  readonly dispose: () => void;
}

export function createAbortScope(parentSignal: AbortSignal | undefined): AbortScope {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => parentSignal?.removeEventListener('abort', onParentAbort),
  };
}

export function buildAbortSignal(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  deadlineAt?: number,
): { signal: AbortSignal; dispose: () => void } {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error(createPartTimeoutReason(timeoutMs)));
  }, deadlineAt === undefined ? timeoutMs : Math.max(0, deadlineAt - Date.now()));

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
