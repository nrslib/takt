import { randomUUID } from 'node:crypto';
import { getSelfProcessIdentity } from './process.js';
import type { TasksFileData } from './schema.js';
import { TaskStore } from './store.js';

type DeletableTaskStatus = 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed';

/** Runs synchronously without the tasks.yaml lock. Throw to keep the record. */
export type TaskDeletionCleanup = () => void;

export class TaskDeletionService {
  constructor(private readonly store: TaskStore) {}

  deleteTaskByNameAndStatus(
    name: string,
    status: DeletableTaskStatus,
    cleanup?: TaskDeletionCleanup,
  ): void {
    if (cleanup === undefined) {
      this.store.update((current) => {
        this.assertTaskExists(current, name, status);
        return {
          tasks: current.tasks.filter((task) => !(task.name === name && task.status === status)),
        };
      });
      return;
    }

    this.deleteTaskWithCleanup(name, status, () => {
      cleanup();
      return true;
    });
  }

  deleteTaskWithCleanup(
    name: string,
    status: DeletableTaskStatus,
    cleanup: () => boolean,
  ): boolean {
    const deletionId = randomUUID();
    const processIdentity = getSelfProcessIdentity();
    this.store.update((current) => {
      this.assertTaskExists(current, name, status);
      if (current.tasks.some((task) => task.name === name && task.status === status && task.deletion)) {
        throw new Error(`Task deletion already in progress: ${name} (${status})`);
      }
      return {
        tasks: current.tasks.map((task) => task.name === name && task.status === status
          ? {
            ...task,
            deletion: {
              id: deletionId,
              owner_pid: process.pid,
              ...(processIdentity === undefined ? {} : { owner_start_time: processIdentity.startTime }),
            },
          }
          : task),
      };
    }, { deletionId });

    let cleanupSucceeded: boolean;
    try {
      cleanupSucceeded = cleanup();
    } catch (cleanupError) {
      try {
        this.clearDeletionReservation(name, status, deletionId);
      } catch (releaseError) {
        throw new AggregateError(
          [cleanupError, releaseError],
          `Task cleanup failed and its deletion reservation could not be cleared: ${name}`,
        );
      }
      throw cleanupError;
    }

    if (!cleanupSucceeded) {
      this.clearDeletionReservation(name, status, deletionId);
      return false;
    }

    this.store.update((current) => {
      const exists = current.tasks.some((task) => (
        task.name === name && task.status === status && task.deletion?.id === deletionId
      ));
      if (!exists) {
        throw new Error(`Task deletion reservation not found: ${name} (${status})`);
      }
      return { tasks: current.tasks.filter((task) => task.deletion?.id !== deletionId) };
    }, { deletionId });
    return true;
  }

  private clearDeletionReservation(name: string, status: DeletableTaskStatus, deletionId: string): void {
    this.store.update((current) => ({
      tasks: current.tasks.map((task) => {
        if (task.name !== name || task.status !== status || task.deletion?.id !== deletionId) return task;
        const restored = { ...task };
        delete restored.deletion;
        return restored;
      }),
    }), { deletionId });
  }

  private assertTaskExists(
    current: TasksFileData,
    name: string,
    status: DeletableTaskStatus,
  ): void {
    const exists = current.tasks.some((task) => task.name === name && task.status === status);
    if (!exists) {
      throw new Error(`Task not found: ${name} (${status})`);
    }
  }
}
