import { GoalStore } from '../../../infra/goals/store.js';
import { createLogger } from '../../../shared/utils/debug.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { TaskStore } from '../../../infra/task/store.js';
import { TaskStoppedError } from '../../../infra/task/taskStop.js';

const log = createLogger('goal-abort-monitor');
const POLL_INTERVAL_MS = 500;

export class GoalAbortedError extends Error {
  constructor(goalId: string) {
    super(`Goal ${goalId} was aborted`);
    this.name = 'GoalAbortedError';
  }
}

export class GoalAbortMonitor {
  private readonly store: GoalStore | undefined;
  private readonly taskStore: TaskStore;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(cwd: string, private readonly goalId: string | undefined, private readonly controller: AbortController,
    private readonly execution: { taskName: string; executionId: string }) {
    this.store = goalId === undefined ? undefined : new GoalStore(cwd);
    this.taskStore = new TaskStore(cwd);
    this.check();
    if (!controller.signal.aborted) {
      this.timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
      this.timer.unref();
    }
  }

  check(): void {
    if (this.controller.signal.aborted) return;
    if (this.goalId !== undefined && this.store !== undefined) {
      try {
        const goal = this.store.getSync(this.goalId);
        if (goal?.executionStatus === 'aborted') this.controller.abort(new GoalAbortedError(this.goalId));
      } catch (error) {
        log.error('Cannot read goal execution state; will retry', {
          goalId: this.goalId, error: sanitizeSensitiveText(getErrorMessage(error)),
        });
      }
    }
    if (this.controller.signal.aborted) return;
    try {
      const task = this.taskStore.read().tasks.find((task) => task.name === this.execution.taskName);
      if (task !== undefined && task.goal_id === this.goalId && task.status === 'running'
        && task.execution_id === this.execution.executionId
        && task.stop_request?.execution_id === this.execution.executionId) {
        this.controller.abort(new TaskStoppedError(task.name, this.execution.executionId));
      }
    } catch (error) {
      log.error('Cannot read task stop request; will retry', {
        goalId: this.goalId, taskName: this.execution.taskName,
        error: sanitizeSensitiveText(getErrorMessage(error)),
      });
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
