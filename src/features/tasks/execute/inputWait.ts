/**
 * Shared input-wait state for worker pool log suppression.
 *
 * When a task is waiting for user input (e.g. iteration limit prompt),
 * the worker pool should suppress poll_tick debug logs to avoid
 * flooding the log file with identical entries.
 */

let waitCount = 0;

/** Call when entering an input-wait state (e.g. selectOption). */
export function enterInputWait(): void {
  waitCount++;
}

/** Call when leaving an input-wait state. */
export function leaveInputWait(): void {
  if (waitCount > 0) waitCount--;
}

/** Returns true if any task is currently waiting for user input. */
export function isInputWaiting(): boolean {
  return waitCount > 0;
}
