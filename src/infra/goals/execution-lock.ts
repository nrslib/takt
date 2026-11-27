import { join } from 'node:path';
import { runPrivateFileExclusive } from '../../shared/utils/private-file-lock.js';

/** Pause publication must serialize with claim persistence and automatic launch. */
export function withGoalExecutionLock<Result>(cwd: string, action: () => Result): Result {
  return runPrivateFileExclusive(join(cwd, '.takt', 'goal-execution.lock'), action);
}
