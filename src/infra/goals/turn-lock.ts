import { join } from 'node:path';
import { GoalIdSchema } from './schema.js';
import { acquireProjectExecutionLock, getProjectExecutionOwner, ProjectExecutionAlreadyRunningError } from '../task/project-execution-lock.js';
import type { ProjectExecutionLock } from '../task/project-execution-lock.js';

export const GOAL_TURN_OWNERS_ENV = 'TAKT_MANAGER_GOAL_OWNERS';
export type GoalTurnOwners = Record<string, string>;

function turnRoot(cwd: string, id: string): string {
  return join(cwd, '.takt', 'goals', GoalIdSchema.parse(id));
}

export async function tryWithGoalTurn(
  cwd: string, id: string, action: (owners: GoalTurnOwners) => Promise<void>,
): Promise<void> {
  let lock: ProjectExecutionLock;
  try {
    lock = acquireProjectExecutionLock(turnRoot(cwd, id), 'run');
  } catch (error) {
    if (error instanceof ProjectExecutionAlreadyRunningError) return;
    throw error;
  }
  try {
    await action({ [id]: lock.owner.ownerId });
  } finally {
    lock.release();
  }
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
      while (true) {
        signal?.throwIfAborted();
        try {
          const lock = acquireProjectExecutionLock(root, 'run');
          locks.push(lock);
          owners[id] = lock.owner.ownerId;
          break;
        } catch (error) {
          if (!(error instanceof ProjectExecutionAlreadyRunningError)) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      }
    }
    return await action(owners);
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}
