import { join } from 'node:path';
import type { Goal } from '../../infra/goals/schema.js';
import type { ManagerEvent } from '../../infra/goals/events.js';
import type { TaskState } from '../../infra/task/types.js';

export function buildGoalTurnContext(cwd: string, goal: Goal, event: ManagerEvent, tasks: readonly TaskState[]): string {
  return JSON.stringify({
    repositoryDirectory: cwd,
    event,
    goal,
    tasks: tasks.filter((task) => task.goalId === goal.id),
    references: { goal: join(cwd, '.takt', 'goals', goal.id, 'goal.json'), tasks: join(cwd, '.takt', 'tasks.yaml') },
  });
}
