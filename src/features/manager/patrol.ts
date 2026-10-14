import { readManagerEvents, saveManagerEvent } from '../../infra/goals/events.js';
import type { Goal } from '../../infra/goals/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('manager-patrol');

export function isGoalPatrolDue(goal: Goal, now: number, intervalSeconds: number): boolean {
  if (goal.status === 'completed' || goal.executionStatus !== 'active') return false;
  const previous = goal.lastPatrolCompletedAt ?? goal.createdAt;
  return previous === undefined || now - Date.parse(previous) >= intervalSeconds * 1000;
}

export async function enqueueDueGoalPatrols(cwd: string, intervalSeconds: number): Promise<void> {
  const { goals, errors } = await new GoalStore(cwd).list();
  for (const failure of errors) log.error('Cannot read goal for patrol', { goalId: failure.goalId, error: failure.error.message });
  const pending = new Set(readManagerEvents(cwd).filter(({ event }) => event.kind === 'patrol').map(({ event }) => event.goalId));
  const now = Date.now();
  for (const goal of goals) {
    if (isGoalPatrolDue(goal, now, intervalSeconds) && !pending.has(goal.id)) {
      saveManagerEvent(cwd, { kind: 'patrol', goalId: goal.id });
    }
  }
}
