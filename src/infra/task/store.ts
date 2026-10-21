import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { withFileLock, type FileLockAcquisitionErrorHandler } from '../fs/file-lock.js';
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
    onAcquisitionError?: FileLockAcquisitionErrorHandler,
  ): TasksFileData {
    return this.withLock(() => {
      const current = this.readUnsafe();
      const updated = TasksFileSchema.parse(mutator(current));
      this.writeUnsafe(updated);
      return updated;
    }, onAcquisitionError);
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

  private withLock<T>(fn: () => T, onAcquisitionError?: FileLockAcquisitionErrorHandler): T {
    if (this.locked) {
      throw new Error('TaskStore: reentrant lock detected');
    }
    this.locked = true;
    try {
      this.ensureDirs();
      return withFileLock(this.lockFile, fn, { onAcquisitionError });
    } finally {
      this.locked = false;
    }
  }
}
