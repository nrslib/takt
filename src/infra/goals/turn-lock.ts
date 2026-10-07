import { join } from 'node:path';
import { GoalIdSchema } from './schema.js';
import { acquireExecutionLock, getProjectExecutionOwner, ProjectExecutionAlreadyRunningError } from '../task/project-execution-lock.js';
import type { ProjectExecutionLock } from '../task/project-execution-lock.js';

export const GOAL_TURN_OWNERS_ENV = 'TAKT_MANAGER_GOAL_OWNERS';
export type GoalTurnOwners = Record<string, string>;

function turnRoot(cwd: string, id: string): string {
  return join(cwd, '.takt', 'goals', GoalIdSchema.parse(id));
}

export async function withGoalTurns<T>(
  cwd: string, ids: readonly string[], action: (owners: GoalTurnOwners) => Promise<T>,
  delegated: GoalTurnOwners = {}, signal?: AbortSignal,
): Promise<T> {
  const locks: ProjectExecutionLock[] = [];
  const owners: GoalTurnOwners = Object.create(null) as GoalTurnOwners;
  try {
    for (const id of [...new Set(ids)].sort()) {
      const root = turnRoot(cwd, id);
      const current = getProjectExecutionOwner(root);
      if (current !== undefined && Object.hasOwn(delegated, id) && current.ownerId === delegated[id]) {
        owners[id] = current.ownerId;
        continue;
      }
      const deadline = Date.now() + 120_000;
      while (true) {
        signal?.throwIfAborted();
        try {
          const lock = acquireExecutionLock(root, 'run');
          locks.push(lock);
          owners[id] = lock.owner.ownerId;
          break;
        } catch (error) {
          if (!(error instanceof ProjectExecutionAlreadyRunningError)) throw error;
          if (Date.now() >= deadline) throw new Error(`Timed out waiting for goal turn: ${id}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      }
    }
    return await action(owners);
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}
