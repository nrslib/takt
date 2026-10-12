import { GoalStore } from '../../../infra/goals/store.js';
import { createLogger } from '../../../shared/utils/debug.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';

const log = createLogger('goal-abort-monitor');
const POLL_INTERVAL_MS = 500;

export class GoalAbortedError extends Error {
  constructor(goalId: string) {
    super(`Goal ${goalId} was aborted`);
    this.name = 'GoalAbortedError';
  }
}

export class GoalAbortMonitor {
  private readonly store: GoalStore;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(cwd: string, private readonly goalId: string, private readonly controller: AbortController) {
    this.store = new GoalStore(cwd);
    this.check();
    if (!controller.signal.aborted) {
      this.timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
      this.timer.unref();
    }
  }

  check(): void {
    if (this.controller.signal.aborted) return;
    let goal;
    try { goal = this.store.getSync(this.goalId); }
    catch (error) {
      log.error('Cannot read goal execution state; will retry', {
        goalId: this.goalId, error: sanitizeSensitiveText(getErrorMessage(error)),
      });
      return;
    }
    if (goal.executionStatus === 'aborted') this.controller.abort(new GoalAbortedError(this.goalId));
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
