import type { DaemonResources } from '../../../core/daemon/ports.js';

export const WATCH_INTERVALS = { process: 5_000, files: 5_000, log: 15_000, long: 60_000, launch: 30_000 } as const;
export const WATCH_THRESHOLDS = { log: 30 * 60_000, inquiry: 24 * 60 * 60_000, launch: 30_000,
  runDuration: 2 * 60 * 60_000, stepRepetitions: 5 } as const;

export interface WatchLoop extends DaemonResources {
  wake(): void;
  drain(): Promise<void>;
}

/** 観測完了後にだけ次回を予約する。watch の連続通知は1回にまとめる。 */
export function startWatchLoop(
  intervalMs: number | (() => number),
  observe: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
): WatchLoop {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let requested = false;
  let closing: Promise<void> | undefined;

  const wake = (): void => {
    if (controller.signal.aborted) return;
    clearTimeout(timer);
    if (running !== undefined) { requested = true; return; }
    running = Promise.resolve().then(async () => {
      do {
        requested = false;
        try { await observe(controller.signal); }
        catch (error) { if (!controller.signal.aborted) onError(error); }
      } while (requested && !controller.signal.aborted);
    }).finally(() => {
      running = undefined;
      if (!controller.signal.aborted) {
        timer = setTimeout(wake, typeof intervalMs === 'number' ? intervalMs : intervalMs());
        timer.unref();
      }
    });
  };
  wake();
  return {
    wake,
    async drain() { await running; },
    close() {
      closing ??= (async () => {
        controller.abort();
        clearTimeout(timer);
        await running;
      })();
      return closing;
    },
  };
}
