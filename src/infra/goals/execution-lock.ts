import { join } from 'node:path';
import { runPrivateFileExclusive, runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { GoalIdSchema } from './schema.js';

/** Pause publication must serialize with claim persistence and automatic launch. */
export function withGoalExecutionLock<Result>(cwd: string, action: () => Result): Result {
  return runPrivateFileExclusive(join(cwd, '.takt', 'goal-execution.lock'), action);
}

/** Serialize PR publication and completion evidence updates for one goal. */
export function withGoalCompletionLock<Result>(
  cwd: string, goalId: string, action: () => Result | PromiseLike<Result>,
): Promise<Result> {
  const id = GoalIdSchema.parse(goalId);
  return runPrivateFileExclusiveAsync(join(cwd, '.takt', 'goal-completion-locks', `${id}.lock`), action);
}
