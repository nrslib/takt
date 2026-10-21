import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isRecordedProcessAlive, withFileLock } from '../fs/file-lock.js';
import { TasksFileSchema, serializeTasksFileData, type TasksFileData } from './schema.js';
import { normalizePersistedTasksFile } from './taskConfigSerialization.js';
import { createLogger } from '../../shared/utils/index.js';
import {
  ensurePrivateDirectory,
  readPrivateFileState,
  writePrivateFileWithMode,
} from '../../shared/utils/private-file.js';

const log = createLogger('task-store');

export class TaskStore {
  private readonly tasksFile: string;
  private readonly lockFile: string;
  private readonly taktDir: string;
  private locked = false;

  constructor(private readonly projectDir: string) {
    this.taktDir = path.join(projectDir, '.takt');
    this.tasksFile = path.join(this.taktDir, 'tasks.yaml');
    this.lockFile = `${this.tasksFile}.lock`;
  }

  getTasksFilePath(): string {
    return this.tasksFile;
  }

  ensureDirs(): void {
    ensurePrivateDirectory(this.taktDir);
  }

  read(): TasksFileData {
    return this.withLock(() => this.readUnsafe());
  }

  update(
    mutator: (current: TasksFileData) => TasksFileData,
    options?: { deletionId?: string },
  ): TasksFileData {
    return this.withLock(() => {
      const current = this.clearStaleDeletions(this.readUnsafe());
      const updated = TasksFileSchema.parse(mutator(current));
      this.assertDeletionsUnchanged(current, updated, options?.deletionId);
      this.writeUnsafe(updated);
      return updated;
    });
  }

  private clearStaleDeletions(state: TasksFileData): TasksFileData {
    let changed = false;
    const tasks = state.tasks.map((task) => {
      const deletion = task.deletion;
      if (!deletion || isRecordedProcessAlive(
        deletion.owner_pid,
        deletion.owner_start_time === undefined ? undefined : { startTime: deletion.owner_start_time },
      )) {
        return task;
      }

      changed = true;
      const restored = { ...task };
      delete restored.deletion;
      return restored;
    });
    return changed ? { tasks } : state;
  }

  private assertDeletionsUnchanged(
    current: TasksFileData,
    updated: TasksFileData,
    deletionId: string | undefined,
  ): void {
    const deletionIds = new Set(current.tasks
      .map((task) => task.deletion?.id)
      .filter((id): id is string => id !== undefined && id !== deletionId));

    for (const id of deletionIds) {
      const currentTasks = current.tasks.filter((task) => task.deletion?.id === id);
      const updatedTasks = updated.tasks.filter((task) => task.deletion?.id === id);
      if (!isDeepStrictEqual(currentTasks, updatedTasks)) {
        throw new Error('Cannot update a task while its deletion is in progress.');
      }
    }
  }

  private readUnsafe(): TasksFileData {
    this.ensureDirs();

    const snapshot = readPrivateFileState(this.tasksFile);
    if (!snapshot.state.exists || !('content' in snapshot)) {
      return { tasks: [] };
    }

    const raw = snapshot.content.toString('utf-8');

    try {
      const parsed = parseYaml(raw) as unknown;
      return TasksFileSchema.parse(normalizePersistedTasksFile(parsed));
    } catch (err) {
      log.error('tasks.yaml is broken. Keeping file untouched.', { file: this.tasksFile, error: String(err) });
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid tasks.yaml: ${this.tasksFile}. Please fix the file and retry. Cause: ${reason}`,
      );
    }
  }

  private writeUnsafe(state: TasksFileData): void {
    this.ensureDirs();
    const yaml = stringifyYaml(serializeTasksFileData(state));
    writePrivateFileWithMode(this.tasksFile, yaml, 0o600);
  }

  private withLock<T>(fn: () => T): T {
    if (this.locked) {
      throw new Error('TaskStore: reentrant lock detected');
    }
    this.locked = true;
    try {
      this.ensureDirs();
      return withFileLock(this.lockFile, fn);
    } finally {
      this.locked = false;
    }
  }
}
