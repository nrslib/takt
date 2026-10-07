import { saveGoalCompletionEvidence } from '../goals/completion-evidence.js';
import type { TaskRecord } from './schema.js';
import { recordManagerRunFailure } from './manager-run-state.js';

export function publishTaskCompletionEvidence(cwd: string, task: TaskRecord): void {
  if (task.goal_id === undefined || task.completion === undefined) return;
  try { saveGoalCompletionEvidence(cwd, task); }
  catch (error) {
    // The task result is already committed. Evidence failure must not rewrite it as a task failure.
    recordManagerRunFailure(cwd, error);
  }
}
