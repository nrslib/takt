import { join } from 'node:path';
import type { Goal } from '../../infra/goals/schema.js';
import type { ManagerEvent } from '../../infra/goals/events.js';
import type { TaskState } from '../../infra/task/types.js';

export function buildGoalTurnContext(cwd: string, goal: Goal, event: ManagerEvent, tasks: readonly TaskState[]): string {
  const observedAt = new Date().toISOString();
  const lastProgressAt = goal.workLog.filter((record) => record.kind !== 'patrol').at(-1)?.recordedAt ?? goal.createdAt;
  return JSON.stringify({
    repositoryDirectory: cwd,
    event,
    goal,
    tasks: tasks.filter((task) => task.goalId === goal.id),
    ...(event.kind === 'patrol' ? {
      patrol: {
        observedAt,
        lastProgressAt,
      },
    } : {}),
    references: { goal: join(cwd, '.takt', 'goals', goal.id, 'goal.json'), tasks: join(cwd, '.takt', 'tasks.yaml') },
  });
}
