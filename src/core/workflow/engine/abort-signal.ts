import { createPartTimeoutReason } from '../../../shared/types/agent-failure.js';
import { STALE_IN_FLIGHT_TOOL_FACTOR } from '../../../shared/types/provider-deadline.js';
import type {
  ProviderActivityCallback,
  ProviderActivityEvent,
} from '../../../shared/types/provider.js';

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

export interface InactivityAbortSignal {
  readonly signal: AbortSignal;
  readonly recordActivity: ProviderActivityCallback;
  readonly dispose: () => void;
}

export function buildInactivityAbortSignal(
  inactivityTimeoutMs: number,
  parentSignal: AbortSignal | undefined,
): InactivityAbortSignal {
  const timeoutController = new AbortController();
  const toolStaleTimeoutMs = inactivityTimeoutMs * STALE_IN_FLIGHT_TOOL_FACTOR;
  const inFlightTools = new Map<string, {
    readonly executionUnitKey: string;
    readonly startedAt: number;
  }>();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abortForInactivity = (): void => {
    timeoutController.abort(new Error(createPartTimeoutReason(inactivityTimeoutMs)));
  };
  const armTimeoutAt = (deadlineAt: number): void => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    timeoutId = setTimeout(abortForInactivity, Math.max(0, deadlineAt - Date.now()));
  };
  const armTimeout = (): void => {
    const earliestToolStart = inFlightTools.size === 0
      ? undefined
      : Math.min(...[...inFlightTools.values()].map(({ startedAt }) => startedAt));
    armTimeoutAt(
      earliestToolStart === undefined
        ? Date.now() + inactivityTimeoutMs
        : earliestToolStart + toolStaleTimeoutMs,
    );
  };
  const applyActivity = (activity: ProviderActivityEvent | undefined): void => {
    if (activity?.kind === 'attempt_started') {
      if (activity.executionUnitKey === undefined) {
        inFlightTools.clear();
      } else {
        for (const [toolCallKey, tool] of inFlightTools) {
          if (tool.executionUnitKey === activity.executionUnitKey) {
            inFlightTools.delete(toolCallKey);
          }
        }
      }
    } else if (activity?.kind === 'tool_started') {
      if (!inFlightTools.has(activity.toolCallKey)) {
        inFlightTools.set(activity.toolCallKey, {
          executionUnitKey: activity.executionUnitKey,
          startedAt: Date.now(),
        });
      }
    } else if (activity?.kind === 'tool_finished') {
      inFlightTools.delete(activity.toolCallKey);
    }
  };

  let abortListener: (() => void) | undefined;
  if (parentSignal) {
    abortListener = () => timeoutController.abort(parentSignal.reason);
    if (parentSignal.aborted) {
      abortListener();
    } else {
      parentSignal.addEventListener('abort', abortListener, { once: true });
    }
  }
  if (!timeoutController.signal.aborted) armTimeout();

  return {
    signal: timeoutController.signal,
    recordActivity: (activity) => {
      if (timeoutController.signal.aborted) return;
      applyActivity(activity);
      armTimeout();
    },
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      inFlightTools.clear();
      if (parentSignal && abortListener) {
        parentSignal.removeEventListener('abort', abortListener);
      }
    },
  };
}
